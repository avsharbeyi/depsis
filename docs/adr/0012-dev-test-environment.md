# ADR-0012: Geliştirme ve test ortamı topolojisi

- **Durum:** Accepted
- **Tarih:** 2026-08-14
- **Faz:** 0
- **Etkilenen bileşenler:** `deploy/vm/`, `tools/poc/`, CI

## Bağlam

Geliştirme makinesi bir Windows 11 dizüstü; hedef bir Debian NAS. ZFS, Samba, systemd, fanotify
ve Docker Windows'ta doğrulanamaz. Master prompt §19 ayrıca dev ortamının _"root/disk
gerektirmeden mock adapter'larla"_ ayağa kalkmasını şart koşuyor.

Proje sahibi S2'de **Hyper-V Debian VM**'i seçti (WSL2 değil): WSL2'nin Microsoft çekirdeği ZFS
modülü taşımaz ve systemd desteği kısıtlıdır; ZFS için özel çekirdek derlemek Faz 0'ı gereksiz
yere uzatırdı.

## Karar

### Çift hat

| Hat            | Nerede            | Ne koşar                                      | Ne kanıtlar                                                            |
| -------------- | ----------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| **Geliştirme** | Windows host      | Tam uygulama, mock storage/agent adapter'ları | Birim, sözleşme, UI testleri. **Hiçbir depolama iddiasını kanıtlamaz** |
| **Doğrulama**  | Hyper-V Debian VM | Gerçek ZFS, Samba, PostgreSQL, fanotify       | Entegrasyon, kurtarma, P0-A…P0-F                                       |

Her raporda mock ile gerçek entegrasyon **açıkça ayrılır** (§22).

### VM profili

`depsis-poc` · Gen 2 · **6 GB statik RAM** · 4 vCPU · 40 GB sistem diski · 4 × 20 GB vdev diski.

Bellek **statiktir**: ZFS ARC kendini toplam RAM'e göre boyutlar ve balloon değişimlerine kötü
tepki verir.

`AutomaticCheckpointsEnabled = $false` **zorunludur** — açık kalırsa Hyper-V her başlatmada
vdev'lerin altına AVHDX differencing diskleri yerleştirir ve ZFS'ten alınan her G/Ç veya
arıza-enjeksiyonu sonucu geçersiz olur.

`AutomaticStopAction = ShutDown` — varsayılan `Save` 6 GB RAM'i diske döker ve resume'da ZFS'i
şaşırtabilir.

### İmaj: `.raw` + kendi VHDX'imiz

**Debian hiçbir cloud varyantı için `.vhd`/`.vhdx` yayınlamıyor** (ADR-0000 §2.1). `azure`
varyantı da bare VHD değil, `.tar.xz` yayınlıyor. `Convert-VHD` yalnız VHD↔VHDX çevirir, raw
veya qcow2 okuyamaz.

Seçilen yol, **hiçbir üçüncü taraf araç gerektirmeyen** blok kopyası:

`New-VHD` → `Mount-VHD -NoDriveLetter` → `Set-Disk -IsOffline $true` → `.raw`'ı
`\\.\PhysicalDriveN`'e sektör hizalı yaz → `Dismount-VHD`. cloud-init `growpart` ilk açılışta
kökü 40 GB'a büyütür.

Varyant **`generic`** — `genericcloud` tanımı gereği fiziksel donanım sürücülerini çıkarır ve
Hyper-V Gen2 kökü bulmak için initramfs'te `hv_storvsc` ister. `nocloud`'da cloud-init hiç yok,
dolayısıyla SSH anahtarı enjeksiyonu ve kök büyütme yok.

Build **tarihli dizinden** sabitlenir (`20260810-2566`), `latest/` **kullanılmaz** —
tekrarlanabilirlik için. SHA512 indirmeden sonra doğrulanır; uyuşmazsa dosya silinir.

> Doğrulandı 2026-08-14: her iki URL de HTTP 200; `.raw` tam olarak 3.221.225.472 bayt.

### cloud-init: ISO değil, `CIDATA` etiketli FAT VHDX

`mkisofs`/`genisoimage` Windows'ta yok. NoCloud datasource, `CIDATA` etiketli bir dosya sistemini
ISO olmadan da kabul eder. `New-VHD` → `Format-Volume -FileSystem FAT -NewFileSystemLabel CIDATA`
ile in-box cmdlet'lerle üretilir.

**PowerShell 5.1 tuzağı:** `Set-Content`/`Out-File` BOM ve CRLF ekler; cloud-init BOM'lu
`#cloud-config` başlığını reddeder. Bu yüzden `[IO.File]::WriteAllText` +
`UTF8Encoding($false)` + `-replace "\`r\`n","\`n"`kullanılır. (Aynı sorunun genel çözümü depo
kökündeki`.gitattributes`'tır.)

Seed diski ilk açılıştan sonra çıkarılmalıdır ki bir ZFS vdev'i sanılmasın.

### Kontrol düzlemi: iki NIC

**PowerShell Direct kullanılamaz** — Microsoft Learn açıkça "Windows 10 / Windows Server 2016
veya sonrası" guest gerektirdiğini söylüyor. Linux guest'te çalışmaz.

Default Switch de kontrol düzlemi olarak uygun değil: host her açılışta 192.168.0.0/16 veya
172.17–172.31 aralığından rastgele bir /28 seçer ve DHCP'si yönetilemez. Host→guest erişimi
host yeniden başlatmaları arasında **kararlı değildir**.

Bu yüzden iki NIC:

| NIC                  | Switch                  | Adres                      | Rol                              |
| -------------------- | ----------------------- | -------------------------- | -------------------------------- |
| `wan` (MAC `…E9:09`) | Default Switch          | DHCP                       | Yalnız dışa apt trafiği          |
| `lab` (MAC `…E9:0A`) | `DEPSIS-Lab` (Internal) | statik `192.168.244.10/24` | **Kararlı kontrol düzlemi**, SSH |

Host tarafı `192.168.244.1/24`. cloud-init `network-config` MAC ile eşleştirir (arayüz adı
sırası garanti değil). `New-NetNat` **eklenmez** — WinNAT host başına tek NAT ağına izin verir ve
onu Default Switch tutuyor.

### Disk kimliği — R1 riskini makine ile kontrol edilebilir yapmak

DEPSIS asla `/dev/sdX` kullanmayacak (risk R1: yanlış diski silmek). Ama Hyper-V'de kimlik
hikâyesinin iki yüzü var:

- **Lehine:** VHDX'in disk tanımlayıcısı _page 0x83_ VPD tanımlayıcısıdır (`Set-VHD
-ResetDiskIdentifier` belgesi bunu böyle tanımlıyor) ve Linux `storvsc_drv.c`
  `BLIST_TRY_VPD_PAGES` set ederek VPD okumasını kasten açar.
- **Aleyhine:** aynı sürücü `storvsc_host_mishandles_cmd()` içinde INQUIRY page 0x80'i (Unit
  Serial Number) bozuk komut listesine koyuyor. **Kullanılabilir bir SCSI seri numarası yok.**

Bu yüzden **üç kademeli kimlik**:

1. `/dev/disk/by-id/*` (page 0x83) — beklenen yol, ama **inferred**, PoC'nin ilk beş dakikada
   kanıtlaması gereken şey.
2. `/dev/disk/by-partuuid/*` — GPT partition GUID'i diskin kendi içeriğindedir; slot değişimine,
   yeniden başlatmaya ve yeniden takmaya dayanır.
3. ZFS vdev label GUID'i — havuz bir kez kurulduktan sonra `zpool import -d /dev/disk/by-id`
   üyeleri yola bakmaksızın bulur. Yani risk **yalnız ilk rol atamasında**dır.

`/dev/disk/by-path/` **rol ataması için asla kullanılmaz** — VMBus SCSI'da controller+LUN
kodlar, yani tam da kaçınmaya çalıştığımız slot bağımlı kimliktir. Yalnız "disk beklenen
slotta mı" çapraz kontrolü için kullanılır.

**Şema sonucu:** `storage_devices.serial` alanı **nullable** olmalı ve **birincil anahtar
olamaz**. Hyper-V hedefinde her zaman boş gelecektir.

**Hijyen:** her vdev kendi `New-VHD` çağrısıyla üretilir. Bir VHDX kopyalanırsa page 0x83
tanımlayıcısı da kopyalanır ve diskler `/dev/disk/by-id`'de çakışır. Kopya kullanılırsa
`Set-VHD -ResetDiskIdentifier -Force` zorunludur.

Sağlama script'i her vdev'in `DiskIdentifier`'ını **oluşturma anında**
`expected-disk-ids.json`'a yazar. Guest tarafı PoC bunları `/dev/disk/by-id`'de doğrular — böylece
R1 bir umut değil, **makine ile kontrol edilebilir bir değişmez** hâline gelir.

### Tekrarlanabilirlik

İlk açılıştan önce `pristine-preboot` checkpoint'i alınır. PoC koşuları arasında
`Restore-VMCheckpoint` ile temiz duruma dönülür.

Seri konsol `\\.\pipe\depsis-poc-console` üzerinde — açılmayan bir sistemi teşhis etmenin en ucuz
yolu; Debian cloud imajları `ttyS0`'ı zaten etkinleştirir.

## Kanıt

| İddia                                                                   | Kaynak                                                                                                              | Güven                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Debian cloud'da VHD/VHDX yok, yalnız qcow2/raw/tar.xz                   | [cloud.debian.org trixie](https://cloud.debian.org/images/cloud/trixie/latest/)                                     | verified                                     |
| Pinlenen build + dosya adı gerçekten var (HTTP 200, 3.221.225.472 bayt) | HEAD `cloud.debian.org/.../20260810-2566/`                                                                          | verified (bu oturumda ölçüldü)               |
| PowerShell Direct Windows guest gerektirir                              | [Microsoft Learn](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/powershell-direct) | verified                                     |
| VHDX disk tanımlayıcısı = SCSI VPD page 0x83                            | [Set-VHD](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vhd)                                      | verified                                     |
| `storvsc` page 0x80'i bozuk sayar → seri numarası yok                   | `drivers/scsi/storvsc_drv.c`                                                                                        | verified                                     |
| `/dev/disk/by-id` sembolik bağ **biçimi** (wwn- vs scsi-)               | —                                                                                                                   | **inferred → PoC ilk dakikada doğrulayacak** |
| Debian trixie çekirdeğinde bu davranışların varlığı                     | —                                                                                                                   | **inferred**                                 |

## Sonuçlar

**Olumlu:** Gerçek ZFS/Samba/fanotify doğrulaması mümkün. Checkpoint ile tekrarlanabilir. Disk
kimliği iddiası test edilebilir bir değişmeze dönüştü. Hiçbir üçüncü taraf araç kurulmuyor.

**Olumsuz / kabul edilen bedel:** VM oluşturma yükseltilmiş yetki ister. Host'ta 6 GB RAM bloke
olur. Performans kabul kriterleri (§18.2) sanal disklerde ölçülür; **gerçek donanım rakamları
değildir** ve öyle raporlanmayacaktır. Disk seri numarası bu ortamda hiç test edilemez.

**Bu kararın yasakladığı şeyler:**

- `latest/` dizininden imaj çekilemez; tarihli build sabitlenir.
- Otomatik checkpoint açılamaz.
- Dinamik bellek kullanılamaz.
- Bir vdev VHDX'i kopyalanarak üretilemez.
- `/dev/sdX` veya `/dev/disk/by-path/` rol atamasında kullanılamaz.
- Bu VM'de ölçülen performans sayıları donanım sayısı gibi sunulamaz.

## Geri alma maliyeti

Düşük. VM tek script'ten yeniden üretilir; kaybedilen yalnız koşum süresidir.

## Güvenlik ve veri kaybı etkisi

Bu ortam, gerçek diskleri olan bir makinede yapılamayacak yıkıcı testleri (disk çekme, havuz
bozma, rol değiştirme) **güvenle** yapmayı sağlar. Master prompt §22'nin _"veri kaybı riski olan
komutları kullanıcı onayı olmadan gerçek diskte çalıştırma"_ kuralı bu VM sayesinde ihlal
edilmeden R1 test edilebilir. SSH anahtarı `deploy/vm/artifacts/ssh/` altında üretilir ve
`.gitignore` ile depo dışında tutulur.
