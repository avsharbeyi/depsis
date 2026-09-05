import { expect, openPane, signIn, test } from './fixtures.js';

/**
 * "Bu bilgisayara bağla" — uçtan uca.
 *
 * Ölçülen şey bir görünüm değil, İKİ İDDİA:
 *
 *   * komutlar tarayıcının GERÇEKTEN bağlandığı adresi taşıyor — sunucunun yapılandırılmış adını
 *     değil. Sunucunun birkaç adresi olabiliyor ve hangisinin bu istemciye ulaştığını bilmiyor;
 *     tarayıcının bağlandığı ad, tanım gereği az önce çalışmış olan;
 *   * kullanıcı adı OTURUMDAKİ hesabın adı. `net use` bir kullanıcı adı almazsa Windows oturum
 *     açmış kullanıcınınkini deniyor, ki o neredeyse hiçbir zaman DEPSIS'teki ad değil — ve
 *     sonucu, sebebini söylemeyen bir kimlik penceresi.
 */

test.beforeEach(({ consoleWatch }) => {
  consoleWatch.tolerate(
    /401 \(Unauthorized\)/,
    'Oturum açılmadan önce /me sorulur ve 401 döner; tarayıcı her 4xx yanıtı konsola yazar.',
  );
});

test('bağlanma komutları bu tarayıcının adresini ve hesabın adını taşıyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'Paylaşımlar');

  const connect = pane.getByRole('button', { name: 'Bu bilgisayara bağla' }).first();
  // Yayımlanmamış paylaşımda düğme HİÇ çizilmiyor; ajansız bir yığında hiç yayımlanmış paylaşım
  // olmayabiliyor, ve o durumda ölçülecek bir şey yok.
  if ((await connect.count()) === 0) {
    // Yayımlanmamış bir paylaşımın `net use` satırı çalışmaz, ve panel onun için hiç çizilmiyor.
    // Ekranın bunu SÖYLEDİĞİNİ doğrulayıp bitiyor: ölçülecek bir komut yok, ve atlanmış saymak
    // yerine bunu söylemek dürüst.
    await expect(pane.getByText(/yayımlanmam/).first()).toBeVisible();
    return;
  }
  await connect.click();

  const host = new URL(page.url()).hostname;
  const shown = pane.locator('.conn');
  await expect(shown).toBeVisible();

  // Windows'un kalıcı sürücü komutu: adres, kullanıcı adı ve `/persistent:yes` bir arada.
  const netUse = shown.locator('code', { hasText: 'net use' });
  await expect(netUse).toContainText(`\\\\${host}\\`);
  await expect(netUse).toContainText('/user:e2eyonetici');
  await expect(netUse).toContainText('/persistent:yes');

  // macOS ve Linux biçimleri de aynı adresi taşıyor — üçü ayrı ayrı yazıldığı için biri
  // ötekilerden ayrı düşebilir.
  await expect(shown.locator('code', { hasText: 'smb://' })).toContainText(
    `smb://e2eyonetici@${host}/`,
  );
  await expect(shown.locator('code', { hasText: 'mount -t cifs' })).toContainText(`//${host}/`);
});

test('SMB parolası olmayan hesaba komutların çalışmayacağı söyleniyor', async ({ page }) => {
  await signIn(page);
  const pane = await openPane(page, 'Paylaşımlar');

  const connect = pane.getByRole('button', { name: 'Bu bilgisayara bağla' }).first();
  // SESSİZ BİR `return` DEĞİL. Bu dal bir zamanlar hiçbir iddia kurmadan dönüyordu ve Playwright
  // onu "passed" diye raporluyordu: yayımlanmış paylaşımı olmayan bir yığında bu test sıfır şey
  // ölçüp yeşil yanıyordu, ve ci.yml'deki "her atlama sebebini söylesin" kapısı da göremiyordu
  // çünkü atlama diye kaydedilmiş bir şey yoktu.
  //
  // Kardeş testteki `/yayımlanmam/` iddiası buraya kopyalanamaz: o not (Shares.tsx) yalnız
  // `unpublished > 0 && smbAvailable` iken çiziliyor, yani ajan tamamen düşükse hiç görünmüyor
  // ve iddia kırılırdı. Doğrusu, ölçülemediğini SÖYLEYEREK atlamak.
  test.fixme(
    (await connect.count()) === 0,
    'Bu yığında yayımlanmış paylaşım yok: "Bu bilgisayara bağla" düğmesi hiç çizilmiyor, ' +
      'yani SMB parolası uyarısının alana bağlı olduğu ölçülemiyor. CI bunu görmez — ' +
      'ci.yml DEPSIS_E2E_REQUIRE_AGENT=1 ile koşuyor.',
  );
  await connect.click();

  // `smbReady` /me'den geliyor ve `nt_hash IS NOT NULL` demek.
  //
  // BU TESTİN İLK HÂLİ YANLIŞ VARSAYIYORDU: kurulum sihirbazının hash'i de yazdığını sanıp
  // "uyarı yok" bekliyordu, ve yalnızca panel hiç çizilmediği için geçiyordu. Sondayla bakınca
  // `smbReady: false` çıktı — sihirbaz `rememberPassword`'ü çağırmıyordu, yani her cihazın İLK
  // hesabı SMB'ye ulaşamıyordu ve bunu hiçbir ekran söylemiyordu. O ayrı bir düzeltme oldu.
  //
  // Burada ölçülen şey uyarının ALANA BAĞLI olduğu: her zaman göstermek ve hiç göstermemek iki
  // farklı yalan, ve ikisi de ekrana bakınca aynı görünüyor. Kurulumdan geçmiş bir yöneticinin
  // artık hash'i var, yani uyarı olmamalı.
  await expect(pane.getByText('Bu hesabın SMB parolası yok.')).toHaveCount(0);
  // Ve yerine kullanıcı adını söyleyen satır duruyor.
  await expect(pane.locator('.conn')).toContainText('e2eyonetici');
});
