import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbService } from '../db/db.service.js';
import { LicenseService } from './license.service.js';

/**
 * Lisansın SAKLANMASI, gerçek bir PostgreSQL'e karşı.
 *
 * Bu süit, birim testlerinin yapı olarak göremediği bir hata yüzünden var. `check` saf bir işlev
 * ve sahte bir veritabanıyla sınanıyor; `install` ise şemaya yazıyor, ve iki taraf AYRI AYRI
 * doğruyken birbirine göre yanlış olabiliyor.
 *
 * Tam olarak bu oldu. Müşteri adı, hiçbir şeyle karşılaştırılmadığı için isteğe bağlı hâle geldi —
 * jetondan, araçtan ve doğrulamadan kalktı — ama `licensed_to` kolonu `NOT NULL` kaldı. Ortaya,
 * aynı sürümde hem adsız lisans ÜRETEN bir araç hem de onu REDDEDEN bir veritabanı çıktı. Sahadaki
 * ilk kurulumda imza doğrulandı, satır yazılamadı, ve kullanıcının gördüğü şey 500 oldu.
 *
 * Skipped unless `DEPSIS_TEST_DATABASE_URL` points at a migrated database.
 */

const APP_URL = process.env['DEPSIS_TEST_DATABASE_URL'];
const runnable = APP_URL !== undefined && APP_URL !== '';
const describeDb = runnable ? describe : describe.skip;

const KEYGEN = join(process.cwd(), '..', '..', 'tools', 'license', 'keygen.mjs');

describeDb('lisansın saklanması, gerçek bir PostgreSQL ile', () => {
  let db: DbService;
  let license: LicenseService;
  let dir: string;
  let privateKeyPath: string;

  beforeAll(async () => {
    db = new DbService(APP_URL as string);
    await db.onModuleInit();

    dir = mkdtempSync(join(tmpdir(), 'depsis-license-db-'));
    execFileSync(process.execPath, [KEYGEN, 'init', dir], { encoding: 'utf8' });
    privateKeyPath = join(dir, 'depsis-license.key');
    const machineId = join(dir, 'machine-id');
    writeFileSync(machineId, 'af04e5981b2c4d5e8f9a0b1c2d3e4f50');

    license = new LicenseService(db, join(dir, 'license-key.pub'), machineId);
  });

  afterAll(async () => {
    await db.onModuleDestroy?.();
  });

  it('ADSIZ bir lisans saklanabiliyor ve geri okunabiliyor', async () => {
    // Sahada düşen tam bu yol: iki soruya inen araç adsız jeton üretiyor, ve `licensed_to`
    // `NOT NULL` olduğu sürece INSERT 23502 ile düşüp kullanıcıya 500 döndürüyordu.
    const token = execFileSync(
      process.execPath,
      [KEYGEN, 'issue', '--key', privateKeyPath, '--until', '2030-01-01'],
      { encoding: 'utf8' },
    ).trim();

    const checked = license.check(token);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.payload.to).toBeNull();

    await license.install(token, checked.payload);

    const current = await license.current();
    expect(current).not.toBeNull();
    expect(current).not.toHaveProperty('invalid');
    if (current === null || 'invalid' in current) return;
    expect(current.payload.id).toBe(checked.payload.id);
    expect(current.payload.to).toBeNull();
  });

  it('ikinci bir lisans ÜSTÜNE yazıyor, ikinci satır açmıyor', async () => {
    // Tablo tek satırlı ve tekliği veritabanı zorluyor. "En son eklenen geçerlidir" olsaydı,
    // hangisinin geçerli olduğuna okuyan taraf karar ederdi — ve o karar iki yerde iki türlü
    // yazılırdı.
    const first = execFileSync(
      process.execPath,
      [KEYGEN, 'issue', '--key', privateKeyPath, '--to', 'Birinci'],
      { encoding: 'utf8' },
    ).trim();
    const second = execFileSync(
      process.execPath,
      [KEYGEN, 'issue', '--key', privateKeyPath, '--to', 'Ikinci'],
      { encoding: 'utf8' },
    ).trim();

    for (const token of [first, second]) {
      const checked = license.check(token);
      expect(checked.ok).toBe(true);
      if (checked.ok) await license.install(token, checked.payload);
    }

    const rows = await db.withoutTenant('device-license', (tx) =>
      tx.query<{ count: string }>('SELECT count(*)::text AS count FROM public.license'),
    );
    expect(rows[0]?.count).toBe('1');

    const current = await license.current();
    if (current === null || 'invalid' in current) throw new Error('lisans okunamadı');
    expect(current.payload.to).toBe('Ikinci');
  });
});
