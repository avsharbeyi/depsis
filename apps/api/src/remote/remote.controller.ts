import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { AgentRefusedError, AgentUnavailableError } from '../agent/agent.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  NETWORK_ID,
  NetworkAlreadyJoinedError,
  NetworkNotJoinedError,
  RemoteService,
  RemoteUnavailableError,
  type RemoteNetwork,
  type RemoteStatus,
} from './remote.service.js';

/**
 * The join body.
 *
 * `networkId` is checked here even though the agent types it as `NetworkId` and the database
 * constrains the column. Not redundancy for its own sake: a value that will be concatenated into a
 * request path on the privileged side should be refused at the first boundary that sees it, so
 * that a malformed one produces a 422 naming the field rather than a refusal from two layers down
 * — and so that ADR-0020's "geçersiz ağ kimliği … ajana hiç ulaşmaz" is true by construction.
 *
 * `label` is DEPSIS's own name for the network. ZeroTier's `name` belongs to whoever administers
 * the network and is frequently empty, which is why there is a second field at all.
 */
const joinSchema = z.object({
  networkId: z.string().trim().regex(NETWORK_ID),
  label: z.string().trim().min(1).max(64).optional(),
});

/**
 * Remote access over ZeroTier (ADR-0020).
 *
 * `SessionGuard` on the whole controller, `AdminGuard` on the two routes that change something.
 * The split is the ADR's: joining makes the appliance visible to everyone on that network and is
 * an administrative decision, while the node's own id is not a secret and every signed-in user may
 * read it.
 *
 * Every route can answer 503 and none may answer 500 for a daemon that is switched off. DEPSIS
 * does not package zerotier-one, so "not installed" is an ordinary state of the box rather than a
 * fault, and the difference between "broken" and "off" is the one an operator needs most.
 */
type Schemas = OpenApi.components['schemas'];

@Controller('remote')
@UseGuards(SessionGuard)
export class RemoteController {
  constructor(private readonly remote: RemoteService) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest): Promise<RemoteStatus> {
    const session = requireSession(request);
    // One id per HTTP request, carried into both privileged calls, so the agent's audit trail can
    // be read back to the request that caused it (§16).
    const correlationId = randomUUID();
    try {
      return await this.remote.status(session.organizationId, correlationId);
    } catch (error) {
      // This route ALWAYS answers 200, including when zerotier-one is not installed at all.
      //
      // The contract used to publish both a 503 and an `available` flag here, and this file's
      // author reported that as a contradiction — correctly, because a caller cannot be told to
      // read a field on a body it will not receive. The document now says 200 and this is that
      // decision in code.
      //
      // 200 is the right side of it: DEPSIS does not package zerotier-one, so "not installed" is
      // an ordinary state of the box. The interface has to render a card that says so and shows
      // how to install it, and a card cannot be drawn from an error. That this differs from
      // `/system/telemetry`, which does answer 503, is deliberate — a NAS with no storage agent
      // really is broken, and a NAS with no remote access is just a NAS.
      //
      // Only unavailability degrades. Anything else is still a fault and still propagates.
      if (error instanceof RemoteUnavailableError || error instanceof AgentUnavailableError) {
        return { available: false, online: false, networks: [] };
      }
      throw translate(error);
    }
  }

  /**
   * Bağlantı tanılaması: bu düğüm kimi görüyor ve NASIL ulaşıyor.
   *
   * `GET /remote` "çevrimiçi" ve "ağa katıldı" diyor, ve her baytı bir ZeroTier kökü üzerinden
   * aktarılan bir bağlantı için de aynı şeyi diyor — doğru, ve bir kat daha yavaş. Kullanıcının
   * "neden yavaş" sorusunun cevabı bu listede, `direct` sütununda.
   *
   * YALNIZ YÖNETİCİ. Eş listesi kiracıya değil KUTUYA ait — daemon kimin sorduğunu bilmiyor — ve
   * bu cihazın kiminle konuştuğunun haritası sıradan bir üyenin işi değil.
   *
   * Bu rota da 200 ile cevaplıyor: ZeroTier kurulu değilse boş bir liste ve `available: false`.
   * `GET /remote` ile aynı gerekçe, ve aynı olması gerekiyor — iki uçtan biri hata döndürüp öteki
   * dönmeseydi, arayüz aynı olguyu iki farklı yolla öğrenmek zorunda kalırdı.
   */
  @Get('peers')
  // `AdminGuard` sınıfın `SessionGuard`'ının üstüne ve YALNIZ bu rotaya: komşu uçlar üyelere açık,
  // ve sınıfa koymak onları da kapatırdı.
  @UseGuards(AdminGuard)
  async peers(@Req() request: AuthenticatedRequest): Promise<Schemas['RemotePeerPage']> {
    requireSession(request);
    const correlationId = randomUUID();
    try {
      const peers = await this.remote.peers(correlationId);
      return {
        available: true,
        items: peers.map((peer) => ({
          address: peer.address,
          role: peer.role,
          version: peer.version,
          latencyMs: peer.latency_ms ?? null,
          direct: peer.direct,
        })),
      };
    } catch (error) {
      if (error instanceof RemoteUnavailableError || error instanceof AgentUnavailableError) {
        return { available: false, items: [] };
      }
      throw translate(error);
    }
  }

  @Post('networks')
  @UseGuards(AdminGuard)
  async join(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<RemoteNetwork> {
    requireSameOrigin(request);
    const session = requireSession(request);

    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        'networkId must be exactly 16 lowercase hexadecimal digits, and a label — if given — at ' +
          'most 64 characters',
      );
    }

    const correlationId = randomUUID();
    try {
      return await this.remote.join(
        session.organizationId,
        session.userId,
        parsed.data.networkId,
        parsed.data.label ?? null,
        correlationId,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete('networks/:networkId')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async leave(
    @Req() request: AuthenticatedRequest,
    @Param('networkId') networkId: string,
  ): Promise<void> {
    requireSameOrigin(request);
    const session = requireSession(request);

    // 404 rather than 422, and the contract is the reason: this path publishes 403, 404 and 503
    // and nothing else. It is also the honest answer — a string that cannot be a network id
    // cannot name a network this organisation joined — and it keeps the ADR's guarantee that a
    // malformed id never reaches the agent.
    if (!NETWORK_ID.test(networkId)) throw new NotFoundException('no such joined network');

    const correlationId = randomUUID();
    try {
      await this.remote.leave(session.organizationId, networkId, correlationId);
    } catch (error) {
      // Handled here rather than in `translate`, because this path publishes no 422. A refusal
      // from `zerotier_leave` is unreachable today — the agent has no refusal branch for it — but
      // an unmapped one would surface as a 500, which is precisely the outcome ADR-0020's
      // verification forbids. 503 is the honest slot: the request was well formed and the
      // privileged side declined to act on it right now.
      if (error instanceof AgentRefusedError) {
        throw new ServiceUnavailableException(
          `Leaving the network was refused: ${error.agentReason}`,
        );
      }
      throw translate(error);
    }
  }
}

function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}

function translate(error: unknown): Error {
  // 503, never 500. zerotier-one absent or stopped is a configuration state of the appliance, and
  // the card the user sees has to be able to say so (ADR-0020).
  if (error instanceof RemoteUnavailableError) {
    return new ServiceUnavailableException(`Remote access is unavailable: ${error.detail}`);
  }

  // The privileged agent itself could not be reached, which is a different fault with the same
  // answer: nothing was necessarily done, so retry rather than change the request.
  if (error instanceof AgentUnavailableError) {
    return new ServiceUnavailableException(
      'Remote access is unavailable: the system agent could not be reached.',
    );
  }

  if (error instanceof NetworkAlreadyJoinedError) return new ConflictException(error.message);
  if (error instanceof NetworkNotJoinedError) {
    // The same answer for "never joined", "already left" and "another tenant's network". The
    // ZeroTier node is device-wide while this table is not, so a distinct refusal would tell one
    // organisation which networks another one is on.
    return new NotFoundException('no such joined network');
  }

  // The agent was reached and said no. 422 rather than 409: the only refusal the join path can
  // produce is about the id that was sent, and `POST /remote/networks` publishes 422 for exactly
  // that. `DELETE` handles its own refusal, because it publishes no 422.
  if (error instanceof AgentRefusedError) {
    return new UnprocessableEntityException(`the network was not joined: ${error.agentReason}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}
