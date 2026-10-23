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
const SERVICE_TOKEN = path.join(PROGRAM_DATA, 'ZeroTier', 'One', 'authtoken.secret');
/** ZeroTier'ın kendi tepsi uygulamasının kullanıcı için bıraktığı kopya. */
const UI_TOKEN = path.join(process.env.LOCALAPPDATA || '', 'ZeroTier', 'authtoken.secret');
const MSI_URL = 'https://download.zerotier.com/dist/ZeroTier%20One.msi';
const API = 'http://127.0.0.1:9993';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15 * 60 * 1000 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout)),
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
 * Gerekirse ZeroTier'ı kurar ve jetonu kullanıcının okuyabileceği yere kopyalar — TEK bir yönetici
 * onayıyla (UAC). Kullanıcı eşleştirme kodunu girdiğinde çağrılıyor; onay o.
 */
async function prepare(ownCopy) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'depsis-zt-'));
  const steps = [];

  if (!installed()) {
    const msi = path.join(work, 'ZeroTierOne.msi');
    const answer = await fetch(MSI_URL);
    if (!answer.ok) throw new Error(`ZeroTier indirilemedi (HTTP ${answer.status}).`);
    fs.writeFileSync(msi, Buffer.from(await answer.arrayBuffer()));
    // İMZA KURMADAN ÖNCE ve yönetici YETKİSİZ doğrulanıyor: yükseltilmiş bir süreç, kimin
    // yazdığı belli olmayan bir paketi asla çalıştırmamalı.
    const signer = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$s = Get-AuthenticodeSignature -LiteralPath ${ps(msi)}; ` +
        `if ($s.Status -ne 'Valid') { exit 3 }; $s.SignerCertificate.Subject`,
    ]).catch(() => '');
    if (!/O="?ZeroTier,? Inc/i.test(signer)) {
      throw new Error('İndirilen ZeroTier paketinin imzası doğrulanamadı; kurulmadı.');
    }
    steps.push(
      `$p = Start-Process msiexec.exe -ArgumentList '/i',${ps(`"${msi}"`)},'/qn','/norestart' -Wait -PassThru`,
      'if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { exit $p.ExitCode }',
      // Servis jetonunu ilk açılışta yazıyor; birkaç saniye sürebiliyor.
      `for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath ${ps(SERVICE_TOKEN)}); $i++) { Start-Sleep 1 }`,
    );
  }

  fs.mkdirSync(path.dirname(ownCopy), { recursive: true });
  steps.push(
    `Copy-Item -LiteralPath ${ps(SERVICE_TOKEN)} -Destination ${ps(ownCopy)} -Force`,
    // Dosya yükseltilmiş süreçte yazıldı; okuyacak olan normal kullanıcı.
    `icacls ${ps(ownCopy)} /grant ${ps(`${process.env.USERNAME}:R`)} | Out-Null`,
  );

  const script = path.join(work, 'depsis-zt.ps1');
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'\r\n${steps.join('\r\n')}\r\n`, 'utf8');
  try {
    await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
        `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${ps(`"${script}"`)}; ` +
        'exit $p.ExitCode',
    ]);
  } catch (error) {
    throw new Error(
      /cancel|iptal|1223/i.test(error.message)
        ? 'Yönetici onayı verilmedi. ZeroTier kurulamadı.'
        : `ZeroTier hazırlanamadı: ${error.message}`,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function call(token, method, route, body) {
  const answer = await fetch(`${API}${route}`, {
    method,
    headers: { 'X-ZT1-Auth': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
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

module.exports = { installed, readToken, prepare, nodeId, ensureJoined, leave };
