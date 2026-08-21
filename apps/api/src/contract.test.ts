import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { AppModule } from './app.module.js';
import { AgentService } from './agent/agent.service.js';
import { DbService } from './db/db.service.js';
import { API_PREFIX, type AppConfig } from './config.js';
import { APP_CONFIG } from './config.module.js';

/**
 * Does the API actually serve what the contract describes?
 *
 * ADR-0001 makes `packages/contracts/openapi/depsis.yaml` the single source and generates the web
 * client from it. An endpoint the API serves but the spec does not describe is therefore invisible
 * to every generated client — and, worse, it is a second description of the system that nobody is
 * checking. That is the "two realities" this project forbids everywhere else, and until this file
 * existed it was happening: three endpoints had been built and never written down, and the second
 * factor had been given a different path in each place.
 *
 * Two different findings, treated differently on purpose:
 *
 *   * A route with no spec entry FAILS. It is drift that already happened.
 *   * A spec path with no route is REPORTED, not failed. The spec deliberately describes more than
 *     Phase 1 has built, and turning that into a failure would mean deleting the plan to make the
 *     tests pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '../../../packages/contracts/openapi/depsis.yaml');

interface OpenApiDocument {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
}

interface Route {
  method: string;
  path: string;
}

/**
 * Ask Express what it is actually serving.
 *
 * Reading the router rather than the decorators is the point: a decorator says what someone meant,
 * and the router says what a request will reach. They diverge when a controller prefix changes, or
 * a module is not imported, or a route is registered twice.
 */
function routesOf(app: unknown): Route[] {
  const adapter = (
    app as { getHttpAdapter: () => { getInstance: () => unknown } }
  ).getHttpAdapter();
  const express = adapter.getInstance() as {
    router?: { stack?: unknown[] };
    _router?: { stack?: unknown[] };
  };
  // Express 5 exposes `router`; Express 4 used `_router`. Both are checked rather than assumed,
  // because the failure mode of guessing wrong is an empty list — a test that passes by finding
  // nothing to compare.
  const stack = express.router?.stack ?? express._router?.stack ?? [];
  expect(stack.length, 'the router stack must not be empty').toBeGreaterThan(0);

  const routes: Route[] = [];
  for (const entry of stack) {
    const layer = entry as { route?: { path?: unknown; methods?: Record<string, boolean> } };
    const path = layer.route?.path;
    if (typeof path !== 'string') continue;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      if (enabled) routes.push({ method: method.toUpperCase(), path });
    }
  }
  return routes;
}

/** `/files/:id` in Express is `/files/{id}` in OpenAPI. */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

describe('the API and its contract describe the same system', () => {
  it('compares what is served against what is described, in both directions', async () => {
    // A stub, because this test is about routing rather than behaviour and a real pool would make
    // it need a database to answer a question the database has no part in.
    const stubDb = {
      onModuleInit: () => Promise.resolve(),
      onModuleDestroy: () => Promise.resolve(),
      withTenant: () => Promise.resolve([]),
      withoutTenant: () => Promise.resolve([{ done: true }]),
    };

    // Likewise the agent: left as itself it would try to open a Unix socket while this test
    // compares route tables.
    const stubAgent = {
      onModuleInit: () => Promise.resolve(),
      isAvailable: () => false,
    };

    // One override for the whole environment. Every module's factory injects APP_CONFIG rather
    // than reading process.env itself, so this test does not have to stub a service it has no
    // interest in merely to stop a factory demanding a database URL it never uses.
    const stubConfig: AppConfig = {
      databaseUrl: 'postgresql://unused@127.0.0.1:5432/unused',
      port: 3000,
      nodeEnv: 'test',
      agentSocket: null,
      secretKeyFile: null,
      zfsPools: [],
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(stubConfig)
      .overrideProvider(DbService)
      .useValue(stubDb)
      .overrideProvider(AgentService)
      .useValue(stubAgent)
      .compile();

    const app = moduleRef.createNestApplication();
    // The same prefix production sets. Without it this test compared unprefixed router paths to
    // unprefixed spec paths and passed while the running API served everything one level up from
    // where the generated client looks — the drift check missing the drift.
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    try {
      const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;
      const specPaths = new Set(Object.keys(spec.paths ?? {}));
      expect(specPaths.size, 'the spec must describe some paths').toBeGreaterThan(0);

      // The prefix is part of the contract too, and it lives in `servers` rather than in the paths.
      const declaredServer = spec.servers?.[0]?.url;
      expect(declaredServer, 'the spec must declare a server').toBeDefined();
      expect(`/${API_PREFIX}`, 'the API prefix must match the spec server').toBe(declaredServer);

      const prefix = `/${API_PREFIX}`;
      const served = routesOf(app).map((r) => ({
        ...r,
        openapi: toOpenApiPath(r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path),
      }));
      expect(served.length, 'the app must serve some routes').toBeGreaterThan(0);

      // Direction 1 — drift that already happened, and therefore a failure.
      const undocumented = served
        .filter((r) => !specPaths.has(r.openapi))
        .map((r) => `${r.method} ${r.openapi}`);
      expect(
        undocumented,
        'served but not described in openapi/depsis.yaml, so a generated client cannot call them',
      ).toEqual([]);

      // Direction 2 — the plan running ahead of the build, which is not a failure.
      //
      // The set of built paths is DERIVED from the router, not written down here. An earlier
      // version hard-coded it while claiming in a comment to derive it, which meant the list could
      // fall out of date without anything noticing — the same class of second-description problem
      // this whole file exists to catch, reproduced inside the catcher.
      const builtPaths = new Set(served.map((r) => r.openapi));
      const notYet = [...specPaths].filter((p) => !builtPaths.has(p)).sort();

      // The report is the point of this half: the gap between plan and build stays visible.
      console.info(
        `contract: ${builtPaths.size} path(s) built, ${notYet.length} described but not yet ` +
          `implemented — ${notYet.join(', ')}`,
      );
      expect(specPaths.size).toBeGreaterThanOrEqual(builtPaths.size);
    } finally {
      await app.close();
    }
    // An explicit timeout, because this test boots the whole application. Measured on a cold module
    // cache it spent 18s in imports alone and blew the 5s default; the next run took 317ms. A drift
    // check that fails on a slow runner teaches people to ignore it.
  }, 30_000);
});
