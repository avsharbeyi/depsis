import { Logger } from '@nestjs/common';
import { connect, type Socket } from 'node:net';
import { z } from 'zod';

/**
 * The API's half of the console socket protocol (ADR-0018).
 *
 * One connection per session, bidirectional, newline-delimited JSON — and the connection IS the
 * session: when it goes, the pty goes with it, so there is no liveness flag here that can disagree
 * with reality. The other half is `services/console/src/protocol.rs`, and that file is the
 * authority; everything below was written against it.
 *
 * Nothing in this module accepts a bare `string` where the console service accepts a typed value.
 * Geometry arrives as a [`TerminalSize`] that cannot hold a zero, identifiers as a [`ConsoleUuid`]
 * that cannot hold a path separator, and keystrokes as [`ConsoleData`] that has already been
 * through a strict base64 check. The console service validates all three again — it is a separate
 * process and this one can be wrong — but a value that fails here never reaches a shell at all.
 */

/** Geometry bounds: the contract's numbers, and `protocol.rs`'s, deliberately the same. */
export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;

/** `ConsoleInput.data`'s `maxLength` in the contract. */
export const MAX_INPUT_BASE64 = 8192;

/**
 * How long the console service has to answer `open` with `ready`.
 *
 * Shorter than the service's own 10 second handshake window, so a slow console produces one clear
 * 503 here rather than a request that hangs until the browser gives up.
 */
export const READY_TIMEOUT_MS = 5_000;

/**
 * Idle and lifetime limits, as reported to the UI.
 *
 * These are `DEFAULT_IDLE_TIMEOUT` and `DEFAULT_MAX_AGE` from `services/console/src/session.rs`,
 * copied. They are copied and not read, because the wire protocol has no field carrying them: the
 * service enforces its own configured values and never states them. A deployment that overrides
 * `DEPSIS_CONSOLE_IDLE_TIMEOUT_SECS` therefore makes these numbers cosmetically wrong — the
 * session still expires exactly when the service says, and the UI would show the default. Fixing
 * that properly means adding the two fields to `ready`, which is a protocol change.
 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60;
export const DEFAULT_MAX_AGE_SECONDS = 4 * 60 * 60;

/**
 * Largest buffer this client will hold while waiting for a newline.
 *
 * The service's own cap is 256 kB per line and its output chunks are 32 kB raw, so anything near
 * this is a service that has stopped framing its messages — at which point holding on to the bytes
 * is a memory-exhaustion primitive rather than a recovery strategy.
 */
const MAX_PENDING_BYTES = 1024 * 1024;

/** The console service could not be reached, or did not complete the handshake. A 503, not a 500. */
export class ConsoleUnavailableError extends Error {
  constructor(reason: string) {
    super(`the console service is not available: ${reason}`);
    this.name = 'ConsoleUnavailableError';
  }
}

/** The console service was reached, understood the request, and refused it. */
export class ConsoleRefusedError extends Error {
  constructor(readonly serviceReason: string) {
    super(`the console service refused: ${serviceReason}`);
    this.name = 'ConsoleRefusedError';
  }
}

/** A value did not have the shape its type promises. Always the caller's fault; never a 500. */
export class InvalidConsoleValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConsoleValueError';
  }
}

/**
 * A terminal size that is a terminal size.
 *
 * Branded rather than a `{cols, rows}` object, for the reason `protocol.rs` gives for its own
 * `TermSize`: `resize(rows, cols)` and `resize(cols, rows)` are both plausible-looking calls, and
 * a zero column count produces a terminal no curses program can draw in. The factory is the only
 * way to get one.
 */
declare const terminalSizeBrand: unique symbol;
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
  readonly [terminalSizeBrand]: true;
}

export function terminalSize(cols: number, rows: number): TerminalSize {
  if (!Number.isInteger(cols) || cols < MIN_COLS || cols > MAX_COLS) {
    throw new InvalidConsoleValueError(
      `cols must be a whole number between ${MIN_COLS} and ${MAX_COLS}`,
    );
  }
  if (!Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) {
    throw new InvalidConsoleValueError(
      `rows must be a whole number between ${MIN_ROWS} and ${MAX_ROWS}`,
    );
  }
  return { cols, rows } as TerminalSize;
}

/**
 * Keystrokes, still base64, checked before they go anywhere near a shell.
 *
 * Strict: the standard alphabet, mandatory padding, no whitespace and no line breaks. A lenient
 * decoder in front of a terminal turns a malformed message into *some* bytes reaching a shell, and
 * the right answer to "I could not read this" is not "here is my best guess at what you typed".
 * The decoding itself happens in the console service; this refuses what it would refuse, one
 * process earlier, where the request can still be answered with a 400.
 */
declare const consoleDataBrand: unique symbol;
export type ConsoleData = string & { readonly [consoleDataBrand]: true };

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function consoleData(raw: string): ConsoleData {
  if (raw.length > MAX_INPUT_BASE64) {
    throw new InvalidConsoleValueError(`data is longer than ${MAX_INPUT_BASE64} base64 characters`);
  }
  if (!BASE64.test(raw)) {
    throw new InvalidConsoleValueError('data is not strict base64');
  }
  return raw as ConsoleData;
}

/**
 * A UUID as a value rather than a string that happens to look like one.
 *
 * The console service only ever logs and echoes these, and this side only ever puts them in a JSON
 * field — but "never joined to a path" is a property of today's code, and a type that cannot carry
 * a `/` or a `..` is the cheapest way to keep it true tomorrow.
 */
declare const consoleUuidBrand: unique symbol;
export type ConsoleUuid = string & { readonly [consoleUuidBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function consoleUuid(raw: string, field: string): ConsoleUuid {
  if (!UUID.test(raw)) {
    throw new InvalidConsoleValueError(`${field} is not a uuid`);
  }
  return raw.toLowerCase() as ConsoleUuid;
}

/** What one connection tells the API about, once it is live. */
export interface ConsoleHandlers {
  /** Terminal output, still base64. It is never decoded here: nothing on this side reads it. */
  output: (data: string) => void;
  /** One full line the operator typed. This is what `console_commands` records. */
  line: (line: string) => void;
  /** The shell ended. */
  exit: (code: number) => void;
  /**
   * Out-of-band trouble. On expiry the service sends the `console_sessions.close_reason`
   * vocabulary verbatim (`idle`, `max_age`) just ahead of `exit`, so this is also how a session
   * says WHY it is about to end.
   */
  error: (message: string) => void;
  /** The connection went away, whether or not `exit` arrived first. */
  closed: () => void;
}

const serverMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), pid: z.number().int(), privileged: z.boolean() }),
  z.object({ t: z.literal('out'), d: z.string() }),
  z.object({ t: z.literal('line'), s: z.string() }),
  z.object({ t: z.literal('exit'), code: z.number().int() }),
  z.object({ t: z.literal('error'), message: z.string() }),
]);

type ServerMessage = z.infer<typeof serverMessage>;

/** One live console session's socket. */
export class ConsoleConnection {
  private static readonly logger = new Logger(ConsoleConnection.name);

  /** Messages that arrived between `ready` and the caller attaching handlers. */
  private readonly queued: ServerMessage[] = [];
  private handlers: ConsoleHandlers | null = null;
  private pending = '';
  private gone = false;

  private constructor(
    private readonly socket: Socket,
    readonly pid: number,
    readonly privileged: boolean,
  ) {}

  /**
   * Connect, send `open`, and wait for `ready`.
   *
   * Every failure before `ready` is one of two things and the difference matters to whoever is
   * looking at the appliance: the console service is not there (`ConsoleUnavailableError`, a
   * switched-off feature) or it is there and said no (`ConsoleRefusedError` — too many sessions,
   * or a privileged shell asked for on a unit that does not provide one).
   */
  static open(
    socketPath: string,
    params: {
      session: ConsoleUuid;
      user: ConsoleUuid;
      size: TerminalSize;
      readyTimeoutMs?: number;
    },
  ): Promise<ConsoleConnection> {
    const budget = params.readyTimeoutMs ?? READY_TIMEOUT_MS;

    return new Promise<ConsoleConnection>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.setNoDelay(true);

      let settled = false;
      let buffered = '';

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          socket.destroy();
          reject(new ConsoleUnavailableError(`no ready message within ${budget}ms`));
        });
      }, budget);
      // Nothing else keeps this handle alive once the handshake is done, and a pending timer that
      // holds the event loop open turns a clean shutdown into a hang.
      timer.unref();

      const onHandshakeData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8');
        if (buffered.length > MAX_PENDING_BYTES) {
          finish(() => {
            socket.destroy();
            reject(new ConsoleUnavailableError('the handshake answer had no end'));
          });
          return;
        }

        const at = buffered.indexOf('\n');
        if (at < 0) return;

        const first = buffered.slice(0, at);
        const rest = buffered.slice(at + 1);

        const parsed = serverMessage.safeParse(safeJson(first));
        if (!parsed.success) {
          finish(() => {
            socket.destroy();
            reject(new ConsoleUnavailableError('the console service answered with nonsense'));
          });
          return;
        }

        const message = parsed.data;
        if (message.t === 'error') {
          finish(() => {
            socket.destroy();
            reject(new ConsoleRefusedError(message.message));
          });
          return;
        }
        if (message.t !== 'ready') {
          finish(() => {
            socket.destroy();
            reject(new ConsoleUnavailableError(`expected ready, got ${message.t}`));
          });
          return;
        }

        finish(() => {
          socket.off('data', onHandshakeData);
          socket.off('error', onHandshakeError);
          socket.off('close', onHandshakeClose);

          const connection = new ConsoleConnection(socket, message.pid, message.privileged);
          // Whatever was pipelined behind `ready` — a shell prints its prompt immediately — is fed
          // to the live parser rather than dropped with the handshake buffer.
          connection.attach(rest);
          resolve(connection);
        });
      };

      const onHandshakeError = (error: NodeJS.ErrnoException): void => {
        // ENOENT is no socket at that path, ECONNREFUSED is nothing listening on it. Both mean the
        // console service is not running here, which is a 503: an operator's "switched off" must
        // not look like the appliance's "broken".
        finish(() => {
          socket.destroy();
          reject(new ConsoleUnavailableError(error.code ?? error.message));
        });
      };

      const onHandshakeClose = (): void => {
        finish(() =>
          reject(new ConsoleUnavailableError('the connection closed during the handshake')),
        );
      };

      socket.on('data', onHandshakeData);
      socket.on('error', onHandshakeError);
      socket.on('close', onHandshakeClose);
      socket.on('connect', () => {
        socket.write(
          `${JSON.stringify({
            t: 'open',
            cols: params.size.cols,
            rows: params.size.rows,
            session: params.session,
            user: params.user,
            // Always false. Whether this box has a privileged console is decided by its unit file
            // (ADR-0018), never by a request — a root shell that can be asked for is a root shell
            // that will be asked for. `ready` reports what was actually given.
            privileged: false,
          })}\n`,
        );
      });
    });
  }

  /**
   * Start delivering messages.
   *
   * Anything that arrived first is delivered now, in order. Without the queue the shell's opening
   * prompt would be lost in the gap between `open` resolving and the caller wiring itself up.
   */
  listen(handlers: ConsoleHandlers): void {
    this.handlers = handlers;
    const backlog = this.queued.splice(0, this.queued.length);
    for (const message of backlog) this.dispatch(message);
    if (this.gone) handlers.closed();
  }

  input(data: ConsoleData): void {
    this.write({ t: 'in', d: data });
  }

  resize(size: TerminalSize): void {
    this.write({ t: 'resize', cols: size.cols, rows: size.rows });
  }

  /** Ask for a clean end. The service exits the shell and answers `exit`. */
  requestClose(): void {
    this.write({ t: 'close' });
  }

  /** Drop the connection, which ends the session on the other side. Safe to call twice. */
  destroy(): void {
    this.gone = true;
    this.socket.destroy();
  }

  private attach(leftover: string): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.pending += chunk.toString('utf8');
      this.drain();
    });
    this.socket.on('error', (error: Error) => {
      // Not fatal in itself: 'close' follows and that is where the session ends. Logged because a
      // console that dies for a reason nobody recorded is a console nobody can fix.
      ConsoleConnection.logger.debug(`console socket error: ${error.message}`);
    });
    this.socket.on('close', () => {
      this.gone = true;
      this.handlers?.closed();
    });
    if (leftover !== '') {
      this.pending += leftover;
      this.drain();
    }
  }

  private drain(): void {
    if (this.pending.length > MAX_PENDING_BYTES) {
      ConsoleConnection.logger.error('console service sent an unterminated line; dropping session');
      this.destroy();
      return;
    }
    for (;;) {
      const at = this.pending.indexOf('\n');
      if (at < 0) return;
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      if (line.trim() === '') continue;

      const parsed = serverMessage.safeParse(safeJson(line));
      if (!parsed.success) {
        // Dropped rather than fatal. A message this build does not know is a service one version
        // ahead, and killing a working shell over it would be the worse failure.
        ConsoleConnection.logger.warn('ignoring an unreadable message from the console service');
        continue;
      }
      if (this.handlers === null) {
        this.queued.push(parsed.data);
        continue;
      }
      this.dispatch(parsed.data);
    }
  }

  private dispatch(message: ServerMessage): void {
    const handlers = this.handlers;
    if (handlers === null) {
      this.queued.push(message);
      return;
    }
    switch (message.t) {
      case 'out':
        handlers.output(message.d);
        break;
      case 'line':
        handlers.line(message.s);
        break;
      case 'exit':
        handlers.exit(message.code);
        break;
      case 'error':
        handlers.error(message.message);
        break;
      case 'ready':
        // A second `ready` means this connection and the service disagree about what is going on.
        ConsoleConnection.logger.warn('a second ready arrived on a live console session');
        break;
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.gone) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * How long a connected probe waits to see whether the peer is really there.
 *
 * `depsis-console.socket`'s own comment block measured a third state: socket unit running, service
 * FAILING to start. The kernel queues the connection on systemd's listening socket, so `connect()`
 * succeeds and nothing is on the other end — the unit file's conclusion is that the API "must not
 * treat the connect succeeded as the console is up". `ConsoleConnection.open` obeys that with its
 * `ready` deadline; this probe used to resolve `true` on the `connect` event alone and so reported
 * `available: true` on `GET /console` while `POST /console` answered 503.
 *
 * Not a handshake — a probe that sent `open` would start a pty nobody asked for. Just long enough
 * for the immediate end-of-file that a socket with no service behind it produces, and short enough
 * to be invisible in `GET /console`.
 */
const PROBE_SETTLE_MS = 150;

/**
 * Is anything listening on the console socket, AND still there a moment later?
 *
 * Used only to answer `available` on `GET /console`, and only when there is no live session to
 * answer it already. It connects and hangs up without sending `open`, which the service reads as
 * end-of-file and ends without starting a pty — it does briefly occupy one of the service's eight
 * session slots, which is the price of an honest answer over a `stat` on a path that may be a
 * stale socket file nobody is accepting on.
 */
export function probeConsole(
  socketPath: string,
  timeoutMs = 1_000,
  settleMs = PROBE_SETTLE_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let grace: NodeJS.Timeout | null = null;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (grace !== null) clearTimeout(grace);
      socket.destroy();
      resolve(answer);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.on('connect', () => {
      // A connection that survives this long has a process behind it. One that does not — the
      // failing-service state above, or a service that hung up — falls through to `close`.
      grace = setTimeout(() => finish(true), settleMs);
      grace.unref();
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}
