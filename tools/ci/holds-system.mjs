// Ajanın disk envanterinde bir diskin `holds_system` bayrağını okur.
//
// KENDİ DOSYASI, ve sebebi kapının kendi ölçümünün kırılgan olmaması: ilk hâli JSON'u `tr` ve
// `grep -A20` ile eşeliyordu, yani alanların SIRASINA bağlı bir iddiaydı — ajan bir gün alanları
// başka sırayla yazsa kapı sessizce "hayır" derdi ve kimse kapının bozulduğunu anlamazdı.
//
//   ajan-envanteri-json | node holds-system.mjs sda   →  true | false | "kname yok: sda"
//
// Çıktı üç değerden biri ve üçü de okunur: bulunamayan bir disk, `false` ile karıştırılmamalı.
let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  const wanted = process.argv[2];
  try {
    const disks = JSON.parse(raw).disks ?? [];
    const hit = disks.find((disk) => disk.kname === wanted);
    console.log(hit === undefined ? `kname yok: ${wanted}` : String(hit.holds_system));
  } catch (error) {
    console.log(`ayristirilamadi: ${String(error).slice(0, 160)}`);
  }
});
