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
 * THE COMPARISON IS METHOD+PATH, not path. An earlier version compared bare paths, which let a
 * route written with the wrong verb pass: `PUT /files/{id}` where the document says `PATCH` is a
 * route no generated client will ever call, and the path-level check saw `/files/{id}` on both
 * sides and reported agreement. The pair is the unit a client actually binds to, so it is the unit
 * compared here.
 *
 * Both directions FAIL, and each has a different meaning:
 *
 *   * Served but not described — drift that already happened. Nothing can call it.
 *   * Described but not served — a client generated today has a method for an operation that
 *     answers 404. This half used to be reported to the console instead of failed, on the grounds
 *     that the document deliberately ran ahead of the build. It no longer does: the operations the
 *     build has not caught up with are enumerated in `DESCRIBED_BUT_NOT_SERVED` below with a reason
 *     each, so "not built yet" is a decision somebody wrote down rather than a number that drifts
 *     upward unnoticed.
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
 * The keys of a path item that describe an operation.
 *
 * A path item also holds `parameters`, `summary`, `description`, `servers` and `$ref`, none of
 * which is something a client can call. Listing the verbs rather than excluding the others is what
 * keeps a future OpenAPI keyword from being mistaken for an eighth method.
 */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;

/**
 * Operations the document describes on purpose and the API does not serve.
 *
 * Every entry needs a reason, and the reason has to be a decision rather than an oversight —
 * "nobody got to it" belongs in a task, not here, because an entry in this list stops the check
 * from ever mentioning it again.
 */
const DESCRIBED_BUT_NOT_SERVED: ReadonlyMap<string, string> = new Map([
  [
    'POST /file-operations',
    // Copy of a whole subtree, in one request. Move is no longer the gap — `MoveEntry` exists in
    // the agent protocol and `PATCH /files/{id}` serves the single-entry case — but copy still has
    // no typed operation behind it, and §2.2 keeps the privileged agent's surface closed, so this
    // endpoint cannot exist before one is added. Described so the shape is settled first.
    'subtree copy; the privileged agent has no matching typed operation yet',
  ],

  // ─── §6.2: folder permissions ─────────────────────────────────────────────
  //
  // Nothing is left here. The team endpoints went first, and the four permission ones followed
  // once the grant walk, the dry-run and the queued POSIX re-application existed — which was the
  // condition this section stated: the write is served only where a row and the kernel can be made
  // to say the same thing. They do not say it at the same INSTANT, and the contract is explicit
  // about that: `PermissionWriteResult.applyingJobId` names the job that rewrites the ACLs, and is
  // null when the agent is unreachable, so the gap is reported rather than hidden.
]);

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
      agentDataSocket: null,
      secretKeyFile: null,
      zfsPools: [],
      smartDisks: [],
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

      // What the document describes, as the method+path pairs a generated client binds to.
      const described = new Set<string>();
      for (const [path, item] of Object.entries(spec.paths ?? {})) {
        for (const method of HTTP_METHODS) {
          if (item[method] !== undefined) described.add(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(described.size, 'the spec must describe some operations').toBeGreaterThan(0);

      const prefix = `/${API_PREFIX}`;
      // HEAD is NOT filtered out here, and an early version of this check did filter it: Express
      // only lists `head` in a route's methods when a handler was registered for it explicitly, so
      // dropping the verb hid the one place the product uses it — tus resumption, `HEAD
      // /uploads/{uploadId}`, which the document describes and the API serves. What Express answers
      // implicitly (HEAD from a GET handler, OPTIONS from the router) never reaches this list.
      const served = new Set(
        routesOf(app).map(
          (r) =>
            `${r.method} ${toOpenApiPath(
              r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path,
            )}`,
        ),
      );
      expect(served.size, 'the app must serve some routes').toBeGreaterThan(0);

      // Direction 1 — drift that already happened. Nothing generated can call these.
      const undocumented = [...served].filter((r) => !described.has(r)).sort();
      expect(
        undocumented,
        'served but not described in openapi/depsis.yaml, so a generated client cannot call them',
      ).toEqual([]);

      // Direction 2 — a client that has a method for an operation the API answers 404 for.
      //
      // The two sides are DERIVED, from the router and from the document; only the exception list
      // is written down. An earlier version of this file hard-coded the built set while claiming in
      // a comment to derive it, which is the same second-description problem the file exists to
      // catch, reproduced inside the catcher.
      const missing = [...described].filter((r) => !served.has(r)).sort();
      expect(
        missing,
        'described in openapi/depsis.yaml but not served; add the route, or add it to ' +
          'DESCRIBED_BUT_NOT_SERVED with the reason it is deliberate',
      ).toEqual([...DESCRIBED_BUT_NOT_SERVED.keys()].sort());

      // A stale exception is drift too, in the direction nothing else looks: an entry left behind
      // after the route was finally built would silently exempt it from direction 2 forever.
      const stale = [...DESCRIBED_BUT_NOT_SERVED.keys()].filter((r) => served.has(r));
      expect(stale, 'these are served now, so remove them from DESCRIBED_BUT_NOT_SERVED').toEqual(
        [],
      );
    } finally {
      await app.close();
    }
    // An explicit timeout, because this test boots the whole application. Measured on a cold module
    // cache it spent 18s in imports alone and blew the 5s default; the next run took 317ms. A drift
    // check that fails on a slow runner teaches people to ignore it.
  }, 30_000);
});
