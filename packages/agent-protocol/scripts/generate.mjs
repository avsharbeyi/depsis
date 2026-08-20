/**
 * Turn the agent's emitted JSON Schema into TypeScript.
 *
 * ADR-0006: the Rust agent OWNS this contract and emits it with schemars, because the side that
 * enforces a trust boundary must be the side that defines it. The TypeScript here is downstream and
 * is never hand-edited — the unprivileged API does not get to decide what the privileged agent
 * accepts.
 *
 * `schema/agent.schema.json` is the binary's `--emit-schema` output, committed verbatim so CI can
 * diff it against a fresh emit. This script only converts it.
 *
 * The emitted document holds TWO schemas under `request` and `response`, which is not itself a
 * valid JSON Schema, so each half is converted separately rather than pretending the wrapper is a
 * schema.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(here, '../schema/agent.schema.json');
const OUT = resolve(here, '../src/generated/agent.d.ts');

const banner = `/**
 * GENERATED FROM schema/agent.schema.json — DO NOT EDIT.
 *
 * The schema is emitted by \`depsis-agent --emit-schema\`; the Rust crate owns it (ADR-0006).
 * Regenerate with \`pnpm --filter @depsis/agent-protocol generate\`.
 */
`;

const options = {
  bannerComment: '',
  additionalProperties: false,
  style: { singleQuote: true, printWidth: 100 },
};

const document = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const parts = [];
for (const [half, name] of [
  ['request', 'AgentRequest'],
  ['response', 'AgentResponse'],
]) {
  // The title is overridden rather than left to the schema. schemars titles these `Request` and
  // `Response`, which are also the names of two DOM globals and of Express's own types — an
  // exported `Request` from this package would shadow one of them in whichever file imported it,
  // and the resulting error would point at the wrong place entirely.
  const schema = { ...document[half], title: name };
  parts.push(await compile(schema, name, options));
}

const generated = banner + parts.join('\n');

if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== generated) {
    console.error(
      'src/generated/agent.d.ts is out of date with schema/agent.schema.json.\n' +
        'Run: pnpm --filter @depsis/agent-protocol generate',
    );
    process.exit(1);
  }
  console.log('agent.d.ts is in step with the schema');
} else {
  writeFileSync(OUT, generated, 'utf8');
  console.log(`wrote ${OUT}`);
}
