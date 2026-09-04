#!/usr/bin/env node
//
// Lisans verme — soru sorarak.
//
// ── neden var ────────────────────────────────────────────────────────────────
//
// `keygen.mjs` doğru araç ama ham: uzun bir komut satırı, dört bayrak, ve anahtarın tam yolu. Bir
// satış anında, müşterinin yanında, o komutu doğru yazmak gereksiz bir risk — yanlış yazılan bir
// `--until` ya da eksik bir `--device`, ancak müşteri lisansı kuramadığında fark edilir.
//
// Bu betik aynı işi yapıyor, İKİ SORU sorarak. Anahtarı kendisi buluyor, cevapları doğruluyor,
// ürettiği jetonu doğruluyor, ve ne verdiğini bir deftere yazıyor.
//
// İKİ SORU, çünkü mekanik olarak iş yapan alan iki tane: İMZA (jetonun satıcıdan geldiğini
// kanıtlıyor) ve CİHAZ KODU (bu kutuya mı verilmiş). Müşteri adı ve plan hiçbir şeyle
// karşılaştırılmıyordu — yalnız ekranda görünüyorlardı. `keygen.mjs` onları hâlâ kabul
// ediyor (`--to`, `--plan`); sorulmuyorlar.
//
// ── defter ───────────────────────────────────────────────────────────────────
//
// `lisans-defteri.csv`, anahtarın yanında. Bugüne kadar hiçbir yerde tutulmuyordu: bir lisansın
// hangi cihaza ve ne zaman verildiği sorulduğunda bakılacak tek yer burası. Kimliği taşıyan
// alan CİHAZ KODU — müşteri adından farklı olarak, o gerçekten bir kutuyu adlandırıyor.
// Satırlar EKLENİR, hiç silinmez.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYGEN = join(HERE, 'keygen.mjs');

/** Özel anahtarı, bakılacak yerlerde sırayla arar. */
function findKey() {
  const candidates = [
    process.env['DEPSIS_LICENSE_KEY'],
    join(
      process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
      'Desktop',
      'depsis-anahtarlar',
      'depsis-license.key',
    ),
    join(
      process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
      'depsis-anahtarlar',
      'depsis-license.key',
    ),
    join(HERE, 'depsis-license.key'),
  ].filter((path) => typeof path === 'string' && path !== '');

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * SORU SORAN taraf, ve BORULANMIŞ girdiyle de çalışan taraf.
 *
 * `readline`in soru-cevabı bir uçbirim içindir; girdi bir borudan geliyorsa (bir betik ya da bir
 * test bu aracı sürüyorsa) satırlar bir anda gelir ve bekleyen sorular hiç cevaplanmaz — ilk
 * denemede tam bu oldu. O yüzden uçbirim yoksa satırlar önden okunup sıraya konuyor.
 */
function ask(rl, question, { required = false, check } = {}) {
  return (async function loop() {
    let answer;
    if (queued === null) {
      answer = (await rl.question(question)).trim();
    } else {
      answer = (queued.shift() ?? '').trim();
      process.stdout.write(`${question}${answer}` + String.fromCharCode(10));
    }
    if (answer === '') {
      if (!required) return '';
      console.log('  → bu alan boş bırakılamaz.');
      return loop();
    }
    if (check !== undefined) {
      const problem = check(answer);
      if (problem !== null) {
        console.log(`  → ${problem}`);
        return loop();
      }
    }
    return answer;
  })();
}

const keyPath = findKey();
if (keyPath === null) {
  console.error('Lisans özel anahtarı bulunamadı.');
  console.error('Beklenen yer: Masaüstü\\depsis-anahtarlar\\depsis-license.key');
  console.error('Yoksa bir kez üretin:  node tools/license/keygen.mjs init <dizin>');
  process.exit(1);
}

// Uçbirim yoksa girdinin tamamı önden okunuyor; varsa `readline` sorularını sorar.
const queued = process.stdin.isTTY === true ? null : readFileSync(0, 'utf8').split(/\r?\n/u);
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log('');
console.log('  DEPSIS — lisans ver');
console.log(`  anahtar: ${keyPath}`);
console.log('');

console.log('  Cihaz kodu, kutunun Sistem ekranındaki Lisans bölümünde yazıyor.');
console.log('  Boş bırakırsanız lisans HER cihazda çalışır (deneme/bayi için).');
const device = await ask(rl, '  Cihaz kodu (XXXX-XXXX-XXXX, boş=serbest) : ', {
  check: (value) =>
    value.toUpperCase().replace(/[^A-Z0-9]/gu, '').length === 12
      ? null
      : 'on iki harf/rakam bekleniyor, örn. ACNB-HVGU-D9XU',
});

console.log('');
const until = await ask(rl, '  Bitiş tarihi (YYYY-AA-GG, boş=süresiz) : ', {
  check: (value) =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value))
      ? null
      : 'tarih biçimi 2027-12-31 gibi olmalı',
});

rl.close();

const args = [KEYGEN, 'issue', '--key', keyPath];
if (device !== '') args.push('--device', device);
if (until !== '') args.push('--until', until);

let token;
try {
  token = execFileSync(process.execPath, args, { encoding: 'utf8' }).trim();
} catch (error) {
  console.error('');
  console.error('Lisans üretilemedi.');
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

// DEFTERE YAZ. Bir müşteri "lisansımı kaybettim" dediğinde bakılacak tek yer burası.
const ledger = join(dirname(keyPath), 'lisans-defteri.csv');
if (!existsSync(ledger)) {
  appendFileSync(ledger, 'tarih,cihaz,bitis,jeton\n');
}
const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
appendFileSync(
  ledger,
  [
    cell(new Date().toISOString()),
    cell(device === '' ? '(serbest)' : device),
    cell(until === '' ? '(süresiz)' : until),
    cell(token),
  ].join(',') + '\n',
);

console.log('');
console.log('  ── LİSANS ANAHTARI ──────────────────────────────────────────');
console.log('');
console.log(token);
console.log('');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('');
console.log('  Bunu müşterinin cihazında: Sistem → Lisans → "Lisans anahtarı gir"');
console.log(`  Deftere yazıldı: ${ledger}`);
if (device === '') {
  console.log('');
  console.log(
    '  NOT: bu lisans bir cihaza BAĞLI DEĞİL, kopyalanıp başka kutuda da kullanılabilir.',
  );
}
console.log('');

// Anahtarın gerçekten okunabildiğini teyit etmenin bedeli sıfır, ve yanlış anahtarla üretilmiş
// bir jetonu ancak müşteri fark ederdi.
// İKİ dosyanın da varlığı kontrol ediliyor. Eskiden yalnız depodaki `shipped` bakılıyor, özel
// anahtarın YANINDAKİ .pub doğrudan readFileSync ile okunuyordu: satıcı anahtarı
// DEPSIS_LICENSE_KEY ile başka bir dizinden gösterdiğinde ya da yalnız .key dosyasını kopyaladığında
// burası ENOENT ile çöküyordu — jeton çoktan basılmış ve deftere yazılmış olduğu hâlde. Satıcı
// işlemin düştüğünü sanıp ikinci kez üretiyor ve defterde aynı cihaz için iki jeton kalıyordu.
const shipped = join(HERE, '..', '..', 'deploy', 'release', 'license-key.pub');
const minePath = join(dirname(keyPath), 'license-key.pub');
if (existsSync(shipped) && existsSync(minePath)) {
  const mine = readFileSync(minePath, 'utf8').trim();
  if (mine !== readFileSync(shipped, 'utf8').trim()) {
    console.log('  UYARI: buradaki açık anahtar, cihazlara giden açık anahtarla AYNI DEĞİL.');
    console.log(
      '  Bu lisansı hiçbir cihaz doğrulayamaz. deploy/release/license-key.pub kontrol edin.',
    );
    console.log('');
  }
} else if (existsSync(shipped)) {
  console.log(`  NOT: anahtarın yanında license-key.pub yok (${minePath}),`);
  console.log('  cihazlara giden açık anahtarla karşılaştırma yapılamadı.');
  console.log('');
}
