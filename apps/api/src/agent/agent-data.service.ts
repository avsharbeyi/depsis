import { Injectable, Logger } from '@nestjs/common';
import { createConnection, type Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

import { AgentUnavailableError } from './agent.service.js';

/**
 * The unprivileged half of the bulk data channel (ADR-0017).
 *
 * Separate from `AgentService`, and the separation is the point rather than tidiness. That class
 * serialises every call behind a promise chain because the agent's CONTROL loop serves one
 * connection at a time on purpose. Putting uploads on that chain would mean a ten-gigabyte transfer
 * blocking every `pool_status` behind it — which is exactly the coupling the second socket exists
 * to break. The agent serves this socket from a fixed worker pool, so several uploads may be in
 * flight at once and this class does not queue.
 *
 * The token comes from an `open_transfer` control call. Nothing sent here names a path, so this
 * connection cannot reach anything the control call did not already confine.
 */
@Injectable()
export class AgentDataService {
  private readonly logger = new Logger(AgentDataService.name);

  /**
   * Matches `data::IDLE_BUDGET` in the agent, which re-arms it before every read.
   *
   * An IDLE budget, not a total one. A total deadline here would fail every legitimate large upload
   * — ten gigabytes over a slow link is not a fault — while an idle budget still bounds a peer that
   * has simply stopped talking.
   */
  static readonly IDLE_TIMEOUT_MS = 30_000;

  constructor(private readonly socketPath: string | null) {}

  isAvailable(): boolean {
    return this.socketPath !== null;
  }

  /**
   * Stream exactly `length` bytes into an already-opened transfer.
   *
   * `offset` is what the caller believes the staging file currently holds. The agent checks it
   * against the file itself and refuses a mismatch, so a stale offset is a refusal rather than a
   * duplicated region — do not treat it as advisory.
   *
   * Resolves with the number of bytes the agent stored. Throws `AgentOutOfSpaceError` when the
   * tenant's quota is exhausted, so the tus layer can answer 507 rather than 500; ADR-0008 requires
   * that distinction and the only alternative would be matching on a `strerror` string.
   */
  async send(token: string, offset: number, length: number, body: Readable): Promise<number> {
    const path = this.socketPath;
    if (path === null) {
      throw new AgentUnavailableError('DEPSIS_AGENT_DATA_SOCKET is not configured');
    }

    const socket = createConnection({ path });
    const reader = new LineReader(socket);
    try {
      await once(socket, 'connect');
      socket.setTimeout(AgentDataService.IDLE_TIMEOUT_MS);
      socket.on('timeout', () => {
        socket.destroy(new AgentUnavailableError('the agent went quiet mid-transfer'));
      });

      socket.write(`${JSON.stringify({ token, offset, length })}\n`);
      const ready = await reader.next();
      if (ready.status !== 'ready') throw toError(ready);

      // `end: false`, and here is what that is and is not worth.
      //
      // `pipeline` half-closes its destination when the source ends, and the reply we still have to
      // read arrives after the last byte. On AF_UNIX — the transport that ships — this makes NO
      // observable difference: a mutation run flipped it to `end: true` and every test still
      // passed, because a half-close only shuts the write direction and the answer comes back on
      // the read one. The comment here previously implied the tests covered it; they do not.
      //
      // It stays because the sibling channel measured a transport where it DOES matter. On Windows
      // named pipes, which is what `net` gives you when there is no AF_UNIX, a client that
      // half-closed lost the response entirely on 2 of 5 connections (see the note in
      // `agent.service.ts`). Keeping the write side open costs nothing on Linux and is the
      // difference between an answer and silence on a development machine.
      await pipeline(body, new ExactLength(length), socket, { end: false });

      const stored = await reader.next();
      if (stored.status !== 'stored') throw toError(stored);
      return stored.bytes;
    } catch (error) {
      // Destroying rather than ending. A source that died halfway has already sent fewer bytes than
      // it declared, and the agent is still waiting for the rest: EOF is what tells it the stream
      // is short so it can roll the staging file back to where it found it. Ending politely would
      // do the same, but only after flushing whatever partial write is queued — which is precisely
      // the data that must NOT arrive.
      socket.destroy();
      throw error;
    } finally {
      reader.dispose();
      socket.destroy();
    }
  }
}

/** The tenant's dataset is full. Distinct because ADR-0008 needs a 507, not a 500. */
export class AgentOutOfSpaceError extends Error {
  constructor(readonly agentReason: string) {
    super(`the share is out of space: ${agentReason}`);
    this.name = 'AgentOutOfSpaceError';
  }
}

/** The agent declined the transfer, or it did not complete. Nothing was stored. */
export class AgentTransferFailedError extends Error {
  constructor(
    readonly agentReason: string,
    readonly kind: string,
  ) {
    super(`the transfer failed (${kind}): ${agentReason}`);
    this.name = 'AgentTransferFailedError';
  }
}

interface ReadyReply {
  status: 'ready';
}
interface StoredReply {
  status: 'stored';
  bytes: number;
}
interface FailedReply {
  status: 'failed';
  reason: string;
  kind: 'out_of_space' | 'io' | 'refused';
}
type DataReply = ReadyReply | StoredReply | FailedReply;

function toError(reply: DataReply): Error {
  if (reply.status !== 'failed') {
    return new AgentUnavailableError(`unexpected reply '${reply.status}'`);
  }
  return reply.kind === 'out_of_space'
    ? new AgentOutOfSpaceError(reply.reason)
    : new AgentTransferFailedError(reply.reason, reply.kind);
}

/**
 * Refuse to send more than was declared.
 *
 * Without this, a caller whose `length` disagrees with its stream HANGS: the agent reads exactly
 * `length` bytes and then stops reading, so the surplus fills the socket buffer and the write never
 * drains. A hang is the worst available failure here because it holds one of the agent's sixteen
 * workers for the full idle budget, and the caller's own logs show nothing at all.
 *
 * A stream that is SHORT needs no guard: it ends, the agent sees EOF before `length` and rolls the
 * staging file back, which is the behaviour that exists precisely for a client that died.
 */
class ExactLength extends Transform {
  private seen = 0;

  constructor(private readonly declared: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error) => void,
  ): void {
    this.seen += chunk.length;
    if (this.seen > this.declared) {
      done(
        new AgentTransferFailedError(
          `the body is longer than the declared ${this.declared} bytes`,
          'refused',
        ),
      );
      return;
    }
    this.push(chunk);
    done();
  }
}

/**
 * Newline-delimited JSON off a socket, one line at a time.
 *
 * A class rather than a promise per reply because the two replies are read at different points in
 * the exchange, with a stream piped between them: a listener attached fresh for the second one
 * would miss a line that arrived while the body was still being written.
 */
class LineReader {
  private buffered = '';
  private readonly queued: DataReply[] = [];
  private waiting: ((reply: DataReply) => void) | null = null;
  private failure: Error | null = null;
  private failWaiting: ((error: Error) => void) | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered += chunk.toString('utf8');
    for (let at = this.buffered.indexOf('\n'); at >= 0; at = this.buffered.indexOf('\n')) {
      const line = this.buffered.slice(0, at);
      this.buffered = this.buffered.slice(at + 1);
      if (line.trim() === '') continue;
      let parsed: DataReply;
      try {
        parsed = JSON.parse(line) as DataReply;
      } catch {
        this.fail(new AgentUnavailableError(`unparseable reply: ${line.slice(0, 120)}`));
        return;
      }
      const waiter = this.waiting;
      this.waiting = null;
      this.failWaiting = null;
      if (waiter) waiter(parsed);
      else this.queued.push(parsed);
    }
  };

  private readonly onError = (error: Error): void => {
    this.fail(
      error instanceof AgentUnavailableError ? error : new AgentUnavailableError(error.message),
    );
  };

  private readonly onClose = (): void => {
    // A close with nothing pending is the ordinary end of the exchange. A close while a reply is
    // still expected is not: the agent always terminates its answers with a newline, so silence
    // here means the connection died rather than that the transfer succeeded quietly.
    this.fail(new AgentUnavailableError('the agent closed the data connection without answering'));
  };

  private fail(error: Error): void {
    this.failure ??= error;
    const waiter = this.failWaiting;
    this.waiting = null;
    this.failWaiting = null;
    if (waiter) waiter(error);
  }

  next(): Promise<DataReply> {
    const ready = this.queued.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise<DataReply>((resolve, reject) => {
      this.waiting = resolve;
      this.failWaiting = reject;
    });
  }

  dispose(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }
}

function once(socket: Socket, event: 'connect'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off(event, onDone);
      reject(new AgentUnavailableError(error.message));
    };
    const onDone = (): void => {
      socket.off('error', onError);
      resolve();
    };
    socket.once(event, onDone);
    socket.once('error', onError);
  });
}
