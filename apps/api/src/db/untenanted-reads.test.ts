import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Kiracı bağlamı OLMADAN kiracıya ait bir tablo okunuyor mu?
 *
 * ── BU KAPININ VAR OLMA SEBEBİ ──────────────────────────────────────────────────────────────
 *
 * Sahada ölçüldü, ve tek bir yer değil ALTI yerdi. Kendini zamanlayan her zincir — dizin turu,
 * yedek turu, yedek zamanlaması, gecikme taraması, çöp budama, uzak erişim yetkilendirmesi —
 * ilk halkasını açılışta kuruyor, ve altısı da kiracı listesini `withoutTenant` ile KİRACIYA AİT
 * bir tablodan okuyordu.
 *
 * RLS o sorguya SIFIR SATIR döndürüyor ve hata vermiyor: boş bir liste bir hata değil. Yani
 * döngüler hiç dönmüyor, hiçbir zincir kurulmuyor, ve tek bir günlük satırı bile çıkmıyordu.
 * Cihazda dizin turu saatlerce hiç koşmadı, kuyruk tamamen boştu, ve ağ sürücüsünden yazılan
 * 343 dosya arayüzde hiç görünmedi.
 *
 * Bu, bir tip denetiminin ya da sıradan bir birim testinin göremeyeceği bir hata sınıfı: kod
 * çalışıyor, sorgu başarılı, cevap boş. Onu görebilecek tek şey, KALIBIN KENDİSİNİ yasaklamak.
 *
 * ── MUAFİYETLER ─────────────────────────────────────────────────────────────────────────────
 *
 * Adla veriliyor, sayıyla değil: listeye katılan her tablo kendi cümlesini yazmak zorunda.
 */
describe('untenanted reads', () => {
  const EXEMPT = new Set([
    // Cihaz geneli, kiracı değil: `license_app_full` politikası `USING (true)`, yani bağlamsız
    // okuma burada tasarım gereği çalışıyor.
    'license',
  ]);

  it('never reads a tenant-scoped table without a tenant context', () => {
    const migrations = resolve(__dirname, '../../../../packages/db/migrations');
    const sql = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(migrations, name), 'utf8'))
      .join('\n');

    const tenantScoped = new Set(
      [...sql.matchAll(/ALTER TABLE\s+public\.(\w+)\s+ENABLE\s+ROW LEVEL SECURITY/g)].map(
        (m) => m[1] as string,
      ),
    );
    // Kontrol: göçler okunamadıysa bu test hiçbir şey ölçmez ve sessizce geçer.
    expect(tenantScoped.size).toBeGreaterThan(10);

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith('.ts') && !entry.name.includes('.test.')
            ? [join(dir, entry.name)]
            : [],
      );
    const sources = walk(resolve(__dirname, '..'));
    expect(sources.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const call of text.matchAll(/withoutTenant\(([\s\S]{0,3000}?)\n\s*\);/g)) {
        const body = call[1] as string;
        const tables = new Set(
          [...body.matchAll(/FROM\s+(?:public\.)?(\w+)/g)].map((m) => m[1] as string),
        );
        for (const table of tables) {
          if (tenantScoped.has(table) && !EXEMPT.has(table)) {
            offenders.push(`${file.split(/[\\/]/).slice(-2).join('/')} okuyor: ${table}`);
          }
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
