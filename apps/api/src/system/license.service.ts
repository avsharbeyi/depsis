import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Injectable } from '@nestjs/common';

import { DbService } from '../db/db.service.js';

/** Jetonun biçim sürümü — `tools/license/keygen.mjs` ile aynı sayı. */
const VERSION = 1;
const PREFIX = 'DEPSIS';

export interface LicensePayload {
  id: string;
  to: string;
  plan: string | null;
  seats: number | null;
  issued: string;
  until: string | null;
  note: string | null;
}

export type LicenseCheck = { ok: true; payload: LicensePayload } | { ok: false; reason: string };

/**
 * Cihazın lisansı: doğrulanması ve saklanması.
 *
 * ÇEVRİMDIŞI DOĞRULAMA. Lisans anahtarı imzalı bir veri; cihaz onu internete çıkmadan, elindeki
 * açık anahtarla doğruluyor. Bir NAS'ın interneti olmayabilir, ve olsa bile müşterinin cihazının
 * satıcıya rapor vermesi bu ürünün mahremiyet duruşuna aykırı olurdu.
 *
 * NE ZORLAMIYOR, ve bu bilinçli: süresi dolmuş bir lisans ekranda söylenir, kimseyi kendi
 * dosyalarından KİLİTLEMEZ. Bir yedekleme cihazını bir takvim gününde kullanılamaz hâle getirmek,
 * verinin kendisini rehin almaktır — ve bu ürünün var olma sebebiyle çelişir. Zorlama isteniyorsa
 * bu ayrı ve bilinçli bir karardır; burada varsayılan olarak alınmadı.
 *
 * DOĞRUNUN KAYNAĞI JETON. Ayrıştırılmış alanlar tabloda duruyor ama her okumada imza yeniden
 * doğrulanıyor: veritabanına yazabilen biri kendine lisans uyduramasın.
 */
@Injectable()
export class LicenseService {
  constructor(
    private readonly db: DbService,
    /** Açık anahtarın yolu. Dosya yoksa lisans YAPILANDIRILMAMIŞ sayılır. */
    private readonly publicKeyPath: string,
  ) {}

  /**
   * Açık anahtar HER ÇAĞRIDA okunuyor, önbelleğe alınmıyor.
   *
   * Dosya kurulum sırasında yerine konuyor ve bir güncelleme onu yenileyebiliyor; açılışta bir kez
   * okunsaydı, anahtarı değişen bir kutu yeniden başlatılana kadar eski anahtarla doğrulardı.
   * Maliyeti birkaç yüz baytlık bir dosya okuması.
   */
  private publicKey(): string | null {
    try {
      return readFileSync(this.publicKeyPath, 'utf8');
    } catch {
      return null;
    }
  }

  configured(): boolean {
    return this.publicKey() !== null;
  }

  /**
   * Jetonu doğrular. `keygen.mjs`'in `verify`i ile AYNI adımlar, aynı sırayla.
   *
   * İmza, JSON'un değil base64url METNİNİN üzerinde: JSON'u yeniden serileştirip imzalamak,
   * doğrulayan tarafın anahtar sırasını ve boşlukları bire bir aynı üretmesini gerektirirdi.
   */
  check(token: string): LicenseCheck {
    const key = this.publicKey();
    if (key === null) {
      return { ok: false, reason: 'bu cihazda lisans açık anahtarı kurulu değil' };
    }
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== `${PREFIX}-${VERSION}`) {
      return { ok: false, reason: 'lisans anahtarının biçimi tanınmadı' };
    }
    const payloadB64 = parts[1] ?? '';
    const signatureB64 = parts[2] ?? '';

    let valid: boolean;
    try {
      valid = verify(
        null,
        Buffer.from(payloadB64, 'ascii'),
        createPublicKey(key),
        Buffer.from(signatureB64, 'base64url'),
      );
    } catch {
      return { ok: false, reason: 'lisans anahtarının imzası okunamadı' };
    }
    if (!valid) return { ok: false, reason: 'lisans anahtarının imzası tutmuyor' };

    let payload: LicensePayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as LicensePayload;
    } catch {
      return { ok: false, reason: 'lisans anahtarının içeriği okunamadı' };
    }
    if (typeof payload.to !== 'string' || payload.to === '' || typeof payload.id !== 'string') {
      return { ok: false, reason: 'lisans anahtarı kime verildiğini söylemiyor' };
    }
    return { ok: true, payload };
  }

  /** Kurulu lisans, HER OKUMADA yeniden doğrulanmış hâliyle. */
  async current(): Promise<
    { token: string; payload: LicensePayload; installedAt: string } | { invalid: string } | null
  > {
    const rows = await this.db.withoutTenant('device-license', (db) =>
      db.query<{ token: string; installed_at: Date }>(
        'SELECT token, installed_at FROM public.license WHERE id = true',
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const result = this.check(row.token);
    if (!result.ok) return { invalid: result.reason };
    return {
      token: row.token,
      payload: result.payload,
      installedAt: row.installed_at.toISOString(),
    };
  }

  /** Doğrulanmış bir lisansı yerine koyar. Tek satır, bu yüzden UPSERT. */
  async install(token: string, payload: LicensePayload): Promise<void> {
    await this.db.withoutTenant('device-license', (db) =>
      db.query(
        `INSERT INTO public.license
         (id, token, license_id, licensed_to, plan, seats, issued_at, expires_at)
       VALUES (true, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         token = EXCLUDED.token,
         license_id = EXCLUDED.license_id,
         licensed_to = EXCLUDED.licensed_to,
         plan = EXCLUDED.plan,
         seats = EXCLUDED.seats,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         installed_at = now()`,
        [
          token.trim(),
          payload.id,
          payload.to,
          payload.plan,
          payload.seats,
          payload.issued,
          payload.until,
        ],
      ),
    );
  }
}
