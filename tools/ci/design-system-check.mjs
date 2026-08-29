// Tasarım sistemi sayfası ÜRÜNÜN sözlüğünü mü gösteriyor.
//
// NEDEN VAR. `docs/tasarim-sistemi.html` stil dosyasını içe aktarıyor, kopyalamıyor — yani
// jetonlar ve görünüm kendiliğinden güncel kalıyor. Kendiliğinden güncel kalmayan tek şey SINIF
// ADLARI: bir sınıf `styles.css`ten silindiğinde ya da adı değiştiğinde, sayfa hiçbir şey
// söylemeden çizmeye devam eder ve artık var olmayan bir ürünü belgeler.
//
// Bu kontrol tam onu ölçüyor: sayfada geçen her sınıf adı stil dosyasında gerçekten tanımlı mı.
//
// TERSİ ÖLÇÜLMÜYOR ve bu bilinçli: stil dosyasındaki her sınıfın sayfada geçmesini şart koşmak,
// belgelenecek bir şeyi olmayan iç sınıfları belgelemeye zorlardı — ve zorlama belgeler,
// okunmayan belgelerdir.
import { readFileSync } from 'node:fs';

const PAGE = 'docs/tasarim-sistemi.html';
const SHEET = 'apps/web/src/styles.css';

const page = readFileSync(PAGE, 'utf8');
const sheet = readFileSync(SHEET, 'utf8');

// Sayfanın KENDİ iskeleti: `<style>` bloğunda tanımlanan sınıflar ürünün sözlüğü değil, bu
// sayfanın düzeni. Onları stil dosyasında aramak yanlış olurdu.
const own = new Set();
for (const block of page.matchAll(/<style>([\s\S]*?)<\/style>/gu)) {
  for (const match of (block[1] ?? '').matchAll(/\.([a-z][a-z0-9-]*)/giu)) {
    own.add(match[1]);
  }
}

const used = new Set();
for (const match of page.matchAll(/class="([^"]+)"/gu)) {
  for (const name of (match[1] ?? '').split(/\s+/u)) {
    if (name !== '') used.add(name);
  }
}

const defined = new Set();
for (const match of sheet.matchAll(/\.([a-zA-Z][\w-]*)/gu)) {
  defined.add(match[1]);
}

const missing = [...used].filter((name) => !defined.has(name) && !own.has(name)).sort();

if (missing.length > 0) {
  console.error(`${PAGE} artık var olmayan sınıfları gösteriyor:\n`);
  for (const name of missing) console.error(`  .${name}`);
  console.error(`\nYa ${SHEET} içinde bu sınıfları geri getirin ya da sayfayı düzeltin.`);
  console.error(
    'Ürünün sahip olmadığı bir görünümü belgeleyen bir sayfa, belge değil bir yalandır.',
  );
  process.exit(1);
}

console.log(`Tasarım sistemi sayfası güncel (${used.size} sınıf, hepsi ${SHEET} içinde tanımlı).`);
