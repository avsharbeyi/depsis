// Tasarım sistemi sayfası ÜRÜNÜN sözlüğünü mü gösteriyor.
//
// NEDEN VAR. `docs/tasarim-sistemi.html` stil dosyasını içe aktarıyor, kopyalamıyor — yani
// jetonlar ve görünüm kendiliğinden güncel kalıyor. Kendiliğinden güncel kalmayan tek şey SINIF
// ADLARI: bir sınıf `styles.css`ten silindiğinde ya da adı değiştiğinde, sayfa hiçbir şey
// söylemeden çizmeye devam eder ve artık var olmayan bir ürünü belgeler.
//
// Bu kontrol tam onu ölçüyor: sayfada geçen her sınıf adı stil dosyasında gerçekten tanımlı mı —
// ve tanımlı olanlar sayfada GÖRÜNÜYOR mu (aşağıdaki "çiziliyor mu" bölümü; tanımlı ama
// `display: none` bir sınıf, adı bulunduğu için ilk kontrolden geçiyordu).
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
// Sınıf ADLARI kadar, birlikte yazıldıkları GRUPLAR da tutuluyor: aşağıdaki görünürlük kontrolü
// "bu öğede `.ghost` ile birlikte `.on` var mı" diye soruyor, ve o soru yalnız grup düzeyinde
// cevaplanabiliyor.
const groups = [];
for (const match of page.matchAll(/class="([^"]+)"/gu)) {
  const group = (match[1] ?? '').split(/\s+/u).filter((name) => name !== '');
  for (const name of group) used.add(name);
  if (group.length > 0) groups.push(group);
}

const defined = new Set();
for (const match of sheet.matchAll(/\.([a-zA-Z][\w-]*)/gu)) {
  defined.add(match[1]);
}

// ── ÇİZİLİYOR MU ────────────────────────────────────────────────────────────
//
// Sınıfın tanımlı olması, sayfada GÖRÜNDÜĞÜ anlamına gelmiyor. Sayfa bir zamanlar ikincil düğmeyi
// `class="b ghost"` ile gösteriyordu; `.ghost` ürünün kısayol sürükleme hedefi ve `display: none`
// taşıyor, yani o düğme hiç çizilmiyordu — ve yukarıdaki ad kontrolü `.ghost` stil dosyasında
// geçtiği için geçiyordu. Ürünün sahip olmadığı bir görünümü belgeleyen sayfa ile hiçbir şey
// göstermeyen sayfa aynı kapıdan geçemez.
//
// Ölçü: stil dosyasında `.x { … display: none … }` diye TEK BAŞINA tanımlanmış bir sınıf, ancak
// aynı öğedeki başka bir sınıfla birleşen bir kural (`.x.on`) onu geri açıyorsa görünürdür.
//
// Kurallar bir TARAYICIYLA çıkarılıyor, düz bir kalıpla değil, ve iki sebebi var. Seçicinin
// önündeki yorum bloğu — bu dosyada her kuralın önünde bir tane var — kalıba dahil olup seçiciyi
// tanınmaz yapıyordu. Ve `@media` blokları: içlerindeki `display: none` yalnız o genişlikte
// geçerli, yani onu "hiç çizilmiyor" saymak yanlış bir kırmızı olurdu. `{` ile açılan blok
// derinliği sayıldığında ikisi de kendiliğinden çözülüyor: yalnız ÜST DÜZEY ve `@` ile
// başlamayan kurallar okunuyor.
function topLevelRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      if (depth === 0) selector = css.slice(start, index);
      depth += 1;
      if (depth === 1) start = index + 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push([selector, css.slice(start, index)]);
        start = index + 1;
      }
    }
  }
  return rules;
}

const hidden = new Set();
const revives = [];
for (const [selectors, body] of topLevelRules(sheet.replace(/\/\*[\s\S]*?\*\//gu, ''))) {
  if (selectors.trim().startsWith('@')) continue;
  const hides = /display\s*:\s*none/u.test(body);
  const shows = /display\s*:\s*(?!none)[a-z-]+/u.test(body);
  for (const selector of selectors.split(',')) {
    const single = selector.trim().match(/^\.([a-zA-Z][\w-]*)$/u);
    if (single !== null && hides) hidden.add(single[1]);
    // `.x.on { display: block }` gibi bir kural, `.x`i o eşlikçiyle birlikte geri açıyor.
    const paired = selector.trim().match(/^\.([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)$/u);
    if (paired !== null && shows) {
      revives.push([paired[1], paired[2]]);
      revives.push([paired[2], paired[1]]);
    }
  }
}

const invisible = [];
for (const group of groups) {
  for (const name of group) {
    if (!hidden.has(name) || own.has(name)) continue;
    const opened = revives.some(([base, mate]) => base === name && group.includes(mate));
    if (!opened) invisible.push([name, group.join(' ')]);
  }
}

const missing = [...used].filter((name) => !defined.has(name) && !own.has(name)).sort();

if (invisible.length > 0) {
  console.error(`${PAGE} çizilmeyen bir şeyi gösteriyor:\n`);
  for (const [name, group] of invisible) {
    console.error(`  class="${group}" — .${name} ${SHEET} içinde display:none`);
  }
  console.error('\nBu öğe sayfada hiç görünmüyor. Doğru sınıfı kullanın ya da öğeyi kaldırın.');
  console.error(
    'Ürünün sahip olmadığı bir görünümü belgeleyen bir sayfa, belge değil bir yalandır.',
  );
  process.exit(1);
}

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
