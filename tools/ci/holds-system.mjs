// Ajanın disk envanterinde bir diskin `holds_system` bayrağını okur.
//
// KENDİ DOSYASI, ve sebebi kapının kendi ölçümünün kırılgan olmaması: ilk hâli JSON'u `tr` ve
// `grep -A20` ile eşeliyordu, yani alanların SIRASINA bağlı bir iddiaydı — ajan bir gün alanları
// başka sırayla yazsa kapı sessizce "hayır" derdi ve kimse kapının bozulduğunu anlamazdı.
//
//   ajan-envanteri-json | node holds-system.mjs sda   →  true
//                                                     →  false | tanı: …
//                                                     →  kname yok: sda | görülen: sda, sdb
//
// Cevap "true" değilse ARDINDAN TANI geliyor: düşen bir kapı, nereye bakılacağını söylemeli.
// Tanı metnindeki mantıksal değerler EVET/HAYIR'a çevriliyor — çünkü kapı "true" kelimesini alt
// dizge olarak arıyor ve tanının kendisi iddiayı yanlışlıkla geçirmemeli.
const sanitize = (text) => text.replaceAll('true', 'EVET').replaceAll('false', 'HAYIR');

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  const wanted = process.argv[2];
  try {
    const disks = JSON.parse(raw).disks ?? [];
    const hit = disks.find((disk) => disk.kname === wanted);
    if (hit === undefined) {
      const seen = disks.map((disk) => disk.kname).join(', ');
      console.log(`kname yok: ${wanted} | görülen: ${seen || '(hiç disk yok)'}`);
      return;
    }
    if (hit.holds_system === true) {
      console.log('true');
      return;
    }
    console.log(`false | tanı: ${sanitize(JSON.stringify(hit))}`);
  } catch (error) {
    console.log(`ayristirilamadi: ${String(error).slice(0, 160)}`);
  }
});
