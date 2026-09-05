import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { OpenApi } from '@depsis/contracts';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { requireSameOrigin } from '../auth/origin.js';
import { AdminGuard, SessionGuard, type AuthenticatedRequest } from '../auth/session.guard.js';
import {
  CustomAppInvalidError,
  AlreadyInstalledError,
  AppNotInCatalogueError,
  CatalogueShapeError,
  MountTargetError,
  NoFreePortError,
  NotInstalledError,
  RootfulRuntimeError,
  SecretKeyMissingError,
  ShareNotFoundError,
  SharesRootMissingError,
  StaleInstallError,
  type AppView,
  type AppsOverview,
  AppsService,
  AppDataDirError,
} from './apps.service.js';
import { InvalidNameError, PodmanError, PodmanUnavailableError } from './podman.client.js';

type Schemas = OpenApi.components['schemas'];

// Matches the contract's path parameter and `app_catalogue_slug_format` in migration 0013. Checked
// here as well as in the database because a slug becomes part of a container name, and a value
// that reaches a URL should be refused at the edge rather than deep inside a client.
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/**
 * Özel uygulama tanımı. Şekil burada, kayıt defteri sınırı ve imaj biçimi serviste; İÇERİK hiçbir
 * yerde — DEPSIS eklenen imaja kefil olmaz ve arayüz bunu kullanıcıya aynen söyler.
 */
const customSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'kısa ad: küçük harf, rakam ve tire')
    .optional(),
  icon: z.string().trim().min(1).max(8).optional(),
  image: z.string().trim().min(1).max(255),
  tag: z.string().trim().min(1).max(128).default('latest'),
  containerPort: z.number().int().min(1).max(65535),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(1024)).default({}),
  volumes: z
    .array(z.string().regex(/^\/[A-Za-z0-9._/-]{1,127}$/, 'mutlak bir konteyner yolu olmalı'))
    .max(4)
    .default(['/config']),
});

const installSchema = z.object({
  mounts: z
    .array(
      z.object({
        target: z.string().min(1).max(255),
        // A share ID and nothing that looks like a path. The host side of a bind mount is derived
        // from the share this names; the request has no way to express a directory.
        shareId: z.string().uuid(),
      }),
    )
    .max(16),
});

const stateSchema = z.object({ state: z.enum(['running', 'stopped']) });

const logsSchema = z.object({
  lines: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * Install, run, stop and inspect the applications in the catalogue.
 *
 * `SessionGuard` on the class and `AdminGuard` on everything except the listing. Reading which
 * applications exist and whether they are running is ordinary household information — a member who
 * can see Jellyfin is running learns nothing they could not learn by opening it. Installing one
 * means downloading code from the internet and binding a share to it, and stopping one takes a
 * service away from everybody; the logs are behind the same gate because an application's log is
 * the place its configuration, its tokens and its paths turn up.
 */
@Controller('apps')
@UseGuards(SessionGuard)
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<Schemas['AppPage']> {
    const organizationId = requireOrganization(request);
    try {
      const overview = await this.apps.list(organizationId);
      return toPage(overview);
    } catch (error) {
      throw translate(error);
    }
  }

  // ── SIRA YÜK TAŞIYOR: SABİT YOL, PARAMETRELİ OLANIN ÜSTÜNDE ───────────────────────────
  //
  // Nest rotaları SINIFTAKİ BİLDİRİM SIRASIYLA kaydediyor, ve `:slug` her şeyi yakalıyor —
  // `custom` dahil. Bu blok aşağıdayken `POST /apps/custom` hiçbir zaman ona ulaşmadı:
  // `install` çalıştı, `slug` 'custom' oldu, gövde `installSchema`ya uymadığı için 400 döndü.
  // Ekrandaki "Özel uygulama ekle" formu hiç çalışmamıştı.
  //
  // Aynı dosyadaki `@Delete('custom/:slug')` doğru sırada duruyor — yani bu bir kalıp değil,
  // bir gözden kaçma. Yeni bir SABİT yol eklerken kuralı tekrar etmek gerekiyor.
  @Post('custom')
  @UseGuards(AdminGuard)
  async addCustom(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Schemas['CustomApp']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const parsed = customSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const input = parsed.data;
    const slug =
      input.slug ??
      input.name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/gu, '-')
        .replaceAll(/^-+|-+$/gu, '')
        .slice(0, 40);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(slug)) {
      throw new UnprocessableEntityException(
        'addan bir kısa ad türetilemedi; kısa adı kendiniz verin',
      );
    }
    try {
      const row = await this.apps.addCustom(session.organizationId, session.userId, {
        name: input.name,
        slug,
        icon: input.icon ?? '📦',
        image: input.image,
        tag: input.tag,
        containerPort: input.containerPort,
        env: input.env,
        volumes: input.volumes,
      });
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'apps.custom-added',
        target: { kind: 'app', id: row.slug, label: row.name },
        summary: `'${row.name}' özel uygulaması kataloğa eklendi (${row.image}:${row.tag}).`,
      });
      return {
        slug: row.slug,
        name: row.name,
        icon: row.icon,
        image: row.image,
        tag: row.tag,
        containerPort: row.container_port,
      };
    } catch (error) {
      throw translate(error);
    }
  }

  @Post(':slug')
  @UseGuards(AdminGuard)
  async install(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<Schemas['App']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const name = slugSchema.safeParse(slug);
    if (!name.success) throw new NotFoundException();

    const parsed = installSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('mounts must be a list of {target, shareId}');
    }

    try {
      const view = await this.apps.install(
        session.organizationId,
        session.userId,
        name.data,
        parsed.data.mounts,
      );
      // KAYDEDİLİYOR, ve komşularıyla aynı ağırlıkta olduğu için: kurmak internetten kod indirip
      // bir paylaşımı ona bağlamak demek — `share.created` ve `remote.member-authorized` kaydedilip
      // bunun kaydedilmemesi bir tercih değil, bir boşluktu. Commit'ten SONRA, `audit.service.ts`
      // 56-62'deki kararla aynı hizada.
      const bound = parsed.data.mounts.length;
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'apps.installed',
        target: { kind: 'app', id: name.data, label: view.catalogue.name },
        summary:
          `'${view.catalogue.name}' uygulaması kuruldu` +
          `${bound === 0 ? '' : `, ${bound} paylaşım bağlandı`}.`,
      });
      return toApp(view);
    } catch (error) {
      throw translate(error);
    }
  }

  @Patch(':slug')
  @UseGuards(AdminGuard)
  async setState(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<Schemas['App']> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const name = slugSchema.safeParse(slug);
    if (!name.success) throw new NotFoundException();

    const parsed = stateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("state must be 'running' or 'stopped'");

    try {
      const view = await this.apps.setState(session.organizationId, name.data, parsed.data.state);
      // İKİ AYRI EYLEM, tek bir `apps.state-changed` değil. "Dün bu kutuda ne oldu" listesinde
      // aranan şey "kim Jellyfin'i durdurdu", ve tek bir eylem adı bunu satırın özetini okumaya
      // bırakırdı — filtre de ikisini ayıramazdı.
      const started = parsed.data.state === 'running';
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: started ? 'apps.started' : 'apps.stopped',
        target: { kind: 'app', id: name.data, label: view.catalogue.name },
        summary: `'${view.catalogue.name}' uygulaması ${started ? 'başlatıldı' : 'durduruldu'}.`,
      });
      return toApp(view);
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete('custom/:slug')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async removeCustom(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<void> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const name = slugSchema.safeParse(slug);
    if (!name.success) throw new NotFoundException();
    try {
      await this.apps.removeCustom(session.organizationId, name.data);
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'apps.custom-removed',
        target: { kind: 'app', id: name.data },
        summary: `'${name.data}' özel uygulaması katalogdan silindi.`,
      });
    } catch (error) {
      throw translate(error);
    }
  }

  @Delete(':slug')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  async remove(@Req() request: AuthenticatedRequest, @Param('slug') slug: string): Promise<void> {
    requireSameOrigin(request);
    const session = requireSession(request);
    const name = slugSchema.safeParse(slug);
    if (!name.success) throw new NotFoundException();

    try {
      const label = await this.apps.remove(session.organizationId, name.data);
      // `app_instances` satırı DELETE ile gidiyor: kaldırma kaydedilmezse iki yöneticili bir evde
      // "Jellyfin'i kim sildi" sorusunun hiçbir cevabı kalmıyordu. Özet, verilerin durduğunu da
      // söylüyor — kaldırma konteynerleri siler, bağlı paylaşımları ve birimleri değil.
      await this.audit.record(session.organizationId, {
        actorId: session.userId,
        action: 'apps.removed',
        target: { kind: 'app', id: name.data, label },
        summary: `'${label}' uygulaması kaldırıldı; bağlı paylaşımlar ve verileri yerinde kaldı.`,
      });
    } catch (error) {
      throw translate(error);
    }
  }

  @Get(':slug/logs')
  @UseGuards(AdminGuard)
  async logs(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Query() query: unknown,
  ): Promise<Schemas['AppLogs']> {
    const organizationId = requireOrganization(request);
    const name = slugSchema.safeParse(slug);
    if (!name.success) throw new NotFoundException();

    const parsed = logsSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('lines must be between 1 and 500');

    try {
      return { lines: await this.apps.logs(organizationId, name.data, parsed.data.lines) };
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * `runtime.available` is a real answer now, and this is the only place it can be false.
 *
 * The contract described the same condition twice — a 503 and a flag — and the code had chosen the
 * 503, which made the flag dead: a caller cannot read a field on a body it will not receive. The
 * author of `remote.controller.ts` wrote that contradiction up and `/remote` was settled on 200 +
 * `available: false`. `/apps` is settled the same way here, and for the stronger reason: the
 * catalogue is a database table, so a box with no container runtime can still be shown the curated
 * list with a "no container runtime here" card beside it.
 */
function toPage(overview: AppsOverview): Schemas['AppPage'] {
  const items = overview.apps.map(toApp);
  if (overview.runtime === null) return { items, runtime: { available: false } };
  return {
    items,
    runtime: {
      available: true,
      version: overview.runtime.version,
      rootless: overview.runtime.rootless,
    },
  };
}

export function toApp(view: AppView): Schemas['App'] {
  const catalogue: Schemas['AppCatalogueEntry'] = {
    // `custom` YALNIZCA true iken yazılıyor. Katalog satırlarına `custom: false` basmak sözleşmeyi
    // gereksiz genişletirdi; alan opsiyonel ve `exactOptionalPropertyTypes` açık olduğu için
    // `custom: view.catalogue.custom` (undefined olabilir) derlenmezdi. Arayüz "Özel" rozetini ve
    // yöneticiye özel "Sil" düğmesini yalnız bu alandan çiziyor — burada düşerse özel uygulama
    // katalog satırından ayırt edilemez ve arayüzden bir daha kaldırılamaz.
    ...(view.catalogue.custom === true ? { custom: true } : {}),
    slug: view.catalogue.slug,
    name: view.catalogue.name,
    summary: view.catalogue.summary,
    icon: view.catalogue.icon,
    containerPort: view.catalogue.container_port,
    containers: view.containers.map((container) => ({
      role: container.role,
      image: container.image,
      tag: container.tag,
      primary: container.is_primary,
    })),
    // Every container's mount points in one list. The service refuses a catalogue in which two
    // containers want the same target, so flattening cannot lose one.
    mounts: view.containers.flatMap((container) => toMounts(container.mounts)),
  };

  if (view.instance === null) {
    // `state` is OMITTED rather than sent as a placeholder. The contract's enum has no value for
    // "there is nothing to have a state", and `unknown` would be a lie the interface would have to
    // render as a status light.
    return { catalogue, installed: false, url: null, hostPort: null, installedAt: null };
  }

  return {
    catalogue,
    installed: true,
    state: view.state ?? 'unknown',
    // The on-device address. The interface does NOT use this for its open link — the right host
    // name is whatever the viewer's browser reached this page by (LAN name, ZeroTier address),
    // which the server cannot know; the web builds the link from `hostPort` and its own location.
    url: `http://127.0.0.1:${view.instance.host_port}`,
    hostPort: view.instance.host_port,
    installedAt: view.instance.created_at.toISOString(),
  };
}

function toMounts(raw: unknown): Schemas['AppCatalogueEntry']['mounts'] {
  if (!Array.isArray(raw)) return [];
  const out: Schemas['AppCatalogueEntry']['mounts'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const target = record['target'];
    const mode = record['mode'];
    const purpose = record['purpose'];
    if (typeof target !== 'string') continue;
    out.push({
      target,
      mode: mode === 'ro' ? 'ro' : 'rw',
      purpose: typeof purpose === 'string' ? purpose : '',
    });
  }
  return out;
}

function requireSession(request: AuthenticatedRequest): {
  organizationId: string;
  userId: string;
} {
  const session = request.depsis;
  if (session === undefined) throw new UnauthorizedException();
  return { organizationId: session.organizationId, userId: session.userId };
}

function requireOrganization(request: AuthenticatedRequest): string {
  return requireSession(request).organizationId;
}

/**
 * The status codes, and why each one.
 *
 * The distinction this round's rules put first is between BROKEN and SWITCHED OFF, and it lives
 * here: `PodmanUnavailableError` means the socket is not there or nothing answered on it, which is
 * a 503 — "this appliance has no container runtime", an operator instruction. A 500 would say
 * "DEPSIS has a bug", send the operator to the wrong logs, and hide the one fact that would have
 * fixed it.
 *
 * A `PodmanError` is podman answering, so it is NOT unavailability. Its own status is carried
 * across where it means the same thing on the outside: 404 for a container that is gone, 409 for a
 * name already in use. Anything else is a runtime that is installed and unhappy, which is still a
 * "this is not going to work right now" rather than a bug in this code — 503, with podman's own
 * sentence attached so the reason is not lost.
 */
function translate(error: unknown): Error {
  if (error instanceof PodmanUnavailableError) {
    return new ServiceUnavailableException(error.message);
  }
  if (error instanceof SharesRootMissingError) {
    return new ServiceUnavailableException(error.message);
  }
  // A rootful socket is a deployment that is off ADR-0019, not a bad request: the request was
  // well formed and the appliance is not in a state where it can be served. 503 is the same slot
  // "there is no container runtime" uses, and the message names the environment variable.
  if (error instanceof RootfulRuntimeError) {
    return new ServiceUnavailableException(error.message);
  }
  if (error instanceof PodmanError) {
    if (error.status === 404) {
      // Sahada ölçüldü: kurulum sürerken (1,5 GB'lık immich-server hâlâ inerken) Başlat'a basan
      // sahibi podman'ın çıplak "no such container" cümlesini gördü ve bozuk sandı. Konteynerin
      // yokluğunun tek olağan sebebi bu — kurulumun henüz bitmemiş olması.
      return new ConflictException(
        'Uygulamanın konteynerleri henüz hazır değil — kurulum (imaj indirme) büyük olasılıkla ' +
          'sürüyor. Bir-iki dakika sonra yeniden deneyin.',
      );
    }
    if (error.status === 409) return new ConflictException(error.detail);
    return new ServiceUnavailableException(`the container runtime refused: ${error.detail}`);
  }
  // The catalogue said no. 404 for a slug that is not a row — the same answer as "not installed",
  // because from outside there is no difference worth telling apart.
  if (error instanceof CustomAppInvalidError) {
    return new UnprocessableEntityException(error.message);
  }
  if (error instanceof AppDataDirError) {
    // 409: the appliance is exactly as it was — the folder was not made and no container exists —
    // and the agent's sentence names what to change before retrying.
    return new ConflictException(error.message);
  }
  if (error instanceof AppNotInCatalogueError) return new NotFoundException(error.message);
  if (error instanceof NotInstalledError) return new NotFoundException(error.message);
  if (error instanceof ShareNotFoundError) return new NotFoundException(error.message);
  if (error instanceof AlreadyInstalledError) return new ConflictException(error.message);
  // 422 rather than 400: the body parsed, and every field is the right type. What is wrong is that
  // it does not match the mount points THIS application declares, which is a fact about the
  // catalogue rather than about the JSON.
  if (error instanceof MountTargetError) return new UnprocessableEntityException(error.message);
  // A slug or an image that did not survive its own type's check. Refusing rather than 500 because
  // the value came from outside even when a table stored it on the way.
  if (error instanceof InvalidNameError) return new UnprocessableEntityException(error.message);
  if (error instanceof NoFreePortError) return new ConflictException(error.message);
  // 503 and not 422: the request is fine, the APPLIANCE is missing a key file. Same slot as a
  // missing share root and a missing container runtime, and the message names the setting.
  if (error instanceof SecretKeyMissingError) {
    return new ServiceUnavailableException(error.message);
  }
  // 409: the record and the catalogue describe different applications, and the way out is the
  // uninstall the message asks for. A conflict rather than a fault, because nothing is broken —
  // the two just no longer agree.
  if (error instanceof StaleInstallError) return new ConflictException(error.message);
  // A catalogue row only a migration could have written. 500 by falling through would be right
  // about whose fault it is and useless to the person reading it, so it says what is wrong.
  if (error instanceof CatalogueShapeError) {
    return new ServiceUnavailableException(`the catalogue entry is unusable: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
