'use strict';

// node --test clients/desktop — bağımlılıksız, Electron gerektirmiyor.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { parsePairing, certificateFingerprint } = require('./pairing.js');

const FP = 'ab'.repeat(32);

test('arayüzün yazdığı kod okunuyor', () => {
  assert.deepEqual(parsePairing(`DEPSIS:f3797ba7a878ba50:10.184.164.7:${FP}`), {
    networkId: 'f3797ba7a878ba50',
    address: '10.184.164.7',
    fingerprint: FP,
  });
});

test('baştaki boşluk, büyük harf ve parmak izindeki iki nokta affediliyor', () => {
  const colons = FP.match(/../g).join(':').toUpperCase();
  assert.equal(parsePairing(`  depsis:F3797BA7A878BA50:10.0.0.1:${colons}\n`)?.fingerprint, FP);
});

test('eksik ya da bozuk kod reddediliyor — parmak izi olmadan bağlanılmıyor', () => {
  for (const bad of [
    '',
    'DEPSIS:f3797ba7a878ba50:10.0.0.1',
    `DEPSIS:f3797ba7a878ba5:10.0.0.1:${FP}`,
    `DEPSIS:f3797ba7a878ba50:10.0.0.256:${FP}`,
    `DEPSIS:f3797ba7a878ba50:10.0.0.1:${FP.slice(2)}`,
  ]) {
    assert.equal(parsePairing(bad), null, bad);
  }
});

test('PEM ve DER aynı parmak izini veriyor', () => {
  const der = Buffer.from('bir sertifikanın baytları');
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
  const expected = createHash('sha256').update(der).digest('hex');
  assert.equal(certificateFingerprint(der), expected);
  assert.equal(certificateFingerprint(pem), expected);
});

test('yükseltilmiş betik kurulumdan hemen önce imzayı yeniden doğruluyor ve 0 ile bitiyor', () => {
  const { elevatedScript, SIGNER } = require('./zerotier.js');
  const script = elevatedScript({
    msi: String.raw`C:\Users\Gökhan Çağrı\Temp\z.msi`,
    ownCopy: String.raw`C:\x`,
  });
  // Türkçe yol bozulmadan betiğin içinde; betik dosya değil, UTF-16 kodlu komut olarak gidiyor.
  assert.match(script, /Gökhan Çağrı/);
  assert.ok(script.indexOf('Get-AuthenticodeSignature') < script.indexOf('msiexec'));
  assert.match(script, /exit 0$/);
  assert.ok(SIGNER.test('CN="ZeroTier, Inc.", O="ZeroTier, Inc.", L=Irvine, S=California, C=US'));
  assert.ok(!SIGNER.test('CN=x, O="ZeroTier, Inc. Evil Twin LLC", C=US'));
});
