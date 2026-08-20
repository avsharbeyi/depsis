# ADR-0000: Sürüm temel çizgisi ve doğrulama yöntemi

- **Durum:** Accepted (partial — §3'teki konular ikinci araştırma turunda tamamlanacak)
- **Tarih:** 2026-08-14
- **Faz:** 0

## Bağlam

Master prompt §0.4 bağlayıcı: _"Sürüm numaralarını tahmin etme veya gelişigüzel sabitleme.
Uygulama anında Debian Stable ve ilgili resmî belgelerde desteklenen kararlı sürümleri doğrula;
kilit dosyalarıyla sabitle."_

Bu ADR, hafızadan yazılmış hiçbir sürüm içermez. Her satırın oturum içinde gerçekten getirilmiş
bir kaynak URL'si vardır. Doğrulanamayanlar `unverified` olarak işaretlenir ve §3'e düşer.

## 1. Ölçülmüş geliştirme ortamı (bu makinede doğrudan çalıştırılarak tespit edildi)

| Bileşen          | Sürüm                                  | Durum                                             |
| ---------------- | -------------------------------------- | ------------------------------------------------- |
| Node.js          | v22.23.2                               | mevcut                                            |
| npm              | 10.9.8                                 | mevcut                                            |
| corepack         | 0.34.6                                 | mevcut — pnpm bununla etkinleştirilecek           |
| Git              | 2.55.0.windows.3                       | mevcut                                            |
| Python           | 3.14.7                                 | mevcut (yardımcı script'ler)                      |
| WSL2             | 2.7.3.0                                | mevcut (yalnız yedek dönüşüm yolu için)           |
| **Rust / cargo** | —                                      | **YOK** → sistem aracısı için `rustup` kurulacak  |
| **Docker**       | —                                      | **YOK** (host'ta gerekmiyor; Debian hedefine ait) |
| **PostgreSQL**   | —                                      | **YOK** (dev için konteyner, üretimde Debian)     |
| Hyper-V          | etkin, `vmms` Running                  | `HypervisorPresent=True`, modül yüklü             |
| Donanım          | i7-1360P · 15.7 GB RAM · C: 740 GB boş | VM için yeterli                                   |

## 2. Doğrulanmış hedef platform sürümleri

| Bileşen                            | Sürüm                                                                 | Kaynak                                                                                                                                     | Güven    | Nasıl sabitlenecek                                      |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------- |
| Debian Stable                      | **13 "trixie"**, nokta sürüm **13.6** (2026-07-11); 13.0 → 2025-08-09 | [debian.org/releases](https://www.debian.org/releases/)                                                                                    | verified | `deploy/vm/` içinde kod adı sabit                       |
| Debian oldstable / testing         | 12 "bookworm" / "forky"                                               | [debian.org/releases](https://www.debian.org/releases/)                                                                                    | verified | —                                                       |
| Debian trixie cloud image build    | **20260810-2566**                                                     | [cdimage.debian.org/images/cloud/trixie/](https://cdimage.debian.org/images/cloud/trixie/)                                                 | verified | **Tarihli dizin** sabitlenir, `latest/` **kullanılmaz** |
| OpenZFS (`zfsutils-linux`, trixie) | **2.3.2-2**                                                           | [manpages.debian.org/trixie](https://manpages.debian.org/trixie/zfsutils-linux/zfsprops.7.en.html)                                         | verified | apt pin                                                 |
| Samba (güncel man sayfası serisi)  | **4.23.0**                                                            | [samba.org current docs](https://www.samba.org/samba/docs/current/man-html/vfs_zfsacl.8.html)                                              | verified | —                                                       |
| Samba (Debian trixie paket sürümü) | **2:4.22.10+dfsg-0+deb13u2**                                          | VM'de ölçüldü (2026-08-15)                                                                                                                 | verified | apt pin                                                 |
| Hyper-V PowerShell cmdlet yüzeyi   | `windowsserver2025-ps` (2025-05-14)                                   | [learn.microsoft.com Set-VMFirmware](https://learn.microsoft.com/en-us/powershell/module/hyper-v/set-vmfirmware?view=windowsserver2025-ps) | verified | —                                                       |
| cloud-init NoCloud datasource      | güncel docs dalı                                                      | [docs.cloud-init.io NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)                                      | verified | trixie'deki paket sürümü **unverified**                 |

### 2.1 Debian cloud image — kritik tespit

**Debian hiçbir varyant için `.vhd` veya `.vhdx` yayınlamıyor.**
`https://cloud.debian.org/images/cloud/trixie/latest/` dizininde yalnız `.qcow2`, `.raw`,
`.tar.xz` ve `.json` var. `azure` varyantı da bare VHD değil, yalnız
`debian-13-azure-amd64.tar.xz` yayınlıyor.

Seçilen: **`debian-13-generic-amd64.raw`** (3.0 GiB, seyrek).

`genericcloud` **seçilmedi** — tanımı gereği fiziksel donanım sürücüleri çıkarılmıştır; Hyper-V
Gen2 kökü bulmak için initramfs'te `hv_storvsc` ister. `nocloud` **seçilmedi** — cloud-init yok,
dolayısıyla SSH anahtarı enjeksiyonu ve kök dosya sistemi büyütme yok.

## 3. İkinci tur — tamamlandı (2026-08-14)

Altı konu da doğrulandı. Sürüm tablosu:

| Bileşen                            | Sürüm                                                       | Nerede karara bağlandı |
| ---------------------------------- | ----------------------------------------------------------- | ---------------------- |
| PostgreSQL                         | **18.6** (PGDG `trixie-pgdg`) — trixie stock **17+278**'dir | ADR-0013               |
| Node.js                            | **24.19.0** (Active LTS) — v22 **Maintenance**'ta           | ADR-0002               |
| pnpm / turbo                       | 11.21.0 / 2.10.9                                            | ADR-0002               |
| TypeScript                         | **7.0.2**                                                   | ADR-0002               |
| NestJS                             | **11.2.1** (varsayılan adapter Express)                     | ADR-0002               |
| Vite / React                       | 8.2.1 / 19.2.8                                              | ADR-0002               |
| Vitest / Playwright                | 4.1.10 / 1.62.1                                             | ADR-0002               |
| zod                                | 4.4.3                                                       | ADR-0002               |
| @node-rs/argon2                    | 2.1.0 (prebuilt, node-gyp gerekmez)                         | ADR-0002               |
| otplib                             | 13.4.1 (terk edilmemiş)                                     | ADR-0002               |
| pino / pino-http                   | 10.3.1 / 11.0.0                                             | ADR-0002               |
| openapi-typescript / openapi-fetch | 7.13.0 / 0.17.0                                             | ADR-0002               |
| Rust                               | 1.97.1 (`rust-toolchain.toml`)                              | ADR-0006               |
| rustix / schemars                  | 1.1.4 / 1.2.2                                               | ADR-0006               |
| @tus/server                        | 2.4.4 (Node >= 20.19.0)                                     | ADR-0008               |
| archiver / zip-stream / yazl       | 8.0.0 / 7.0.5 / 3.3.1                                       | ADR-0008               |
| tus protokolü                      | **1.0.0** (IETF taslağı -12, RFC **değil**)                 | ADR-0008               |
| Debian trixie çekirdeği            | 6.12.101                                                    | ADR-0006               |

### Hâlâ doğrulanmamış

| Konu                                                       | Etki                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Debian trixie `nodejs` paket sürümü                        | pnpm 11 `>=22.13` istiyor; archive'ın yetip yetmediği **varsayılmayacak** → NodeSource/tarball planlanır |
| ~~Debian trixie `samba` paket sürümü~~                     | **ÇÖZÜLDÜ** → `2:4.22.10+dfsg-0+deb13u2` (VM'de ölçüldü 2026-08-15)                                      |
| ~~TypeScript 7 derleme davranışı~~                         | **ÇÖZÜLDÜ** → typescript-eslint TS 7'yi desteklemiyor; 6.0.3'e inildi, bkz. ADR-0002                     |
| Windows Build Tools bileşen listesi                        | temiz makinede                                                                                           |
| BLAKE3 vs SHA-256 gerçek throughput                        | P0-G                                                                                                     |
| `pg_trgm`'in non-det collation'lı kolonu indeksleyebilmesi | tasarım bundan kaçındığı için bloke etmiyor                                                              |

**Hiçbir `package.json` veya `Cargo.toml` hâlâ yazılmadı** — bir sonraki iş bu tabloyu kilit
dosyalarına dökmek.

## 4. Doğrulama yöntemi

1. Her sürüm resmî bir kaynaktan **oturum içinde getirilerek** okunur; hafızadan yazılmaz.
2. Kaynak önceliği: resmî proje belgeleri → man sayfaları → sürüm notları →
   `packages.debian.org` / `tracker.debian.org` → upstream git tag'leri. Blog ve StackOverflow
   yalnız birincil kaynağa işaretçi olarak.
3. Getirilemeyen her şey `unverified` işaretlenir ve §3'e düşer.
4. **Belge davranış kanıtı değildir.** Mimariyi bağlayan davranışsal iddialar Debian VM'de koşan
   bir PoC ile kanıtlanır; koşum çıktısı `docs/adr/evidence/` altına konur.
5. Sabitleme mekanizmaları: `pnpm-lock.yaml`, `Cargo.lock`, `rust-toolchain.toml`,
   apt pin, Docker image **digest** (`latest` yasak), tarihli Debian cloud image dizini.

## 5. Bu turda çürütülen varsayımlar

| Varsayım                                                         | Gerçek                                                                                                                                                   | Etki                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ZFS `acltype=nfsv4` + Samba `acl_xattr` = tek ACL gerçekliği     | `nfsv4` Linux'ta **desteklenmiyor** ve sessizce `off`'a düşerek POSIX ACL'leri de öldürüyor                                                              | **ADR-0004 yeniden yazıldı** → `acltype=posixacl`                                   |
| fanotify filesystem-wide mark birincil olay kaynağı              | Mark **superblock başına**, yani dataset başına; `CAP_SYS_ADMIN` + `CAP_DAC_READ_SEARCH` gerektiriyor; SLA zaten SMB hakkında                            | **ADR-0011 tersine çevrildi** → Samba `vfs_full_audit` birincil                     |
| Debian azure varyantı VHD yayınlıyor olabilir                    | Hiçbir varyant VHD/VHDX yayınlamıyor                                                                                                                     | `.raw` + `Mount-VHD` blok kopyası → ADR-0012                                        |
| PowerShell Direct ile VM sürülebilir                             | **Yalnız Windows guest** destekleniyor                                                                                                                   | SSH + ayrılmış Internal switch → ADR-0012                                           |
| Hyper-V diskleri disk serial verir                               | VPD page 0x80 Hyper-V'de bozuk (`storvsc_drv.c` workaround)                                                                                              | `serial` alanı **nullable**; kimlik page 0x83 → partuuid → ZFS label GUID sırasıyla |
| Staging ayrı bir ZFS dataset'i olur, publish `rename` ile atomik | Dataset'ler arası `rename()` **EXDEV**; reflink de sınırı geçmiyor. Her publish 10 GB kopyaya ve **atomik olmayan** bir işleme dönüşürdü                 | Staging hedefin **içinde**: `<dataset>/.depsis/staging/` → ADR-0008                 |
| Non-deterministic ICU collation ile Türkçe arama çözülür         | `ILIKE`/`SIMILAR TO`/regex non-det collation'da **hiçbir sürümde** desteklenmiyor; `LIKE` yalnız PG 18+; `pg_trgm` indekslenebilirliği **doğrulanmamış** | Normalize `GENERATED STORED` kolon + `pg_trgm` GIN → ADR-0010                       |
| `ENABLE ROW LEVEL SECURITY` kiracı yalıtımı sağlar               | Tablo sahibi RLS'i **atlar**; ayrıca UNIQUE/FK kontrolleri RLS'i **her zaman** atlayarak covert channel açar                                             | `FORCE RLS` + rol ayrımı + her UNIQUE kısıtında `organization_id` → ADR-0013        |
| Node 22 güncel LTS hedefidir                                     | v22 **Maintenance LTS**'te (2025-10'dan beri); Active LTS **24.19.0**                                                                                    | Hedef Node 24 → ADR-0002                                                            |
| Ambient capability'lerle aracı root olmadan çalışır              | `zpool`/mount delege edilemez; `CAP_SYS_ADMIN` **root-eşdeğeri**                                                                                         | Root çalışır, güvenlik **yüzey daraltmasından** gelir → ADR-0006                    |

## 6. Geri alma maliyeti

Düşük — bu ADR bir olgu kaydıdır, bir tasarım taahhüdü değil. Sürümler değiştikçe bu ADR
**superseded** edilip yenisi yazılır; içeriği düzeltilmez.
