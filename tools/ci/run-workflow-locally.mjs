#!/usr/bin/env node
/**
 * Run a CI job's shell steps on this machine, reading them from .github/workflows/ci.yml.
 *
 * Why this exists: for twenty-eight commits nothing in that file had ever executed. The workflow
 * parsed, and the scripts it calls had been run by hand, but the steps as the YAML defines them —
 * in order, with the environment it declares, on Linux — had not. Two failures were waiting there,
 * and both were found by transcribing the steps into a scratch script by hand. Transcription is
 * itself a way to be wrong, so this reads the workflow instead.
 *
 * It is NOT a GitHub Actions emulator. `uses:` steps are reported and skipped, because they are
 * someone else's code and half of them exist to install a toolchain this machine already has.
 * A green run here therefore means "the shell in this job works"; it does not mean the job passes
 * on GitHub. Nothing replaces the first real run.
 *
 *   node tools/ci/run-workflow-locally.mjs                # list the jobs
 *   node tools/ci/run-workflow-locally.mjs static         # run one job's run-steps
 *   node tools/ci/run-workflow-locally.mjs migrations --env PGHOST=127.0.0.1 --env ...
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));

const [jobName, ...rest] = process.argv.slice(2);
const extraEnv = Object.fromEntries(
  rest
    .filter((a, i, all) => all[i - 1] === '--env')
    .map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
);

if (!jobName) {
  console.log('jobs in .github/workflows/ci.yml:\n');
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    const runnable = (job.steps ?? []).filter((s) => typeof s.run === 'string').length;
    console.log(`  ${name.padEnd(14)} ${runnable} run-step(s)  — ${job.name ?? ''}`);
  }
  process.exit(0);
}

const job = workflow.jobs?.[jobName];
if (!job) {
  console.error(`no job named '${jobName}'`);
  process.exit(2);
}

// A job-level `if:` is NOT evaluated here, and staying quiet about that hid a real failure: the
// rust job carried `if: hashFiles(...)`, which GitHub rejects outright — hashFiles has no
// workspace to hash before checkout — and the whole workflow file was refused. Every local run
// had passed, because this runner walked straight past the condition. Printing it does not
// evaluate it; it just stops the omission from being invisible.
if (typeof job.if === 'string') {
  console.log(
    `NOTE: job '${jobName}' has a condition this runner does not evaluate:\n  if: ${job.if}\n`,
  );
  // The one class worth refusing outright, because it is a syntax error rather than a judgement
  // call: these functions need a checked-out workspace and are unavailable at job level.
  for (const unavailable of ['hashFiles(', 'steps.', 'job.', 'runner.']) {
    if (job.if.includes(unavailable)) {
      console.error(
        `ERROR: '${unavailable}' cannot be used in a job-level if — GitHub rejects the whole file.`,
      );
      process.exit(2);
    }
  }
}

// The workflow's `env:` block, plus whatever the caller supplied for things a real runner would
// provide (a service container's host and password, say).
const baseEnv = { ...process.env, ...(workflow.env ?? {}), ...(job.env ?? {}), ...extraEnv };

let failed = 0;
let skipped = 0;
let ran = 0;

for (const [index, step] of (job.steps ?? []).entries()) {
  const label = step.name ?? step.uses ?? `step ${index + 1}`;

  if (typeof step.run !== 'string') {
    console.log(`\n---- SKIP (action) ${label}`);
    skipped += 1;
    continue;
  }

  // A `${{ ... }}` expression inside a shell block would reach bash as literal text and mean
  // something different from what CI runs. Refusing is better than running a step that only
  // resembles the real one.
  if (step.run.includes('${{')) {
    console.log(`\n---- SKIP (needs GitHub expression interpolation) ${label}`);
    skipped += 1;
    continue;
  }

  console.log(`\n==== RUN  ${label}`);
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step.run], {
    cwd: root,
    env: { ...baseEnv, ...(step.env ?? {}) },
    stdio: 'inherit',
  });
  ran += 1;
  if (result.status === 0) {
    console.log(`---- PASS ${label}`);
  } else {
    console.log(`---- FAIL ${label} (exit ${result.status})`);
    failed += 1;
  }
}

console.log(
  `\n===== job '${jobName}': ${ran} run-step(s), ${failed} failed, ${skipped} skipped (actions) =====`,
);
process.exit(failed === 0 ? 0 : 1);
