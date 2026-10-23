'use strict';

/**
 * Eşleştirme kodu: DEPSIS arayüzünün "Uzak erişim" ekranında gösterdiği tek satır.
 *
 *   DEPSIS:<16 hane ağ kimliği>:<cihazın ZeroTier IPv4'ü>:<sertifikanın SHA-256'sı, 64 hane>
 *
 * Üç parça ve üçü de gerekli. Ağ kimliği neye katılınacağını, adres neyin açılacağını, parmak izi
 * de açılanın GERÇEKTEN o cihaz olduğunu söylüyor: cihazın sertifikası kendinden imzalı, ve
 * parmak izi olmadan uygulamanın yapabileceği tek şey her sertifikayı kabul etmek olurdu.
 */
const CODE = /^DEPSIS:([0-9a-f]{16}):(\d{1,3}(?:\.\d{1,3}){3}):([0-9a-f]{64})$/;

/** Kodu okur; geçersizse `null`. Boşluklar ve parmak izindeki `:` ayraçları affediliyor. */
function parsePairing(text) {
  const compact = String(text).trim().replace(/\s+/g, '');
  const [head, network, address, ...rest] = compact.split(':');
  // Parmak izi `AB:CD:…` biçiminde yapıştırılmışsa kalan parçalar onun baytları.
  const candidate = [head, network, address, rest.join('')].join(':').toLowerCase();
  const match = CODE.exec(candidate.replace(/^depsis:/, 'DEPSIS:'));
  if (match === null) return null;
  const octets = match[2].split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return { networkId: match[1], address: match[2], fingerprint: match[3] };
}

/** PEM ya da DER bir sertifikanın SHA-256'sı, küçük harf onaltılık, ayraçsız. */
function certificateFingerprint(certificate) {
  const { createHash } = require('node:crypto');
  let der = certificate;
  if (typeof certificate === 'string') {
    const body = certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    der = Buffer.from(body, 'base64');
  }
  return createHash('sha256').update(der).digest('hex');
}

module.exports = { parsePairing, certificateFingerprint };
