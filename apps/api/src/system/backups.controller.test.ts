import { describe, expect, it } from 'vitest';

import { explain } from './backups.controller.js';

/**
 * What the agent's rationale is allowed to carry into an HTTP response.
 *
 * The reason a REFUSAL reaches the caller verbatim is that only the agent knows it and only the
 * caller can act on it. The reason a command FAILURE must not is that
 * `services/system-agent/src/mod.rs` formats `SeamError::Command` as
 * `command {program} failed with status {status}: {stderr}` — the absolute path of the privileged
 * binary and raw `zfs` stderr, which names the full dataset path. `dispatch.rs` turns every
 * execution error into `Response::Failed`, and `expectStatus` collapses `Failed` and `Refused` into
 * one `AgentRefusedError`, so this prefix is the only thing that tells them apart from the API
 * side. Losing the split is a one-character edit to the regex, hence these tests.
 */

const CID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('the agent reason a 409 body is allowed to repeat', () => {
  it('repeats a refusal, because only the operator can act on it', () => {
    expect(explain('the dataset is busy', CID)).toBe('the dataset is busy');
    expect(explain('pool is read-only', CID)).toBe('pool is read-only');
  });

  it('withholds the command, its absolute path and the raw stderr', () => {
    const leaked =
      'command /usr/sbin/zfs failed with status 1: cannot create snapshot ' +
      "'tank/shares/acme_private@nightly': dataset is busy";
    const answer = explain(leaked, CID);

    expect(answer).toBe('the snapshot command failed; see the system log for this request');
    // Asserted on the parts rather than only on the whole, so a future rewrite that returns a
    // different fixed sentence still fails if it starts interpolating any of these back in.
    expect(answer).not.toContain('/usr/sbin/zfs');
    expect(answer).not.toContain('tank/shares/acme_private');
    expect(answer).not.toContain('status 1');
  });

  it('withholds it however the exit status is written', () => {
    // A signal death is reported as a negative status by the agent's `ExitStatus::code` handling,
    // and a three-digit status is legal. Both are the same disclosure.
    expect(explain('command /sbin/zfs failed with status -9: killed', CID)).not.toContain('/sbin/');
    expect(explain('command /sbin/zfs failed with status 127: no such file', CID)).not.toContain(
      '/sbin/',
    );
  });

  it('withholds it even when the stderr is multi-line, which is how zfs actually writes', () => {
    // The collapse to one line happens before the match, so a real multi-line dump must not slip
    // past the prefix test by starting with a newline's worth of whitespace.
    const leaked =
      '  command /usr/sbin/zfs failed with status 1:\n  cannot open ' +
      "'tank/shares/acme': dataset does not exist\n";
    expect(explain(leaked, CID)).not.toContain('tank/shares/acme');
  });

  it('does not withhold a refusal that merely mentions a command', () => {
    // The guard is a prefix, not a keyword search. An agent-authored refusal is allowed to use the
    // word, and swallowing it would hide the one sentence the operator needs.
    const refusal = 'the snapshot command is disabled while a scrub is running';
    expect(explain(refusal, CID)).toBe(refusal);
  });

  it('still caps a long refusal at one line', () => {
    const long = `a${'b'.repeat(400)}`;
    const answer = explain(long, CID);
    expect(answer.length).toBe(200);
    expect(answer.endsWith('…')).toBe(true);
  });

  it('says so rather than answering with nothing when the agent gave no reason', () => {
    expect(explain('   \n  ', CID)).toBe('the system agent gave no reason');
  });
});
