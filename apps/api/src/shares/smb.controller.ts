import {
  ConflictException,
  Controller,
  InternalServerErrorException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { randomUUID } from 'node:crypto';

import { AgentRefusedError, AgentUnavailableError } from '../agent/agent.service.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import { requireSession } from '../files/files.controller.js';
import {
  ShareListNotDeviceWideError,
  SharePendingAdoptionError,
  SharesService,
  SmbPublishFailedError,
  SmbUnavailableError,
  UnpublishableShareError,
  describeRefusal,
} from './shares.service.js';

type Schemas = OpenApi.components['schemas'];

/**
 * `POST /system/smb` — write the Samba configuration and prove smbd is serving it.
 *
 * A second controller on the `system` prefix rather than a route added to `SystemController`,
 * because the thing it operates on is this module's: the share list, the publish cache that
 * `GET /shares` reports from, and the device-wide reasoning in `SharesService.publish`. Putting
 * the write next to the read is what keeps the cache from being updated in one module and read in
 * another.
 *
 * Administrators only, via `AdminGuard` — this reconfigures a daemon for the whole appliance.
 * 403 rather than 404 for everyone else, for the reason the rest of `system/` gives: the path is
 * in the published contract, so hiding it conceals nothing and makes a real administrator's
 * misconfiguration harder to diagnose.
 */
@Controller('system')
@UseGuards(SessionGuard, AdminGuard)
export class SmbController {
  constructor(private readonly shares: SharesService) {}

  @Post('smb')
  async publish(@Req() request: AuthenticatedRequest): Promise<Schemas['SmbPublishResult']> {
    const session = requireSession(request);

    // One id per HTTP request, carried into the privileged call, so the agent's audit trail can be
    // read back to the request that caused it (§16).
    const correlationId = randomUUID();

    try {
      return await this.shares.publish(session.organizationId, correlationId);
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * Map the service's outcomes onto the answers the contract describes.
 *
 * The 409 branches share a property that makes 409 the right code rather than 500: in every one of
 * them the appliance is exactly as it was before the request. The agent rolls back on a refusal,
 * and the two refusals raised before the agent is called never wrote anything at all. A caller who
 * fixes what the message names can retry, which is what a 409 promises and a 500 does not.
 *
 * `SmbPublishFailedError` is the exception, and it is why that property is stated rather than
 * assumed. It is the one outcome in which the appliance may NOT be as it was found, so it is the
 * one that must not be dressed as a retryable conflict.
 */
function translate(error: unknown): Error {
  if (error instanceof SmbUnavailableError) {
    return new ServiceUnavailableException(
      'Samba is not installed on this appliance, so there is nothing to publish to. The device ' +
        'ships with it, so this is a broken installation: install the samba package (or re-run ' +
        'the DEPSIS installer) and try again.',
    );
  }

  if (error instanceof ShareListNotDeviceWideError) {
    // Not a 500 and not a silent partial publish. The Samba configuration DEPSIS writes covers the
    // whole box, so publishing one organisation's shares would take the others' offline — see
    // `SharesService.publish`.
    return new ConflictException(
      'This appliance now holds more than one organization, and publishing Samba shares for one ' +
        'of them would stop serving the others. Nothing was changed.',
    );
  }

  if (error instanceof UnpublishableShareError) {
    return new ConflictException(
      `The share '${error.shareName}' cannot be published: ${error.why}. Rename it and try ` +
        'again. Nothing was changed.',
    );
  }

  if (error instanceof SmbPublishFailedError) {
    // 500, and it is the one answer here that is not a 409. Every other branch leaves the
    // appliance exactly as it was, which is what makes "fix this and retry" honest advice. This
    // one cannot promise that: the agent reached the point of replacing /etc/samba/depsis.conf and
    // could not prove it put the old file back, so the shares may be down device-wide. Telling an
    // administrator to retry would send them clicking a button while Explorer shows nothing and
    // the reason sits unread in the journal.
    // AJANIN CÜMLESİ DE GELİYOR, ve eski hâlinin yerine geliyor. Mesaj kullanıcıya "cihazdaki
    // /etc/samba/depsis.conf dosyasını inceleyin ve sistem günlüğüne bakın" diyordu: bu ürünün
    // kabul ölçütü, sahibinin olağan hiçbir iş için terminale girmemesi, ve bir hata mesajının
    // tek tavsiyesi terminal olamaz. Sahada bunun bedeli ödendi — düşen yayının gerçek sebebi
    //     zfs get mountpoint ev: dataset does not exist
    // idi, yani ekranda gösterilebilecek kadar somut bir cümle, ve ekranda hiç görünmedi.
    return new InternalServerErrorException(
      'Samba yapılandırması yazılamadı ve DEPSIS eskisinin geri konduğunu doğrulayamıyor — ' +
        `paylaşımlar şu an sunulmuyor olabilir. Ajanın bildirdiği sebep: ${error.agentReason}`,
    );
  }

  // AgentRefusedError'DAN ÖNCE, ve sırası kararın kendisi. Sahiplenme reddi de o sınıftan
  // geliyordu ve aşağıdaki dala düşüp "Samba yeni yapılandırmayı kabul etmedi, eskisi geri kondu"
  // diye anlatılıyordu — `publish_samba_config` daha çağrılmamışken. Sahibi Samba'yı suçlayıp
  // orada arıyordu; gerçek sebep havuz tarafındaydı ve hiç görünmüyordu.
  if (error instanceof SharePendingAdoptionError) {
    return new ConflictException(
      `'${error.shareName}' paylaşımı için havuzda veri kümesi açılamadı (${error.dataset}), ` +
        'bu yüzden yayın hiç başlamadı — Samba yapılandırması değişmedi ve sunulan paylaşımlar ' +
        `etkilenmedi. Ajanın bildirdiği sebep: ${error.agentReason}`,
    );
  }

  if (error instanceof AgentRefusedError) {
    // The agent's own words are NOT passed through. They are Rust error prose written for whoever
    // reads the journal, and a person looking at a settings page has no use for a path to a
    // module. `describeRefusal` turns the ones that matter into an instruction.
    return new ConflictException(describeRefusal(error.agentReason));
  }

  if (error instanceof AgentUnavailableError) {
    return new ServiceUnavailableException(
      'The system agent could not be reached, so the Samba configuration was not published. ' +
        'Shares that were already being served are unaffected.',
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}
