#!/usr/bin/env node
//
// DEPSIS lisans anahtarı üreteci — SATICI tarafında çalışır, cihazda değil.
//
// ── ne üretiyor ──────────────────────────────────────────────────────────────
//
// Bir lisans anahtarı, İMZALI BİR VERİDİR: kime verildiği, hangi plan, kaç yuva ve ne zamana
// kadar geçerli olduğu açık açık içinde yazar, ve bir Ed25519 imzası taşır. Cihaz onu İNTERNETE
// ÇIKMADAN doğrular — elindeki tek şey açık anahtardır.
//
// Klasik "XXXX-XXXX-XXXX" biçimindeki kısa anahtarlar bunu yapamaz: o kadar kısa bir dizgeye bir
// imza sığmadığı için ya sunucuya sorman gerekir (bir NAS'ın interneti olmayabilir, ve olsa bile
// müşterinin cihazının satıcıya rapor vermesi bu ürünün mahremiyet duruşuna aykırı) ya da
// anahtarı "kendi kendini doğrulayan" zayıf bir algoritmayla üretirsin — ki o algoritmayı bulan
// herkes kendi anahtarını üretebilir. Uzun ama yapıştırılabilir bir jeton, dürüst olanı.
//
// ── neyi çözmediği ───────────────────────────────────────────────────────────
//
// Çevrimdışı doğrulanan hiçbir lisans, cihaza kök yetkisiyle erişebilen birini durduramaz:
// doğrulamayı yapan kodu değiştirebilir. Bu, bu tasarımın kusuru değil, çevrimdışı doğrulamanın
// tanımı. Lisansın işi dürüst kullanıcıya ne aldığını ve ne zamana kadar geçerli olduğunu
// söylemek, ve satıcıya kimin neyi aldığını kayıt altına almaktır.
//
// ── kullanım ─────────────────────────────────────────────────────────────────
//
//   node tools/license/keygen.mjs init <dizin>
//       Lisans imza çiftini üretir: <dizin>/depsis-license.key (GİZLİ) ve license-key.pub.
//       Açık anahtar depoya girer; özel anahtar ASLA.
//
//   node tools/license/keygen.mjs issue --key <özel-anahtar> --to "Ad Soyad" \
//        [--plan ev|pro] [--seats 5] [--until 2027-01-01] [--note "..."]
//       Bir lisans jetonu basar. `--until` verilmezse SÜRESİZ.
//
//   node tools/license/keygen.mjs verify --pub <açık-anahtar> <jeton>
//       Jetonu doğrular ve içindekini yazar. Cihazın yaptığının aynısı.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Jetonun biçim sürümü. Bir gün alanlar değişirse eski jetonlar hâlâ tanınabilsin diye. */
const VERSION = 1;
const PREFIX = 'DEPSIS';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const unb64url = (text) => Buffer.from(text, 'base64url');

/**
 * İMZA, JSON'un KENDİSİNİN değil base64url metninin üzerinde.
 *
 * JSON'u yeniden serileştirip imzalamak, doğrulayan tarafın anahtar sırasını, boşlukları ve sayı
 * biçimini bire bir aynı üretmesini gerektirir — ve etmediği gün imza tutmaz. Jetonda taşınan
 * metnin ta kendisini imzalamak bu sorunu tamamen ortadan kaldırır.
 */
function payloadBytes(payloadB64) {
  return Buffer.from(payloadB64, 'ascii');
}

/**
 * Lisansın kendi kimliği.
 *
 * RASTGELE, saatten türetilmiş DEĞİL. İlk hâli `Date.now()` kullanıyordu ve aynı milisaniyede
 * verilen iki lisans AYNI numarayı alıyordu — tek tek verirken görülmesi zor, toplu üretimde ise
 * elli lisansın hepsi aynı numarada. Numara bir gün iptal listesinde adlandıracağımız şey; iki
 * müşterinin aynı numarayı taşıması, o listeyi kullanılamaz yapardı.
 */
/**
 * Cihaz kodunu kabul edilebilir tek biçime getirir.
 *
 * Müşteri kodu telefonda okur, e-postaya yapıştırır, küçük harfle yazar. Buradaki tolerans
 * onun içindir — ama SESSİZ DEĞİL: tanınmayan bir kod hata veriyor, çünkü yanlış bir koda
 * bağlanmış bir lisansı ancak müşteri fark eder, ve ancak kuramadığı zaman.
 */
function normaliseDevice(value) {
  if (value === undefined) return undefined;
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  if (clean.length !== 12) {
    console.error(`--device okunamadı: ${value} (beklenen: XXXX-XXXX-XXXX)`);
    process.exit(2);
  }
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 12)}`;
}

function licenseId() {
  return `L-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function issue(privateKeyPem, fields) {
  const payload = {
    v: VERSION,
    id: fields.id,
    to: fields.to,
    plan: fields.plan ?? null,
    seats: fields.seats ?? null,
    issued: fields.issued,
    until: fields.until ?? null,
    note: fields.note ?? null,
    // Bağlı lisanslarda cihazın kodu. Bağsızlarda ALAN HİÇ YOK — `null` yazmak, eski
    // sürümlerin göremeyeceği bir fark üretmez ama jetonu gereksizce uzatır.
    ...(fields.device === undefined ? {} : { dev: fields.device }),
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const signature = sign(null, payloadBytes(payloadB64), createPrivateKey(privateKeyPem));
  return `${PREFIX}-${VERSION}.${payloadB64}.${b64url(signature)}`;
}

/** Cihazın yaptığının aynısı — ve bilerek aynısı: iki ayrı doğrulama, bir gün ayrışır. */
function check(publicKeyPem, token) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3 || parts[0] !== `${PREFIX}-${VERSION}`) {
    return { ok: false, reason: 'jeton biçimi tanınmadı' };
  }
  const [, payloadB64, signatureB64] = parts;
  let valid = false;
  try {
    valid = verify(
      null,
      payloadBytes(payloadB64),
      createPublicKey(publicKeyPem),
      unb64url(signatureB64),
    );
  } catch (error) {
    return { ok: false, reason: `imza okunamadı: ${String(error)}` };
  }
  if (!valid) return { ok: false, reason: 'imza tutmuyor' };

  let payload;
  try {
    payload = JSON.parse(unb64url(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'içerik okunamadı' };
  }
  return { ok: true, payload };
}

// ── komutlar ─────────────────────────────────────────────────────────────────

function argOf(argv, name) {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

function cmdInit(argv) {
  const dir = argv[0];
  if (dir === undefined) {
    console.error('kullanım: keygen.mjs init <dizin>');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'depsis-license.key');
  const pubPath = join(dir, 'license-key.pub');
  // 0600: özel anahtar. Windows'ta kip kavramı farklı çalışıyor, ama Linux'ta üretildiğinde
  // dosyanın açıldığı anda doğru olması gerekiyor.
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`özel anahtar : ${keyPath}   ← GİZLİ, depoya KOYMAYIN, yedekleyin`);
  console.log(`açık anahtar : ${pubPath}   ← depoya girer, cihazlara bu gider`);
}

function cmdIssue(argv) {
  const keyPath = argOf(argv, '--key');
  const to = argOf(argv, '--to');
  if (keyPath === undefined || to === undefined) {
    console.error(
      'kullanım: keygen.mjs issue --key <özel-anahtar> --to "Ad Soyad" [--plan p] [--seats n] [--until YYYY-MM-DD] [--note "..."]',
    );
    process.exit(2);
  }
  const until = argOf(argv, '--until');
  if (until !== undefined && Number.isNaN(Date.parse(until))) {
    console.error(`--until okunamadı: ${until} (beklenen: YYYY-MM-DD)`);
    process.exit(2);
  }
  const seatsRaw = argOf(argv, '--seats');
  const seats = seatsRaw === undefined ? undefined : Number(seatsRaw);
  if (seats !== undefined && (!Number.isInteger(seats) || seats < 1)) {
    console.error(`--seats bir pozitif tam sayı olmalı: ${seatsRaw}`);
    process.exit(2);
  }

  const token = issue(readFileSync(keyPath, 'utf8'), {
    id: licenseId(),
    to,
    plan: argOf(argv, '--plan'),
    seats,
    issued: new Date().toISOString(),
    until: until === undefined ? undefined : new Date(`${until}T23:59:59Z`).toISOString(),
    note: argOf(argv, '--note'),
    device: normaliseDevice(argOf(argv, '--device')),
  });

  // ÜRETTİĞİNİ HEMEN DOĞRULA: bir imza, üretildiği yerde doğrulanmazsa ancak müşterinin
  // cihazında — yani en pahalı anda — yanlış olduğu anlaşılır.
  const pubPath =
    argOf(argv, '--pub') ?? keyPath.replace(/depsis-license\.key$/u, 'license-key.pub');
  try {
    const result = check(readFileSync(pubPath, 'utf8'), token);
    if (!result.ok) {
      console.error(`ÜRETİLEN JETON DOĞRULANAMADI: ${result.reason}`);
      process.exit(1);
    }
  } catch {
    console.error(`uyarı: açık anahtar okunamadı (${pubPath}); jeton doğrulanmadan basıldı`);
  }

  console.log(token);
}

/**
 * TOPLU ÜRETİM — ve bunun asıl sebebi güvenlik, kolaylık değil.
 *
 * Lisansları bir sunucunun anlık üretmesi için ÖZEL ANAHTARIN O SUNUCUDA durması gerekir: yani
 * internete bakan bir makinede, sürekli. O makine ele geçirildiği gün saldırgan sınırsız lisans
 * basar. Önceden basılmış bir havuzda ise anahtar çevrimdışı kalır; sunucunun elinde yalnızca
 * ÜRETİLMİŞ jetonlar durur, ve onları çalan biri o kadarını çalar — daha fazlasını üretemez.
 *
 * Bir satış sitesi ya da aktivasyon ucu kurulacaksa, ona verilecek şey bu dosyadır.
 */
function cmdBatch(argv) {
  const keyPath = argOf(argv, '--key');
  const countRaw = argOf(argv, '--count');
  const out = argOf(argv, '--out');
  const count = Number(countRaw);
  if (keyPath === undefined || out === undefined || !Number.isInteger(count) || count < 1) {
    console.error(
      'kullanım: keygen.mjs batch --key <özel-anahtar> --count 50 --out lisanslar.csv [--plan p] [--seats n] [--until YYYY-MM-DD]',
    );
    process.exit(2);
  }
  const until = argOf(argv, '--until');
  if (until !== undefined && Number.isNaN(Date.parse(until))) {
    console.error(`--until okunamadı: ${until}`);
    process.exit(2);
  }
  const seatsRaw = argOf(argv, '--seats');
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  const publicKeyPem = readFileSync(
    argOf(argv, '--pub') ?? keyPath.replace(/depsis-license.key$/u, 'license-key.pub'),
    'utf8',
  );

  const rows = ['lisans_no,jeton'];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const id = licenseId();
    // ÜRETİLEN HER JETON AYRI AYRI DOĞRULANIYOR ve numarası tekilliğe karşı sınanıyor. Elli
    // jetonun içinde bozuk bir tanesini, ancak onu alan müşteri fark ederdi.
    if (seen.has(id)) {
      console.error('aynı lisans numarası iki kez üretildi; toplu üretim durduruldu');
      process.exit(1);
    }
    seen.add(id);
    const token = issue(privateKeyPem, {
      id,
      // Havuzdaki jetonlar HENÜZ KİMSEYE ait değil; kime verildiği satış anında kaydedilir.
      to: argOf(argv, '--to') ?? '(atanmadı)',
      plan: argOf(argv, '--plan'),
      seats: seatsRaw === undefined ? undefined : Number(seatsRaw),
      issued: new Date().toISOString(),
      until: until === undefined ? undefined : new Date(`${until}T23:59:59Z`).toISOString(),
      note: argOf(argv, '--note'),
    });
    const result = check(publicKeyPem, token);
    if (!result.ok) {
      console.error(`ÜRETİLEN JETON DOĞRULANAMADI (${id}): ${result.reason}`);
      process.exit(1);
    }
    rows.push(`${id},${token}`);
  }
  writeFileSync(out, rows.join(String.fromCharCode(10)) + String.fromCharCode(10));
  console.log(`${count} lisans üretildi ve hepsi doğrulandı: ${out}`);
  console.log('Bu dosya BASILMIŞ lisanslardır; özel anahtar kadar olmasa da gizlidir.');
}

function cmdVerify(argv) {
  const pubPath = argOf(argv, '--pub');
  const token = argv.filter((a) => !a.startsWith('--') && a !== pubPath).pop();
  if (pubPath === undefined || token === undefined) {
    console.error('kullanım: keygen.mjs verify --pub <açık-anahtar> <jeton>');
    process.exit(2);
  }
  const result = check(readFileSync(pubPath, 'utf8'), token);
  if (!result.ok) {
    console.error(`GEÇERSİZ: ${result.reason}`);
    process.exit(1);
  }
  console.log('geçerli imza');
  for (const [key, value] of Object.entries(result.payload)) {
    if (value !== null) console.log(`  ${key.padEnd(7)} ${value}`);
  }
  const until = result.payload.until;
  if (until !== null && Date.parse(until) < Date.now()) {
    console.log('  DURUM   süresi dolmuş');
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'init':
    cmdInit(rest);
    break;
  case 'issue':
    cmdIssue(rest);
    break;
  case 'batch':
    cmdBatch(rest);
    break;
  case 'verify':
    cmdVerify(rest);
    break;
  default:
    console.error('kullanım: keygen.mjs init|issue|batch|verify   (ayrıntı için dosyanın başı)');
    process.exit(2);
}
