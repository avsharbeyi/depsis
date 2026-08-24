/**
 * Samba's `full_audit` stream, turned into "re-read this directory".
 *
 * ADR-0011 Layer 1. Samba knows the moment a client changes something — in its own process, with
 * the SMB username and the client address attached, at zero kernel privilege and with no ZFS
 * dependency. The alternative the ADR rejects is fanotify: `CAP_SYS_ADMIN` plus
 * `CAP_DAC_READ_SEARCH` to recover, two abstraction layers down, information Samba is already
 * holding out.
 *
 * WHAT IS PARSED. `full_audit:prefix = %u|%I|%S` puts three fields in front of Samba's own three,
 * so a line reads:
 *
 *     <anything syslog prepended>smbd_audit: user|10.0.0.5|belgeler|close|ok|docs/rapor.pdf
 *
 * Everything before `smbd_audit: ` belongs to syslog and differs by configuration; the parser
 * finds that marker rather than assuming a timestamp format.
 */

/** One directory a client changed. */
export interface AuditEvent {
  share: string;
  /** Share-relative, '/'-joined. Empty string is the share root. */
  directory: string;
  actor: string | null;
  client: string | null;
}

/**
 * The operations worth reacting to.
 *
 * `close` is the content-changed trigger and the reason the list is short: `write`/`pwrite`/`open`
 * fire per syscall and would drown the box, while `close` is one event per file, after the data is
 * written.
 *
 * `create_file` is here as a PLACEHOLDER, not as a completion signal — a client whose transfer is
 * interrupted still emits it. Reacting to it means the directory is re-read once too often, which
 * costs one listing; ignoring it would mean a file that was created and never closed cleanly stays
 * invisible until the fifteen-minute walk.
 *
 * The set must stay a subset of what the agent puts in `full_audit:success`. An operation audited
 * and not handled is a wasted line; an operation handled and not audited never arrives.
 */
const INTERESTING = new Set([
  'create_file',
  'renameat',
  'unlinkat',
  'mkdirat',
  'close',
  'ftruncate',
  'linkat',
  'symlinkat',
]);

/** Samba writes this before its own fields, whatever syslog put in front. */
const MARKER = 'smbd_audit: ';

/**
 * Turn one log line into the directories that need re-reading.
 *
 * Returns an ARRAY because `renameat` names both ends, and they can be in different directories —
 * a file moved from `a/` to `b/` changes both. ADR-0011 says to treat it as a move rather than a
 * delete plus a create, and for reconciliation purposes that is exactly what "re-read both
 * directories" means.
 *
 * Returns nothing for a line this reader does not understand, and that is deliberate: the stream
 * is a log file that anything on the box could in principle write to, so a malformed line is
 * ignored rather than being allowed to produce a query.
 */
export function parseAuditLine(line: string): AuditEvent[] {
  const at = line.indexOf(MARKER);
  if (at < 0) return [];

  const fields = line.slice(at + MARKER.length).split('|');
  // user, client, share, operation, result, and at least one filename.
  if (fields.length < 6) return [];

  const [actor, client, share, operation, result, ...rest] = fields;
  if (share === undefined || share === '' || operation === undefined) return [];
  // `full_audit:failure = none` means a failure should never reach here, but a caller cannot rely
  // on a remote configuration: a refused operation changed nothing and indexing it is work with no
  // result.
  if (result !== 'ok') return [];
  if (!INTERESTING.has(operation)) return [];

  // `renameat` puts both names in the FILE field, separated by `|` — which is also the prefix
  // separator, so they arrive as separate elements. Every other operation has exactly one.
  const files = rest.filter((name) => name !== '');
  if (files.length === 0) return [];

  const directories = new Set(files.map(parentOf));
  return [...directories].map((directory) => ({
    share,
    directory,
    actor: actor === undefined || actor === '' ? null : actor,
    client: client === undefined || client === '' ? null : client,
  }));
}

/**
 * The directory holding `file`, share-relative.
 *
 * Samba reports a SHARE-RELATIVE path — `docs/rapor.pdf`, not `/srv/depsis/belgeler/docs/...` —
 * which is why nothing here strips a prefix. A file at the top level yields the empty string,
 * meaning the share root.
 *
 * `.` and `..` cannot appear: Samba resolves them before the VFS layer. A leading `./` can, and is
 * removed rather than being allowed to produce a component nothing will match.
 */
function parentOf(file: string): string {
  const clean = file.replace(/^\.\//, '').replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  return slash < 0 ? '' : clean.slice(0, slash);
}

/**
 * Should this event be acted on at all?
 *
 * `.depsis/staging` is the agent's own tree. Samba vetoes it so a client cannot reach it — but the
 * AGENT writes there constantly, and if a future configuration ever exposed it, every upload chunk
 * would enqueue a directory DEPSIS deliberately does not index.
 */
export function isIndexable(event: AuditEvent): boolean {
  return event.directory !== '.depsis' && !event.directory.startsWith('.depsis/');
}
