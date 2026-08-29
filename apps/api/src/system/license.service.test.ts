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
let machineId: string;

function issue(...args: string[]): string {
  return execFileSync(
    process.execPath,
    [KEYGEN, 'issue', '--key', privateKeyPath, '--to', 'Ornek Musteri', ...args],
    { encoding: 'utf8' },
  ).trim();
}

function service(keyPath = publicKeyPath, machineIdPath = machineId): LicenseService {
  // `check` veritabanına hiç dokunmuyor; buraya bir sahte koymak, dokunmadığını da kanıtlıyor.
  return new LicenseService(null as unknown as DbService, keyPath, machineIdPath);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'depsis-license-'));
  execFileSync(process.execPath, [KEYGEN, 'init', dir], { encoding: 'utf8' });
  publicKeyPath = join(dir, 'license-key.pub');
  privateKeyPath = join(dir, 'depsis-license.key');
  // Sahte bir makine kimligi: cihaz kodu ondan TURETILIYOR, yani testin kendi kutusunun
  // kimligine bagli olmadan tekrarlanabilir.
  machineId = join(dir, 'machine-id');
  writeFileSync(machineId, 'af04e5981b2c4d5e8f9a0b1c2d3e4f50');
});

describe('LicenseService.check', () => {
  it('satıcı aracının ürettiği jetonu kabul eder ve içindekini okur', () => {
    const token = issue('--plan', 'ev', '--until', '2030-01-01');
    const result = service().check(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.to).toBe('Ornek Musteri');
    expect(result.payload.plan).toBe('ev');
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

  it('cihaz kodu KURULUMDAN turetiliyor ve kararli', () => {
    // Ayni makine kimligi -> ayni kod, her zaman. Farkli kimlik -> farkli kod.
    const mine = service().deviceId();
    expect(mine).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    expect(service().deviceId()).toBe(mine);

    const other = join(dir, 'machine-id-2');
    writeFileSync(other, 'ffffffffffffffffffffffffffffffff');
    expect(service(publicKeyPath, other).deviceId()).not.toBe(mine);
  });

  it('cihaz kodu makine kimliginin KENDISI degil', () => {
    // Makine kimligi sistem genelinde bir parmak izi; oldugu gibi paylasilmamali.
    const raw = readFileSync(machineId, 'utf8').trim();
    expect(service().deviceId()).not.toContain(raw.slice(0, 8));
  });

  it('BU cihaza bagli lisansi kabul eder', () => {
    const code = service().deviceId();
    const token = issue('--device', code ?? '');
    expect(service().check(token).ok).toBe(true);
  });

  it('BASKA bir cihaza bagli lisansi reddeder ve iki kodu da soyler', () => {
    // Bagin var olma sebebi bu tek iddia.
    const token = issue('--device', 'AAAA-BBBB-CCCC');
    const result = service().check(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('AAAA-BBBB-CCCC');
      expect(result.reason).toContain(service().deviceId() ?? '');
    }
  });

  it('bagsiz lisans her cihazda gecerli', () => {
    // Toplu havuzdan cikan jetonlar boyle: bag, uretilirken konur.
    const token = issue();
    const other = join(dir, 'machine-id-3');
    writeFileSync(other, '11111111111111111111111111111111');
    expect(service(publicKeyPath, other).check(token).ok).toBe(true);
  });

  it('cihaz kimligi okunamiyorsa BAGLI bir lisans reddedilir', () => {
    // Guvenli yon: "okuyamadim" ile "uyuyor" arasinda gecis yapmak bagi anlamsiz kilardi.
    const code = service().deviceId();
    const token = issue('--device', code ?? '');
    const result = service(publicKeyPath, join(dir, 'olmayan-machine-id')).check(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('okunamıyor');
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
