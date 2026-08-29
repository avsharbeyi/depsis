import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { DbService } from '../db/db.service.js';
import { LicenseService } from './license.service.js';

/**
 * Lisans doğrulaması — SATICI ARACININ ÜRETTİĞİ jetonla.
 *
 * Bu süitin şekli bir karardan geliyor. Doğrulamayı elle imzalanmış bir jetonla sınamak kolay
 * olurdu ve YANLIŞ olurdu: gerçek risk imza matematiği değil, iki uygulamanın AYRIŞMASI —
 * `keygen.mjs` bir gün alan sırasını ya da kodlamayı değiştirir, cihaz doğrulamayı yapamaz, ve
 * bunu ilk öğrenen müşteri olur. O yüzden jetonu burada gerçek araç üretiyor.
 *
 * Veritabanına dokunulmuyor: `check` saf bir işlev, ve saklama yolu ayrı bir şey.
 */

const KEYGEN = join(process.cwd(), '..', '..', 'tools', 'license', 'keygen.mjs');

let dir: string;
let publicKeyPath: string;
let privateKeyPath: string;

function issue(...args: string[]): string {
  return execFileSync(
    process.execPath,
    [KEYGEN, 'issue', '--key', privateKeyPath, '--to', 'Ornek Musteri', ...args],
    { encoding: 'utf8' },
  ).trim();
}

function service(keyPath = publicKeyPath): LicenseService {
  // `check` veritabanına hiç dokunmuyor; buraya bir sahte koymak, dokunmadığını da kanıtlıyor.
  return new LicenseService(null as unknown as DbService, keyPath);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'depsis-license-'));
  execFileSync(process.execPath, [KEYGEN, 'init', dir], { encoding: 'utf8' });
  publicKeyPath = join(dir, 'license-key.pub');
  privateKeyPath = join(dir, 'depsis-license.key');
});

describe('LicenseService.check', () => {
  it('satıcı aracının ürettiği jetonu kabul eder ve içindekini okur', () => {
    const token = issue('--plan', 'ev', '--seats', '5', '--until', '2030-01-01');
    const result = service().check(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.to).toBe('Ornek Musteri');
    expect(result.payload.plan).toBe('ev');
    expect(result.payload.seats).toBe(5);
    expect(result.payload.until).not.toBeNull();
  });

  it('süresiz lisansta `until` NULL, bir tarih değil', () => {
    // "Hiç dolmayacak" bir tarih yazmak, o tarihe gelindiğinde açıklanamayan bir arıza üretir.
    const result = service().check(issue());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.until).toBeNull();
  });

  it('İÇERİĞİ DEĞİŞTİRİLMİŞ jetonu reddeder', () => {
    // Lisansın var olma sebebi bu tek iddia: müşteri kendi jetonundaki tarihi ileri alamamalı.
    const token = issue('--until', '2027-01-01');
    const [prefix, payloadB64, signature] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    payload['until'] = '2099-12-31T23:59:59.000Z';
    const forged = [
      prefix,
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      signature,
    ].join('.');

    const result = service().check(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('imza');
  });

  it('BAŞKA BİR ANAHTARLA imzalanmış jetonu reddeder', () => {
    // Kendi keygen'ini çalıştıran birinin ürettiği jeton. Anahtar satıcıda olduğu sürece geçmez.
    const other = mkdtempSync(join(tmpdir(), 'depsis-sahte-'));
    execFileSync(process.execPath, [KEYGEN, 'init', other], { encoding: 'utf8' });
    const foreign = execFileSync(
      process.execPath,
      [KEYGEN, 'issue', '--key', join(other, 'depsis-license.key'), '--to', 'Korsan'],
      { encoding: 'utf8' },
    ).trim();

    const result = service().check(foreign);
    expect(result.ok).toBe(false);
  });

  it('tanınmayan biçimi, imzayı hiç denemeden reddeder', () => {
    for (const junk of ['', 'DEPSIS-1', 'DEPSIS-9.aaa.bbb', 'bir kelime', 'a.b.c']) {
      expect(service().check(junk).ok).toBe(false);
    }
  });

  it('açık anahtar yoksa bunu AYRI bir cevap olarak söyler', () => {
    // "Anahtar yok" ile "imza tutmuyor" iki ayrı sorun; ikincisini birinciye karıştırmak,
    // kurulumu eksik bir kutuyu sahte lisans denenmiş bir kutu gibi gösterirdi.
    const result = service(join(dir, 'olmayan.pub')).check(issue());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('kurulu değil');
  });

  it('bozuk bir açık anahtar dosyası çökmez, reddeder', () => {
    const broken = join(dir, 'bozuk.pub');
    writeFileSync(broken, 'bu bir anahtar değil');
    expect(service(broken).check(issue()).ok).toBe(false);
  });

  it('depodaki açık anahtar gerçek bir açık anahtar', () => {
    // `deploy/release/license-key.pub` cihazlara giden dosya. Bozuk ya da yanlışlıkla ÖZEL anahtar
    // konmuş olsaydı, bunu ilk fark eden müşteri olurdu.
    const shipped = readFileSync(
      join(process.cwd(), '..', '..', 'deploy', 'release', 'license-key.pub'),
      'utf8',
    );
    expect(shipped).toContain('PUBLIC KEY');
    expect(shipped).not.toContain('PRIVATE');
  });
});
