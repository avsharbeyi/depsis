import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { API_BASE_URL, problemMessage } from './api.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '../../../packages/contracts/openapi/depsis.yaml');

describe('the client is aimed at the contract', () => {
  it('uses the base URL the OpenAPI document declares', () => {
    // The paths are type-checked against the generated types, but the SERVER prefix is a string in
    // two places. If the document ever moves to /api/v2 and this does not, every call 404s — loud,
    // but only once something calls it, which on a screen nobody has opened yet can be months.
    const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as { servers?: Array<{ url?: string }> };
    const declared = spec.servers?.[0]?.url;

    expect(declared, 'the spec must declare a server').toBeDefined();
    expect(API_BASE_URL).toBe(declared);
  });
});

describe('problemMessage', () => {
  it('prefers detail, then message, then title', () => {
    expect(problemMessage({ detail: 'd', message: 'm', title: 't' }, 'f')).toBe('d');
    expect(problemMessage({ message: 'm', title: 't' }, 'f')).toBe('m');
    expect(problemMessage({ title: 't' }, 'f')).toBe('t');
  });

  it('falls back rather than rendering an object', () => {
    // The failure this prevents is small and extremely visible: "[object Object]" in a form, which
    // tells a user nothing and looks broken.
    expect(problemMessage({}, 'fallback')).toBe('fallback');
    expect(problemMessage(null, 'fallback')).toBe('fallback');
    expect(problemMessage(undefined, 'fallback')).toBe('fallback');
    expect(problemMessage('a string, not a problem object', 'fallback')).toBe('fallback');
    expect(problemMessage({ detail: 42 }, 'fallback')).toBe('fallback');
    expect(problemMessage({ detail: '   ' }, 'fallback')).toBe('fallback');
  });
});
