'use strict';

/**
 * Bu bilgisayarın ZeroTier One servisi — kurulumu, jetonu ve ağa katılım.
 *
 * NEDEN GÖMÜLÜ BİR AĞ YIĞINI (libzt) DEĞİL DE GERÇEK SERVİS. libzt ağı yalnız uygulamanın kendi
 * içinde açar; bu pencere cihaza ulaşır ama Windows'un kendisi ulaşmaz. Sahibi paylaşımı Dosya
 * Gezgini'ne ağ sürücüsü olarak bağlıyor, ve o trafik işletim sisteminin yığınından geçiyor —
 * yani sanal ağ kartı şart. Servis bir kez kuruluyor, uygulama kapalıyken de bağlı kalıyor.
 *
 * Uygulama ZeroTier'ı PAKETLEMİYOR: ilk kurulumda resmî MSI'ı ZeroTier'ın kendi sunucusundan
 * indiriyor ve kurmadan önce Authenticode imzasının ZeroTier, Inc. olduğunu doğruluyor.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROGRAM_DATA = process.env.ProgramData || 'C:\\ProgramData';
const SERVICE_DIR = path.join(PROGRAM_DATA, 'ZeroTier', 'One');
const SERVICE_TOKEN = path.join(SERVICE_DIR, 'authtoken.secret');
/** ZeroTier'ın kendi tepsi uygulamasının kullanıcı için bıraktığı kopya. */
const UI_TOKEN = path.join(process.env.LOCALAPPDATA || '', 'ZeroTier', 'authtoken.secret');
const MSI_URL = 'https://download.zerotier.com/dist/ZeroTier%20One.msi';
/** Authenticode imzalayanının konu satırında ARANAN kurum — tam ad, önek değil. */
const SIGNER = /(^|,\s*)O="?ZeroTier, Inc\.?"?(,|$)/;

/** Servis bağlandığı portu bu dosyaya yazıyor; okunamazsa varsayılan. */
function apiBase() {
  try {
    const port = Number(fs.readFileSync(path.join(SERVICE_DIR, 'zerotier-one.port'), 'utf8'));
    if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  } catch {
    // varsayılan
  }
  return 'http://127.0.0.1:9993';
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 15 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const failure = new Error(String(stderr || error.message).trim());
        failure.exitCode = typeof error.code === 'number' ? error.code : null;
        reject(failure);
      },
    );
  });
}

/** Servis kurulu mu: servis ilk açılışında jetonunu yazıyor. */
function installed() {
  return fs.existsSync(SERVICE_TOKEN);
}

/** Okunabilen ilk jeton: önce uygulamanın kendi kopyası, sonra ZeroTier arayüzününki. */
function readToken(ownCopy) {
  for (const file of [ownCopy, UI_TOKEN]) {
    try {
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token !== '') return token;
    } catch {
      // yok ya da okunamıyor — sıradaki
    }
  }
  return null;
}

/** PowerShell tek tırnaklı dizesi: içindeki `'` ikilenir. */
function ps(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/**
 * Yükseltilmiş betik. `-EncodedCommand` ile, DOSYA OLARAK DEĞİL:
 *
 * - Windows PowerShell 5.1 BOM'suz bir .ps1'i ANSI kod sayfasıyla okuyor; Türkçe bir kullanıcı
 *   adında (Gökhan, Çağrı) yollar bozuluyor ve kurulum her denemede düşüyordu.
 * - Kullanıcının yazabildiği %TEMP%'te duran bir betik, onaydan sonra ama çalışmadan önce
 *   değiştirilebilirdi. Komut satırındaki metni kimse değiştiremez.
 *
 * MSI da aynı sebeple yükseltilmiş süreçte, yalnız yöneticinin yazabildiği bir dizine kopyalanıp
 * imzası ORADA yeniden doğrulanıyor: yetkisiz kontrol ile yükseltilmiş kurulum arasında %TEMP%'teki
 * dosya değiştirilmiş olabilir.
 */
function elevatedScript({ msi, ownCopy }) {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  if (msi !== null) {
    lines.push(
      `$dir = Join-Path $env:SystemRoot ('Temp\\depsis-' + [guid]::NewGuid())`,
      'New-Item -ItemType Directory -Path $dir | Out-Null',
      `$pkg = Join-Path $dir 'ZeroTierOne.msi'`,
      `Copy-Item -LiteralPath ${ps(msi)} -Destination $pkg`,
      '$s = Get-AuthenticodeSignature -LiteralPath $pkg',
      `if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch ${ps(SIGNER.source)}) { exit 21 }`,
      // ZTHEADLESS: ZeroTier'ın kendi tepsi arayüzü kurulmuyor — onun işini bu uygulama yapıyor.
      `$p = Start-Process msiexec.exe -ArgumentList '/i',('"' + $pkg + '"'),'/qn','/norestart','ZTHEADLESS=Yes' -Wait -PassThru`,
      'Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue',
      'if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { exit $p.ExitCode }',
      // Servis jetonunu ilk açılışta yazıyor; birkaç saniye sürebiliyor.
      `for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath ${ps(SERVICE_TOKEN)}); $i++) { Start-Sleep 1 }`,
    );
  }
  // Kopya %APPDATA% altında; izinleri o dizinden miras alıyor, kullanıcı okuyabiliyor.
  lines.push(
    `Copy-Item -LiteralPath ${ps(SERVICE_TOKEN)} -Destination ${ps(ownCopy)} -Force`,
    'exit 0',
  );
  return lines.join('\n');
}

/**
 * Gerekirse ZeroTier'ı kurar ve jetonu kullanıcının okuyabileceği yere kopyalar — TEK bir yönetici
 * onayıyla (UAC). Kullanıcı "ZeroTier'ı hazırla"ya bastığında çağrılıyor; onay o.
 */
async function prepare(ownCopy) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'depsis-zt-'));
  let msi = null;
  try {
    if (!installed()) {
      msi = path.join(work, 'ZeroTierOne.msi');
      const answer = await fetch(MSI_URL);
      if (!answer.ok) throw new Error(`ZeroTier indirilemedi (HTTP ${answer.status}).`);
      fs.writeFileSync(msi, Buffer.from(await answer.arrayBuffer()));
      // İlk kontrol YETKİSİZ: imzası tutmayan bir paket için kullanıcıya UAC bile sorulmuyor.
      const signer = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-AuthenticodeSignature -LiteralPath ${ps(msi)}; ` +
          `if ($s.Status -ne 'Valid') { exit 3 }; $s.SignerCertificate.Subject`,
      ]).catch(() => '');
      if (!SIGNER.test(signer.trim())) {
        throw new Error('İndirilen ZeroTier paketinin imzası doğrulanamadı; kurulmadı.');
      }
    }
    fs.mkdirSync(path.dirname(ownCopy), { recursive: true });

    const encoded = Buffer.from(elevatedScript({ msi, ownCopy }), 'utf16le').toString('base64');
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
        `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; ` +
        'exit $p.ExitCode',
    ]).catch((error) => {
      if (/cancel|iptal|1223/i.test(error.message)) {
        throw new Error('Yönetici onayı verilmedi. ZeroTier kurulamadı.');
      }
      if (error.exitCode === 21) {
        throw new Error('ZeroTier paketinin imzası kurulumdan hemen önce tutmadı; kurulmadı.');
      }
      throw new Error(
        `ZeroTier hazırlanamadı${error.exitCode === null ? '' : ` (çıkış ${error.exitCode})`}.`,
      );
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Jeton geçersiz: servis yeniden kurulmuş ya da kopya başka bir makineden gelmiş. */
class TokenRejected extends Error {}

async function call(token, method, route, body) {
  const answer = await fetch(`${apiBase()}${route}`, {
    method,
    headers: { 'X-ZT1-Auth': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (answer.status === 401) throw new TokenRejected('ZeroTier jetonu reddetti.');
  if (answer.status === 404) return null;
  if (!answer.ok) throw new Error(`ZeroTier servisi ${answer.status} döndü.`);
  return answer.json();
}

/** Bu bilgisayarın düğüm kimliği — cihazda onaylanacak olan bu. */
async function nodeId(token) {
  const status = await call(token, 'GET', '/status');
  return status?.address ?? null;
}

/**
 * Ağın durumu; üye değilse katılır. ZeroTier'ın kendi durum adlarını döndürüyor:
 * OK, ACCESS_DENIED, REQUESTING_CONFIGURATION, NOT_FOUND, …
 */
async function ensureJoined(token, networkId) {
  let network = await call(token, 'GET', `/network/${networkId}`);
  if (network === null) network = await call(token, 'POST', `/network/${networkId}`, {});
  return {
    status: network?.status ?? 'REQUESTING_CONFIGURATION',
    addresses: (network?.assignedAddresses ?? []).map((cidr) => cidr.split('/')[0]),
  };
}

async function leave(token, networkId) {
  await call(token, 'DELETE', `/network/${networkId}`);
}

module.exports = {
  installed,
  readToken,
  prepare,
  nodeId,
  ensureJoined,
  leave,
  TokenRejected,
  SIGNER,
  elevatedScript,
};
