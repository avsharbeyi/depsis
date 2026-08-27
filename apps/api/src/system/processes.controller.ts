import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import {
  AgentService,
  AgentUnavailableError,
  type AgentRequest,
  type AgentResponse,
} from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { SystemService } from './system.service.js';

type Schemas = OpenApi.components['schemas'];

const killSchema = z.object({
  pid: z.number().int().min(2).max(4194304),
  // Ajanın TOCTOU savunmasının yakıtı: sinyalden hemen önce /proc'tan yeniden okunup
  // karşılaştırılacak ad. /proc/<pid>/comm en çok 15 bayt taşır.
  comm: z.string().min(1).max(32),
});

/**
 * Görev yöneticisi — arka planda ne koşuyor, ve sistemden olmayanı kapatmak.
 *
 * Sahibin istediği masaüstü kavramı: çarka basınca süreçler, yanında kapat düğmesi. Sınır
 * ajanda ve TEK yerde (`procs::is_protected`): sistem süreçleri listede `protected` bayrağıyla
 * gelir ve kapatma isteği aynı kuraldan reddedilir — arayüzün düğme çizmediğine ajan zaten
 * "hayır" der, iki taraf tek kaynaktan konuşur.
 *
 * Kurucu yönetici, havuz ve telemetriyle aynı kapıdan.
 */
@Controller('system/processes')
@UseGuards(SessionGuard)
export class ProcessesController {
  constructor(
    private readonly system: SystemService,
    private readonly agent: AgentService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['ProcessPage']> {
    await this.requireSystemAdmin(request);
    const answer = await this.call({ op: 'list_processes' }, 'listing background processes');
    if (answer.status !== 'processes') {
      throw new ServiceUnavailableException('süreç listesi alınamadı: beklenmeyen ajan yanıtı');
    }
    const page = answer as unknown as {
      processes: Array<{
        pid: number;
        uid: number;
        user: string;
        comm: string;
        args: string;
        rss_bytes: number;
        protected: boolean;
      }>;
      truncated: boolean;
    };
    return {
      items: page.processes.map((p) => ({
        pid: p.pid,
        user: p.user,
        comm: p.comm,
        args: p.args,
        rssBytes: p.rss_bytes,
        protected: p.protected,
      })),
      truncated: page.truncated,
    };
  }

  @Post('kill')
  @HttpCode(200)
  async kill(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ status: 'ok' }> {
    requireSameOrigin(request);
    const session = await this.requireSystemAdmin(request);

    const parsed = killSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('pid (tam sayı) ve comm (süreç adı) gerekli');
    }

    const correlationId = randomUUID();
    const answer = await this.call(
      { op: 'kill_process', pid: parsed.data.pid, comm: parsed.data.comm },
      `closing background process ${parsed.data.pid}`,
      correlationId,
    );
    if (answer.status === 'refused') {
      // Ajanın cümlesi aynen: "sistem süreci", "liste bayat", "zaten bitmiş" — hepsi
      // kullanıcının anlayacağı gerçekler.
      throw new BadRequestException((answer as { reason?: string }).reason ?? 'reddedildi');
    }
    if (answer.status !== 'process_killed') {
      throw new ServiceUnavailableException('süreç kapatılamadı: beklenmeyen ajan yanıtı');
    }

    await this.audit.record(session.organizationId, {
      actorId: session.userId,
      action: 'system.process-killed',
      target: { kind: 'process', id: String(parsed.data.pid), label: parsed.data.comm },
      summary: `'${parsed.data.comm}' (pid ${parsed.data.pid}) süreci görev yöneticisinden kapatıldı.`,
      correlationId,
    });
    return { status: 'ok' };
  }

  private async requireSystemAdmin(
    request: AuthenticatedRequest,
  ): Promise<{ organizationId: string; userId: string }> {
    const session = request.depsis;
    if (session === undefined) throw new UnauthorizedException();
    if (!(await this.system.isSystemAdministrator(session.userId))) throw new ForbiddenException();
    return { organizationId: session.organizationId, userId: session.userId };
  }

  private async call(
    op: AgentRequest,
    reason: string,
    correlationId: string = randomUUID(),
  ): Promise<AgentResponse> {
    try {
      return await this.agent.call(op, reason, correlationId);
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        throw new ServiceUnavailableException('depolama ajanına ulaşılamıyor');
      }
      throw error;
    }
  }
}
