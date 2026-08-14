# PoC koşum kanıtları

Bu dizin, ADR'lerde `unverified` işaretlenmiş davranışsal iddiaların **gerçek koşum çıktılarını**
tutar. ADR kuralı gereği (bkz. [`../README.md`](../README.md) §4) belge kanıt değildir; mimariyi
bağlayan bir davranış ancak burada bir koşum dosyası varsa `Accepted` sayılır.

Biçim: satır başına bir assertion, sekmeyle ayrılmış —
`poc_id · PASS|FAIL|UNEXPECTED|NOTE · açıklama · ayrıntı`

## Koşulanlar

| Kanıt | ADR | Ortam | Sonuç |
|---|---|---|---|
| [`p0-c.tsv`](p0-c.tsv) | [ADR-0013](../0013-postgres-version-and-tenancy.md) | WSL2 Debian 13 trixie, PostgreSQL 18.6-1.pgdg13+2 | 45 PASS / 0 FAIL |
| [`p0-h.tsv`](p0-h.tsv) | [ADR-0010](../0010-search-architecture.md) | aynı | 22 PASS / 0 FAIL |

### Ortam notu — neden WSL2, neden yeterli

Bu iki PoC yalnız PostgreSQL'e dokunuyor: ZFS, Samba veya çekirdek davranışı test etmiyorlar.
Bu yüzden Hyper-V PoC VM'i beklemeden, tek amaçlı ve atılabilir bir WSL2 Debian 13 dağıtımında
(`depsis-pgtest`) koşuldular. Sürüm eşleşmesi tam: hedef platformla aynı Debian majoru ve
ADR-0013'ün seçtiği PGDG PostgreSQL 18.6.

**Bu ortamda P0-A, P0-B, P0-D ve P0-G koşulamaz** — ZFS ve Samba yok, sonuçları anlamsız olurdu.
Dağıtımın içindeki `/etc/depsis-poc-build.json` bunu açıkça yazar.

## Bu koşularda ortaya çıkan ve düzeltilen üç şey

**1. `unaccent` şema niteleyicisi (ADR-0010).** Sinsi olanı buydu. Niteliksiz
`unaccent('unaccent', …)` düz sorguda çalışıyor, `GENERATED STORED` kolonda çalışıyor, hatta
fonksiyonun oluşturulduğu oturumda ifade indeksi kurmaya bile izin veriyor. **Yalnız ayrı bir
oturumda `CREATE INDEX` yapılırken** patlıyor, çünkü PostgreSQL indeks kurulumu sırasında
`search_path`'i kısıtlıyor ve `public` aranmıyor. Migration'lar tam olarak öyle çalışır — yani
bu, üretime kadar gizlenip orada çıkacak bir hataydı. Ölçülen davranış ADR-0010'da tabloya
işlendi; düzeltme `public.unaccent('public.unaccent'::regdictionary, …)`.

**2. Sayacı boolean sanmak (P0-C).** `uuidv7()` kontrolü tam olarak 1 bekliyordu; PG 18'de iki
overload var (`uuidv7()` ve `uuidv7(interval)`). Test doğru sunucuda başarısız oluyordu — ve
daha kötüsü, aynı `= 1` karşılaştırması şemayı sessizce `gen_random_uuid()`'ye düşürüyordu.
Yani PoC, doğrulamayı iddia ettiği şeyi kullanmadan koşuyordu.

**3. Yanlış şeyi iddia etmek (P0-H).** Prefix testi planlayıcının B-tree'yi **seçmesini** şart
koşuyordu. 20 bin satırlık korpusta `'i%'` satırların dörtte birini eşliyor ve `LIMIT 50` ile
sıralı tarama gerçekten daha ucuz — planlayıcı haklıydı. Mimari iddia "planlayıcı hep seçer"
değil, "**indeks bu sorgu biçimine hizmet edebilir**". Test artık kullanılabilirliği
`enable_seqscan = off` ile kanıtlıyor, planlayıcının doğal seçimini ise ölçüm olarak kaydediyor.

## Ampirik olarak doğrulanan başlıca iddialar

- PG 18.6'da `uuidv7()` **var** (iki overload) → ADR-0013 §1
- `ENABLE ROW LEVEL SECURITY` tek başına yetmiyor: tablo sahibi kiracı bağlamına rağmen
  **dört satırın hepsini** gördü; `FORCE` sonrası ikiye indi → ADR-0013 §2.1
- Kısıt covert channel'ı **üretildi**: global `UNIQUE(name)` altında kiracı A, göremediği bir
  satırın adını 23505 hatasından öğrendi. `UNIQUE (organization_id, parent_id, name)` ile
  kapandı → ADR-0013 §2.2
- Bağlamsız sorgu **sıfır satır** döndürüyor (fail-closed); `SET LOCAL` COMMIT'te temizleniyor,
  düz `SET` **sızdırıyor** → session pooling kullanılamaz
- `SKIP LOCKED` ile iki eşzamanlı worker farklı işler aldı, ikincisi bloklanmadı → ADR-0003
- Türkçe: `İstanbul/istanbul/ISTANBUL/Istanbul/ıstanbul` tek kovaya düşüyor; düz `lower()` ise
  **ikiye bölüyor** — `depsis_norm`'un varlık sebebi ölçülerek gösterildi
- `'cagri'` yazmak `Çağrı` satırlarını buluyor; `ILIKE` hiç bulamıyor (harf çevirisi değil,
  büyük/küçük harf katlaması olduğu için) → ADR-0010

## Süperkullanıcı notu

P0-C, `FORCE` altında bile bir **superuser'ın** tüm satırları gördüğünü kaydediyor. Bu
belgelenmiş ve kaçınılmaz; DEPSIS uygulaması hiçbir koşulda superuser olarak bağlanmaz
(ADR-0013 §2.1 rol ayrımı). Tehdit modelinde kalıntı risk olarak durur.
