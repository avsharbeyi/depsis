import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  EXPECTED_SCHEMA_VERSION,
  sanitiseCorrelationId,
  sanitiseReason,
  type Agent,
  type AgentEnvelope,
} from '@depsis/agent-protocol';
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type AgentRequest = Agent.AgentRequest;
export type AgentResponse = Agent.AgentResponse;
/**
 * A name in a share's `valid users`.
 *
 * Re-exported beside the request rather than reached for through `Agent.` at the call site, for
 * the same reason `AgentRequest` is: the generated namespace is the agent's, and a service that
 * imports one type from it should not have to know that.
 */
export type SmbPrincipal = Agent.SmbPrincipal;

/** The agent could not be reached, or did not answer in time. Nothing was necessarily done. */
export class AgentUnavailableError extends Error {
  constructor(reason: string) {
    super(`the system agent is not available: ${reason}`);
    this.name = 'AgentUnavailableError';
  }
}

/** The agent was reached, understood the request, and said no. */
export class AgentRefusedError extends Error {
  constructor(readonly agentReason: string) {
    super(`the system agent refused: ${agentReason}`);
    this.name = 'AgentRefusedError';
  }
}

/**
 * The unprivileged side of threat-model boundary TB4.
 *
 * Everything this class can ask for is in a closed typed enum the Rust agent owns (ADR-0006). There
 * is no method here taking a command, a path, or an argument list, because the wire format has
 * nowhere to put one — §2.2 is enforced by the shape of the types, not by validation here. What
 * this adds on top of the protocol is the three things a caller should not have to think about:
 * serialisation, a deadline, and a version handshake.
 */
@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);

  /**
   * Calls go out ONE AT A TIME, because that is how the agent accepts them.
   *
   * Its `serve_loop` handles a single connection at a time by design: privileged operations mutate
   * global system state, and serialising at the accept loop is what makes the audit log a true
   * serial history. If the API opened connections freely they would queue in the kernel backlog
   * (16, per the socket unit) and the seventeenth would be refused with an ECONNREFUSED that says
   * nothing about why. Queueing here turns a busy agent into a measurable wait instead.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Beyond this, callers are refused immediately rather than queued behind a stuck agent. */
  private static readonly MAX_QUEUE_DEPTH = 32;

  /**
   * The budget for a whole call — queue wait included, not just the exchange.
   *
   * Deadlining only the socket exchange would let the last caller in a full queue wait
   * MAX_QUEUE_DEPTH × timeout before its own clock even started, which is half an hour of an HTTP
   * client that gave up long ago. Counting from the moment the call was made also means a request
   * whose caller has already timed out is dropped BEFORE the agent is asked to do the work, rather
   * than after.
   */
  static readonly DEFAULT_CALL_BUDGET_MS = 60_000;

  private available = false;

  /**
   * En son ne zaman "ajan geldi mi" diye yoklandığı.
   *
   * `ensureAvailable()` yoklamayı bununla seyreltiyor. Sebep: `depsis-api.service` ajan soketine
   * `Requires=` değil `Wants=` ile bağlı, yani ajan geç kalktığında API onsuz ayağa kalkıyor ve
   * mandal kapalı kalıyordu — ajan otuz saniye sonra gelse bile her yükleme, klasör oluşturma ve
   * yeniden adlandırma `systemctl restart depsis-api` yazılana kadar 503 veriyordu. Terminalsiz
   * ürün kuralı bunu yasaklıyor.
   */
  private lastProbeAt = 0;

  /** İki yoklama arasındaki en kısa süre. Ajan yokken her istek bir bağlantı denemesi olmasın. */
  private static readonly PROBE_COOLDOWN_MS = 10_000;

  /**
   * Why this agent must not be used, when the handshake found a reason.
   *
   * SEPARATE FROM `available`, because the two mean different things and only one of them is
   * fatal. `available === false` also covers "the socket was not there at startup", which is the
   * ordinary state of a development machine and must not stop the API — endpoints that need the
   * agent answer 503 and everything else works. A VERSION MISMATCH is different: the socket is
   * there, it answers, and it means something other than intended by what this build sends. That
   * one fails closed.
   *
   * It was not enforced at all until a review pointed at it: `onModuleInit` logged the mismatch
   * and `call()` gated only on `socketPath === null` and queue depth, so the pair that
   * `packages/agent-protocol/src/index.test.ts` describes as failing at the handshake went on to
   * exchange requests.
   */
  private refuseBecause: string | null = null;

  /**
   * `budgetMs` is a real parameter rather than a test seam: the default is sized for `zfs create`
   * on a busy pool, and a deployment that knows its pools are slower has a legitimate reason to
   * raise it. Tests lower it so that a timeout assertion takes milliseconds instead of a minute.
   */
  constructor(
    private readonly socketPath: string | null,
    private readonly budgetMs: number = AgentService.DEFAULT_CALL_BUDGET_MS,
  ) {}

  /**
   * Ping the agent and check it speaks the version this build was generated against.
   *
   * A mismatched pair should fail while somebody is watching a deployment, not halfway through
   * creating a dataset — which is the whole reason `ping` is in the operation set.
   *
   * The API does NOT refuse to start when the agent is absent. A development machine has no agent
   * and no Unix socket at all, and failing hard there would mean the API could only run on Linux.
   * Endpoints needing the agent answer 503; everything else works. The difference is logged at
   * error level so that a production box missing its agent is not a quiet condition.
   */
  async onModuleInit(): Promise<void> {
    if (this.socketPath === null) {
      this.logger.warn(
        'DEPSIS_AGENT_SOCKET is not set: storage operations are unavailable. ' +
          'Expected on a development machine, a misconfiguration anywhere else.',
      );
      return;
    }

    try {
      const response = await this.enqueue({ op: 'ping' }, 'startup handshake', randomUUID());
      if (response.status !== 'ok') {
        throw new AgentUnavailableError(`ping answered '${response.status}'`);
      }
      if (response.schema_version !== EXPECTED_SCHEMA_VERSION) {
        this.refuseBecause =
          `the agent speaks schema ${response.schema_version}, this build was generated against ` +
          `${EXPECTED_SCHEMA_VERSION}; one of the two is stale`;
        // Alışveriş başarılıydı, dolayısıyla `enqueue` mandalı açtı. Sürüm uyuşmazlığı bunu geri
        // alır: soket oradadır ama söyledikleri başka bir şey demektir, ve o hâl kapalı düşmeli.
        this.available = false;
        throw new AgentUnavailableError(
          `schema version mismatch: the agent speaks ${response.schema_version}, this build was ` +
            `generated against ${EXPECTED_SCHEMA_VERSION}. One of the two is stale, and running ` +
            `them together means requests that parse and mean something other than intended.`,
        );
      }
      this.available = true;
      this.logger.log(`agent reachable at ${this.socketPath}, schema v${response.schema_version}`);
    } catch (error) {
      // Mandal burada kapatılıyor, ve bu bir ihtiyat değil bir zorunluluk: başarılı her alışveriş
      // `enqueue` içinde mandalı açıyor, dolayısıyla EL SIKIŞMAYI geçemeyen — yanlış `status`,
      // yanlış şema — bir cevap da onu açmış oluyordu. El sıkışma bitmediyse ajan kullanılmaz.
      this.available = false;
      this.logger.error(
        `system agent unreachable at ${this.socketPath}: ${describe(error)}. ` +
          'Storage operations will answer 503.',
      );
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Aynı soruyu sorar, ama cevabı TAZELER: mandal kapalıysa ajanı bir kez yoklar.
   *
   * `isAvailable()` bir açılış mandalıydı ve hiç kendine gelmiyordu. Ajan API'den sonra kalktığında
   * — soket birimi `Wants=` ile bağlı olduğu için olağan bir durum — mandal kapalı kalıyor, ve
   * ajana hiç uğramadan senkron kapıda 503 veren uçlar (yükleme, klasör oluşturma, yeniden
   * adlandırma) kalıcı olarak kapanıyordu. Çıkış yolu terminaldi.
   *
   * SOĞUMA SÜRESİ VAR: ajan gerçekten yokken her istek bir bağlantı denemesine dönüşmemeli. On
   * saniye, kullanıcının "tekrar dene"sinin çalışacağı kadar kısa, gürültü olmayacak kadar uzun.
   *
   * SÜRÜM UYUŞMAZLIĞI YİNE KAPALI DÜŞÜYOR: geç gelen ajan yanlış şemayı konuşuyorsa `refuseBecause`
   * yazılır ve mandal açılmaz — `call()` de o andan sonra reddeder.
   */
  async ensureAvailable(): Promise<boolean> {
    if (this.available) return true;
    if (this.socketPath === null || this.refuseBecause !== null) return false;

    const now = Date.now();
    if (now - this.lastProbeAt < AgentService.PROBE_COOLDOWN_MS) return false;
    this.lastProbeAt = now;

    try {
      const response = await this.enqueue({ op: 'ping' }, 'availability probe', randomUUID());
      // Alışveriş başarılıysa `enqueue` mandalı açtı; el sıkışmayı geçemeyen her yol onu geri
      // almalı, yoksa `isAvailable()` "hazır" derken `call()` reddeder.
      if (response.status !== 'ok') {
        this.available = false;
        return false;
      }
      if (response.schema_version !== EXPECTED_SCHEMA_VERSION) {
        this.refuseBecause =
          `the agent speaks schema ${response.schema_version}, this build was generated against ` +
          `${EXPECTED_SCHEMA_VERSION}; one of the two is stale`;
        this.available = false;
        this.logger.error(`system agent unusable: ${this.refuseBecause}`);
        return false;
      }
      this.logger.log(
        `agent became reachable at ${this.socketPath}, schema v${response.schema_version}`,
      );
      return true;
    } catch {
      // Sessiz: ajan hâlâ yok. Bunu her yoklamada günlüğe yazmak açılıştaki tek `error` satırını
      // gürültüde boğardı, ve o satır operatörün gerçekten okuması gereken satır.
      return false;
    }
  }

  /**
   * Ask the agent to do one thing.
   *
   * `reason` is not decoration: it lands in the agent's audit trail beside the operation and the
   * calling credentials, and §16 requires a privileged action to be explainable afterwards.
   * Something vague here is a problem handed to whoever reads the journal at 3am.
   */
  async call(
    request: AgentRequest,
    reason: string,
    correlationId: string = randomUUID(),
  ): Promise<AgentResponse> {
    if (this.socketPath === null) {
      throw new AgentUnavailableError('DEPSIS_AGENT_SOCKET is not configured');
    }
    // Fails CLOSED, unlike the absent-socket case above, which is merely 503. A mismatched pair
    // exchanges requests that parse and mean something other than intended — and one of the
    // operations on that wire erases disks.
    if (this.refuseBecause !== null) {
      throw new AgentUnavailableError(this.refuseBecause);
    }
    if (this.depth >= AgentService.MAX_QUEUE_DEPTH) {
      throw new AgentUnavailableError(
        `${this.depth} calls are already queued; the agent is not keeping up`,
      );
    }
    return this.enqueue(request, reason, correlationId);
  }

  /** Serialised behind every earlier call, and bounded from the moment it was asked for. */
  private enqueue(
    request: AgentRequest,
    reason: string,
    correlationId: string,
  ): Promise<AgentResponse> {
    // Sanitised here rather than inside the exchange so that a bad correlation id is a synchronous
    // programming error at the call site, not a rejection that surfaces a queue-length later.
    const envelope: AgentEnvelope<AgentRequest> = {
      correlation_id: sanitiseCorrelationId(correlationId),
      reason: sanitiseReason(reason),
      request,
    };
    const deadline = Date.now() + this.budgetMs;
    this.depth += 1;

    // `catch` before `then`, so one failed call does not poison the chain for every call after it.
    const result = this.chain
      .catch(() => undefined)
      .then(async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AgentUnavailableError(
            `gave up after ${this.budgetMs}ms waiting behind other calls`,
          );
        }
        const response = await this.exchange(envelope, remaining);
        // BAŞARILI HER ALIŞVERİŞ MANDALI AÇAR. Açılışta kapanan mandal başka hiçbir yerde
        // açılmıyordu; ajan sonradan geldiğinde ona ulaşan çağrılar çalışıyor, ama mandala bakan
        // uçlar kapalı kalıyordu. Cevap alındıysa ajan oradadır — reddetme de bir cevaptır.
        this.available = true;
        return response;
      });

    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.depth -= 1;
    });
  }

  private exchange(
    envelope: AgentEnvelope<AgentRequest>,
    budgetMs: number,
  ): Promise<AgentResponse> {
    const path = this.socketPath;
    if (path === null) return Promise.reject(new AgentUnavailableError('no socket configured'));

    return new Promise<AgentResponse>((resolve, reject) => {
      const socket: Socket = createConnection({ path });
      let buffer = '';
      let settled = false;

      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        act();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new AgentUnavailableError(`no answer within ${budgetMs}ms`)));
      }, budgetMs);

      socket.on('connect', () => {
        // `write`, deliberately NOT `end`.
        //
        // Half-closing after the request looks tidier and is what an earlier draft did, but it buys
        // nothing: the agent's read loop breaks on the newline (`if saw_newline { break; }` in
        // read_request_line_within), so EOF is only its fallback for an unterminated line, and we
        // always send the terminator. It also costs something real. Measured on Windows named
        // pipes, which is what `net` gives you when there is no AF_UNIX: with the client half-closed
        // and the server answering after a delay, connections 4 and 5 of 5 lost the response
        // entirely — EOF with zero bytes, while the server side reported a successful write to a
        // writable socket. Without the half-close, 15 of 15 arrived. On AF_UNIX both forms deliver
        // 20 of 20 (measured under WSL2, Linux 6.6), so this is a portability fix that costs
        // nothing on the transport that ships. The socket is destroyed as soon as the response line
        // is read, so nothing is leaked by leaving the write side open.
        socket.write(JSON.stringify(envelope) + '\n');
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        finish(() => settle(buffer.slice(0, newline), resolve, reject));
      });

      socket.on('end', () => {
        // Closed without a newline. Responses always end in one, so anything here is truncated —
        // and a truncated JSON document can still parse into something that looks like an answer.
        finish(() => {
          if (buffer.trim() === '') {
            reject(new AgentUnavailableError('the agent closed the connection without answering'));
          } else {
            reject(
              new AgentUnavailableError('the agent sent an answer with no terminating newline'),
            );
          }
        });
      });

      socket.on('error', (error: Error) => {
        finish(() => reject(new AgentUnavailableError(error.message)));
      });
    });
  }
}

function settle(
  line: string,
  resolve: (value: AgentResponse) => void,
  reject: (error: Error) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    reject(new AgentUnavailableError(`unparseable answer: ${describe(error)}`));
    return;
  }
  // The generated types describe what the agent PROMISES to send, which is not the same as what
  // arrived on a socket. Checking that `status` is a string is not full validation, but it is the
  // difference between a legible error here and `undefined` reaching a switch statement later.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { status?: unknown }).status !== 'string'
  ) {
    reject(new AgentUnavailableError('the answer had no status field'));
    return;
  }
  resolve(parsed as AgentResponse);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Narrow a response to the variant the caller expects, or throw something legible.
 *
 * A helper rather than a check repeated at each call site, because the case that is easy to skip is
 * the important one: `refused` and `failed` are ORDINARY answers on this wire, not exceptions. A
 * caller that only tests for its own variant treats a refusal as a missing field.
 */
export function expectStatus<S extends AgentResponse['status']>(
  response: AgentResponse,
  status: S,
): Extract<AgentResponse, { status: S }> {
  if (response.status === status) return response as Extract<AgentResponse, { status: S }>;
  if (response.status === 'refused' || response.status === 'failed') {
    throw new AgentRefusedError(response.reason);
  }
  throw new AgentUnavailableError(`expected '${status}', the agent answered '${response.status}'`);
}
