# Operatör belgeleri

§21'in dokuzuncu teslimatı: yönetici, son kullanıcı, yedekleme ve felaket kurtarma.

| Belge                                                       | Kim için                 | Ne zaman okunur                               |
| ----------------------------------------------------------- | ------------------------ | --------------------------------------------- |
| [01 — Yönetici Kılavuzu](01-yonetici-kilavuzu.md)           | Cihazı kuran ve işleten  | Kurulumda, ve bir şey ters gittiğinde         |
| [02 — Son Kullanıcı Kılavuzu](02-son-kullanici-kilavuzu.md) | Dosyalarını burada tutan | İlk girişte                                   |
| [03 — Yedekleme](03-yedekleme.md)                           | Yönetici                 | Kurulumdan hemen sonra, sonra ayda bir        |
| [04 — Felaket Kurtarma](04-felaket-kurtarma.md)             | Yönetici                 | Bir şey gittiğinde — ve **öncesinde bir kez** |

## Bu belgelerin kuralı

Her komut, her dosya adı ve her sayı depodaki karşılığına bakılarak yazıldı. Bir şey burada
yazdığı gibi çalışmıyorsa **kılavuz yanlıştır**, kod değil.

Her belgenin sonunda ürünün o alanda **yapmadığı** şeyler var, ve orası kesilecek son bölüm.
Yedekleme belgesinin PITR'ın olmadığını söylemesi, o belgenin en kullanışlı cümlesi olabilir.

## Bunlarla birlikte okunacaklar

- [`README.md`](../../README.md) — depo düzeni ve bilinen eksikler listesi
- [`docs/adr/`](../adr/) — 24 karar kaydı. Bir şeyin neden öyle olduğunu soruyorsanız cevabı
  büyük olasılıkla orada, ve genellikle bir ölçümle birlikte.
- [`docs/threat-model/`](../threat-model/) — güven sınırları
- [`packages/contracts/openapi/depsis.yaml`](../../packages/contracts/openapi/depsis.yaml) — HTTP
  yüzeyinin tamamı, her uç noktanın kendi gerekçesiyle

## Henüz yazılmamış §21 teslimatları

Dürüstlük bu belgelerin de kuralı olduğu için, aynısı burada:

- Mimari diyagramlar (teslimat 3'ün diyagram yarısı — ADR'ler var)
- ER diyagramı (teslimat 5'in diyagram yarısı — göçler var)
- Storybook (teslimat 6'nın yarısı — tasarım sistemi ve responsive ekranlar var)
- İmzalı build/update üretim prosedürü (teslimat 10)
- Test raporları **artefakt olarak** (teslimat 7 — testler var ve koşuyor; CI hesabı kilitli
  olduğu için yayımlanmış bir rapor yok)
