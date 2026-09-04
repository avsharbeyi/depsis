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
 * ── KAPININ KENDİSİ İKİ YERDEN KAÇIRIYORDU ──────────────────────────────────────────────────
 *
 * Ölçüldü, ve ikisi de tam olarak kapının var olma sebebi olan kalıptı.
 *
 * BİRİNCİSİ, GÖVDENİN SINIRI. Gövde `withoutTenant\(([\s\S]{0,3000}?)\n\s*\);` ile alınıyordu,
 * yani çağrının `\n  );` ile bitmesine dayanıyordu. Süslü parantezli bir gövde — `async (q) => {
 * ... }` — ilk `\n      );`de kesiliyor: `jobs.service.ts`teki çağrının yakalanan gövdesi 181
 * karakterdi, geri kalanı hiç taranmadı. Artık sınır DENGELİ PARANTEZ sayılarak bulunuyor, ve
 * bulunan gövde sayısı ham `withoutTenant(` sayısıyla karşılaştırılıyor: tarama bir çağrıyı
 * atlarsa test bunu söylüyor.
 *
 * İKİNCİSİ, YALNIZ `FROM`. `SELECT s.id FROM public.jobs j JOIN public.shares s ON …` gövdesinde
 * regex yalnız `jobs`ı görüyordu; RLS'in sıfır satır döndüreceği tablo ise `shares`tı. Bağlamsız
 * bir YAZMA da aynı şekilde sessizce sıfır satır etkiler, o yüzden `UPDATE`, `INSERT INTO` ve
 * `DELETE FROM` de taranıyor.
 *
 * ── MUAFİYETLER ─────────────────────────────────────────────────────────────────────────────
 *
 * Adla veriliyor, sayıyla değil: listeye katılan her tablo kendi cümlesini yazmak zorunda.
 */

const EXEMPT = new Set([
  // Cihaz geneli, kiracı değil: `license_app_full` politikası `USING (true)`, yani bağlamsız
  // okuma burada tasarım gereği çalışıyor.
  'license',
]);

/** Kiracı tablosuna dokunan her deyim, yalnız okuyanlar değil. */
const TOUCHES = /(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?(\w+)/gi;

const CALL = 'withoutTenant(';

/**
 * Her `withoutTenant(` çağrısının gövdesi, açılış parantezinden eşleşen kapanışa kadar.
 *
 * Parantez sayarak, bir bitiş kalıbına güvenerek değil: gövde bir ok ifadesi de olabilir, süslü
 * parantezli bir blok da, ve ikincisinde metinsel bir kalıp gövdenin ortasında kesiliyordu.
 */
export function untenantedBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let at = text.indexOf(CALL); at !== -1; at = text.indexOf(CALL, at + 1)) {
    const start = at + CALL.length;
    let depth = 0;
    for (let i = start - 1; i < text.length; i += 1) {
      const char = text[i];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(text.slice(start, i));
          break;
        }
      }
    }
  }
  return bodies;
}

/** Bir gövdenin dokunduğu tablo adları. */
export function tablesTouched(body: string): Set<string> {
  return new Set([...body.matchAll(TOUCHES)].map((match) => (match[1] as string).toLowerCase()));
}

describe('the gate itself', () => {
  it('sees a JOINed table, not only the first FROM', () => {
    // Kaçırılan kalıp buydu: RLS'in sıfır satır döndüreceği tablo `shares`, ve eski regex yalnız
    // `jobs`ı görüyordu. Sorgu başarılı, cevap boş, hata yok.
    const body = `'job-queue-worker', (q) =>
      q.query(\`SELECT s.name FROM public.jobs j JOIN public.shares s ON s.id = j.share_id\`)`;
    expect(tablesTouched(body).has('shares')).toBe(true);
  });

  it('sees a WRITE, which fails just as silently', () => {
    expect(tablesTouched(`q.query('UPDATE public.shares SET name = $1')`).has('shares')).toBe(true);
    expect(tablesTouched(`q.query('DELETE FROM shares WHERE id = $1')`).has('shares')).toBe(true);
    const inserted = tablesTouched(`q.query('INSERT INTO public.shares (name) VALUES ($1)')`);
    expect(inserted.has('shares')).toBe(true);
  });

  it('reads a brace-bodied call to its end', () => {
    // Metinsel sınır bunu ilk `\n  );`de kesiyordu ve gövdenin yarısı hiç taranmıyordu.
    const source = `await this.db.withoutTenant('job-queue-worker', async (q) => {
      const rows = await q.query(
        \`SELECT 1\`,
      );
      if (rows.length === 0) await q.query(\`SELECT id FROM public.shares\`);
    });`;
    const [body] = untenantedBodies(source);
    expect(body).toBeDefined();
    expect(tablesTouched(body as string).has('shares')).toBe(true);
  });
});

describe('untenanted reads', () => {
  it('never touches a tenant-scoped table without a tenant context', () => {
    const migrations = resolve(__dirname, '../../../../packages/db/migrations');
    const sql = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(migrations, name), 'utf8'))
      .join('\n');

    const tenantScoped = new Set(
      [...sql.matchAll(/ALTER TABLE\s+public\.(\w+)\s+ENABLE\s+ROW LEVEL SECURITY/g)].map((m) =>
        (m[1] as string).toLowerCase(),
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
    let calls = 0;
    let scanned = 0;
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      calls += text.split(CALL).length - 1;
      for (const body of untenantedBodies(text)) {
        scanned += 1;
        for (const table of tablesTouched(body)) {
          if (tenantScoped.has(table) && !EXEMPT.has(table)) {
            offenders.push(`${file.split(/[\\/]/).slice(-2).join('/')} dokunuyor: ${table}`);
          }
        }
      }
    }

    // Taranan çağrı sayısı ham sayıya eşit olmalı: eşit değilse gövdelerden biri hiç okunmadı ve
    // boş bir `offenders` listesi hiçbir şey kanıtlamaz.
    expect(scanned, 'bir withoutTenant çağrısının gövdesi taranamadı').toBe(calls);
    expect(calls).toBeGreaterThan(10);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
