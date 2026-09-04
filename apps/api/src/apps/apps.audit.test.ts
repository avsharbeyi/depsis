import { describe, expect, it } from 'vitest';

import type { AuditEntry, AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { AppsController } from './apps.controller.js';
import type { AppsService, AppView } from './apps.service.js';

/**
 * Kurma, başlatma, durdurma ve kaldırma denetim defterine düşüyor mu.
 *
 * VERİTABANI GEREKTİRMİYOR: ölçülen şey denetim satırının YAZILIP yazılmadığı ve hangi eylem
 * adıyla yazıldığı — ikisi de bu sınıfın kendi kararı. Satırın tabloya nasıl yazıldığı
 * `audit.integration.test.ts`in konusu.
 *
 * NEDEN BİR TEST GEREKİYOR. `app_instances` satırı kaldırmada DELETE ile gidiyor: iki yöneticili
 * bir evde biri Jellyfin'i sildiğinde "dün bu kutuda ne oldu" listesinde tek bir satır yoktu ve
 * sahibi kimin yaptığını öğrenemiyordu. Eşdeğer ağırlıktaki komşular — `console.opened`,
 * `share.created`, `remote.member-authorized` — hep kaydediliyordu; eksik olan bu üçüydü.
 */

const VIEW = {
  catalogue: {
    id: 'c1',
    slug: 'jellyfin',
    name: 'Jellyfin',
    summary: 'Medya',
    icon: '🎬',
    container_port: 8096,
  },
  containers: [],
  instance: null,
  state: null,
} as unknown as AppView;

const request = {
  depsis: {
    sessionId: 's',
    organizationId: 'org',
    userId: 'admin-1',
    role: 'admin',
    expiresAt: new Date(),
  },
  headers: {},
  method: 'POST',
  secure: false,
} as unknown as AuthenticatedRequest;

function controller(): [AppsController, AuditEntry[]] {
  const written: AuditEntry[] = [];
  const apps = {
    install: () => Promise.resolve(VIEW),
    setState: () => Promise.resolve(VIEW),
    remove: () => Promise.resolve('Jellyfin'),
  } as unknown as AppsService;
  const audit = {
    record: (_org: string, entry: AuditEntry) => {
      written.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  return [new AppsController(apps, audit), written];
}

describe('the applications leave a trail', () => {
  it('records an install with the application it installed', async () => {
    const [apps, written] = controller();
    await apps.install(request, 'jellyfin', { mounts: [] });

    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('apps.installed');
    expect(written[0]?.actorId).toBe('admin-1');
    expect(written[0]?.target).toMatchObject({ kind: 'app', id: 'jellyfin', label: 'Jellyfin' });
  });

  it('tells starting and stopping apart, because that is the question being asked', async () => {
    // Tek bir `apps.state-changed` olsaydı "kim Jellyfin'i durdurdu" sorusu satırın özetini
    // okumaya kalırdı, ve filtre ikisini ayıramazdı.
    const [apps, written] = controller();
    await apps.setState(request, 'jellyfin', { state: 'stopped' });
    await apps.setState(request, 'jellyfin', { state: 'running' });

    expect(written.map((entry) => entry.action)).toEqual(['apps.stopped', 'apps.started']);
  });

  it('records a removal, which is the one nothing else could reconstruct', async () => {
    const [apps, written] = controller();
    await apps.remove(request, 'jellyfin');

    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('apps.removed');
    // Adı `remove` döndürüyor: satır silindikten sonra onu okuyacak bir yer kalmıyor.
    expect(written[0]?.target?.label).toBe('Jellyfin');
    // §16'nın karşılığı olarak özetin söylediği şey: veriler yerinde kaldı.
    expect(written[0]?.summary).toMatch(/yerinde kaldı/);
  });

  it('uses only action names the audit table accepts', () => {
    // `audit_events_action_shape` (migration 0036). Bir eylem adı bu kalıba uymazsa satır
    // yazılamaz, ve denetim yazması commit'ten SONRA olduğu için değişiklik kayıtsız kalırdı.
    const shape = /^[a-z][a-z-]*(\.[a-z][a-z-]*)+$/;
    for (const action of ['apps.installed', 'apps.started', 'apps.stopped', 'apps.removed']) {
      expect(action, action).toMatch(shape);
    }
  });
});
