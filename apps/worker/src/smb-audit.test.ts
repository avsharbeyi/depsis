import { describe, expect, it } from 'vitest';

import { isIndexable, parseAuditLine } from './smb-audit.js';

/**
 * The audit line parser.
 *
 * Pure, so it is a unit test — and worth having as one, because every trap ADR-0011 names about
 * this format lives here: `renameat` carries both names, the prefix separator is the same
 * character Samba uses between its own fields, and the path is share-relative.
 */

/** A line as rsyslog writes it: a timestamp, a host, a tag, then Samba's fields. */
const line = (fields: string): string => `2026-08-24T09:15:02.114Z depsis smbd_audit: ${fields}`;

describe('a Samba full_audit line', () => {
  it('names the directory holding the file, not the file', () => {
    // The queue is per DIRECTORY: reconciliation compares a directory at a time, so fifty changes
    // in one folder collapse to one entry.
    expect(parseAuditLine(line('ayse|10.0.0.5|belgeler|close|ok|docs/rapor.pdf'))).toEqual([
      { share: 'belgeler', directory: 'docs', actor: 'ayse', client: '10.0.0.5' },
    ]);
  });

  it('reads a top-level file as the share root', () => {
    expect(parseAuditLine(line('ayse|10.0.0.5|belgeler|close|ok|rapor.pdf'))).toEqual([
      { share: 'belgeler', directory: '', actor: 'ayse', client: '10.0.0.5' },
    ]);
  });

  it('reports BOTH ends of a rename', () => {
    // ADR-0011: `renameat` puts both names in the FILE field. Treating it as a delete plus a create
    // would be two events for one operation; treating it as one event for one directory would
    // leave the other directory stale until the fifteen-minute walk.
    expect(
      parseAuditLine(line('ayse|10.0.0.5|belgeler|renameat|ok|eski/a.txt|yeni/a.txt')),
    ).toEqual([
      { share: 'belgeler', directory: 'eski', actor: 'ayse', client: '10.0.0.5' },
      { share: 'belgeler', directory: 'yeni', actor: 'ayse', client: '10.0.0.5' },
    ]);
  });

  it('collapses a rename inside one directory to a single entry', () => {
    expect(
      parseAuditLine(line('ayse|10.0.0.5|belgeler|renameat|ok|docs/a.txt|docs/b.txt')),
    ).toEqual([{ share: 'belgeler', directory: 'docs', actor: 'ayse', client: '10.0.0.5' }]);
  });

  it('ignores an operation that changed nothing', () => {
    // `full_audit:failure = none` should mean this never arrives, but the parser does not rely on
    // a configuration it cannot see: a refused operation changed nothing, and indexing it is work
    // with no result. A share somebody is probing would otherwise generate one entry per attempt.
    expect(parseAuditLine(line('ayse|10.0.0.5|belgeler|unlinkat|fail|docs/a.txt'))).toEqual([]);
  });

  it('ignores an operation it does not handle', () => {
    expect(parseAuditLine(line('ayse|10.0.0.5|belgeler|getattr|ok|docs/a.txt'))).toEqual([]);
  });

  it('handles every operation the agent actually audits', () => {
    // The set here must stay a subset of `full_audit:success` in the generated smb.conf. An
    // operation audited and not handled is a wasted line; one handled and not audited never
    // arrives — and both are invisible without a test that lists them.
    for (const operation of [
      'create_file',
      'renameat',
      'unlinkat',
      'mkdirat',
      'close',
      'ftruncate',
      'linkat',
      'symlinkat',
    ]) {
      expect(
        parseAuditLine(line(`ayse|10.0.0.5|belgeler|${operation}|ok|docs/a.txt`)),
        operation,
      ).toHaveLength(1);
    }
  });

  it('finds Samba’s fields whatever syslog put in front', () => {
    // The prefix depends on the rsyslog template, which is the operator's. Anchoring on a
    // timestamp format would make this parser break on a box configured differently.
    const rfc3164 = 'Aug 24 09:15:02 depsis smbd_audit: ayse|10.0.0.5|belgeler|close|ok|a.txt';
    expect(parseAuditLine(rfc3164)).toHaveLength(1);
    expect(parseAuditLine('smbd_audit: ayse|10.0.0.5|belgeler|close|ok|a.txt')).toHaveLength(1);
  });

  it('ignores anything that is not one of these lines', () => {
    // The stream is a log file. A malformed line must produce no query at all rather than a
    // half-parsed one.
    for (const junk of [
      '',
      'a totally unrelated log line',
      'smbd_audit: too|few|fields',
      'smbd_audit: ayse|10.0.0.5||close|ok|a.txt', // no share name
      'smbd_audit: ayse|10.0.0.5|belgeler|close|ok|', // no filename
    ]) {
      expect(parseAuditLine(junk), junk).toEqual([]);
    }
  });

  it('strips a leading ./ rather than producing a component nothing matches', () => {
    expect(parseAuditLine(line('ayse|10.0.0.5|belgeler|close|ok|./docs/a.txt'))).toEqual([
      { share: 'belgeler', directory: 'docs', actor: 'ayse', client: '10.0.0.5' },
    ]);
  });

  it('reports an unnamed actor as absent rather than as an empty string', () => {
    const [event] = parseAuditLine(line('||belgeler|close|ok|a.txt'));
    expect(event?.actor).toBeNull();
    expect(event?.client).toBeNull();
  });
});

describe('what is worth indexing', () => {
  it('refuses the agent’s own tree', () => {
    // Samba vetoes `.depsis/`, so a client cannot reach it — but the AGENT writes there constantly,
    // and a configuration that ever exposed it would enqueue a directory DEPSIS deliberately does
    // not index, once per upload chunk.
    expect(
      isIndexable({ share: 'b', directory: '.depsis/staging', actor: null, client: null }),
    ).toBe(false);
    expect(isIndexable({ share: 'b', directory: '.depsis', actor: null, client: null })).toBe(
      false,
    );
    expect(isIndexable({ share: 'b', directory: 'docs', actor: null, client: null })).toBe(true);
    // Not a prefix match on the string: a real folder called `.depsisler` is somebody's folder.
    expect(isIndexable({ share: 'b', directory: '.depsisler', actor: null, client: null })).toBe(
      true,
    );
  });
});
