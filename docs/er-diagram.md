# DEPSIS veri modeli — ER diyagramı

§21'in 5. teslimatı. Şema `packages/db/migrations/` içindeki göçlerden çıkıyor (bugün 36); bu belge onların
**okunabilir** hâli, kaynağı değil. İkisi ayrışırsa göçler haklıdır.

Diyagramın taşımadığı iki şey var ve ikisi de bu şemanın en önemli özellikleri, o yüzden altta
yazıyla duruyorlar: **kiracı yalıtımı** ve **kimin neye erişebildiği**.

---

## 1. Kiracılık: neredeyse her ok aynı yere gidiyor

Yirmi dokuz tablonun yirmi beşi `organizations`'a bağlı, ve bu bir tasarım tercihi değil
ADR-0015'in kendisi: her satır bir kiracıya ait, ve hangi kiracıya ait olduğu satırın kendisinde
yazıyor. Bunu diyagrama tek tek çizmek elli dört okun yirmi beşini "her şey buraya" demek için
harcamak olurdu, o yüzden aşağıdaki diyagramlarda `organization_id` **çizilmiyor** — istisnaları
saymak daha kısa:

| Tablo            | Neden kiracısız                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `organizations`  | Kiracının kendisi.                                                                                                |
| `system_setup`   | İlk kiracıyı var eden satır, yani zorunlu olarak ondan önce gelir (ADR-0015 §5d).                                 |
| `login_attempts` | Var olmayan bir kısa ada yapılan deneme hiçbir kiracıya atfedilemez, ve kısıtlama tam o noktada çalışmak zorunda. |
| `app_catalogue`  | Cihaz genelinde bir katalog; kurulum (`app_instances`) kiracıya ait.                                              |
| `job_history`    | Biten işler; `job_queue`'nun aksine sorgulanmıyor, arşivleniyor.                                                  |

---

## 2. Kimlik ve erişim

```mermaid
erDiagram
    organizations ||--o{ users : "barındırır"
    organizations ||--o{ teams : ""
    users ||--o{ team_members : ""
    teams ||--o{ team_members : ""
    users ||--o{ sessions : "açar"
    users ||--o| user_totp_secrets : "ikinci faktör"
    users ||--o{ user_recovery_codes : "tek kullanımlık"
    users ||--o{ pending_logins : "parola geçti, faktör bekliyor"
    users ||--o{ password_resets : "yönetici bileti"
    users |o--o{ audit_events : "kim yaptı — hesap silinse satır kalır"
    users ||--o| user_preferences : ""
    organizations ||--o| organization_settings : ""
    organizations ||--o| system_setup : "ilk yönetici"

    users {
        uuid id PK
        text username_folded UK "SMB adı; kıvrılmış, çünkü SMB büyük-küçük ayırmıyor"
        text password_hash "argon2id; NULL = parolasız hesap"
        text role "admin | member"
        bytea nt_hash "SMB için, şifreli; anahtar yoksa YAZILMIYOR"
        timestamptz disabled_at
    }
    sessions {
        uuid id PK
        text token_hash UK "çerezdeki değer DEĞİL, özeti"
        timestamptz expires_at
    }
    teams {
        uuid id PK
        integer posix_gid UK "NULL = dosya sistemine henüz yansımadı"
    }
```

**`username_folded` neden ayrı bir sütun.** SMB istemcileri `Ayse` ile `ayse`'yi aynı ad sayıyor,
PostgreSQL saymıyor. Benzersizlik kıvrılmış hâl üzerinde; gösterilen ad ayrı duruyor.

**`posix_gid` neden NULL olabiliyor.** Bir ekip önce veritabanında var oluyor, sonra ayrıcalıklı
ajan ona bir grup açıyor. Aradaki durum gerçek ve arayüzde "dosya sistemine yansımadı" diye
görünüyor — sahte bir gid yazmak, hiçbir şeyin uygulamadığı bir izin demek olurdu.

---

## 3. Dosyalar ve izinler

```mermaid
erDiagram
    organizations ||--o{ shares : ""
    shares ||--o{ file_entries : "içerir"
    file_entries ||--o{ file_entries : "parent_id"
    file_entries ||--o{ folder_grants : "kime açık"
    teams ||--o{ folder_grants : ""
    users ||--o{ folder_grants : ""
    shares ||--o{ folder_grants : ""
    shares ||--o{ index_queue : "değişen dizinler"
    shares ||--o{ upload_sessions : ""
    file_entries ||--o{ upload_sessions : "yayımlanacak satır"

    shares {
        uuid id PK
        text name UK "kıvrılmış benzersiz; SMB bölüm adı"
        text dataset "tank/depsis/<ad>"
        boolean read_only
    }
    file_entries {
        uuid id PK
        uuid parent_id FK "NULL = paylaşım kökü"
        text kind "file | folder"
        text path "TÜRETİLMİŞ kolaylık; otorite parent zinciri"
        bigint size_bytes "klasörde 0'a sabit"
        timestamptz trashed_at "çöp bir SÜTUN, klasör değil"
        uuid copied_from_entry_id FK "yeniden teslimi soğurur"
    }
    folder_grants {
        uuid id PK
        uuid file_entry_id FK "NULL = paylaşımın kökü"
        text permissions "list|read|write|delete|manage"
    }
    index_queue {
        uuid organization_id PK
        uuid share_id PK
        text path PK "DİZİN, dosya değil"
        timestamptz seen_at
    }
```

**`path` otorite değil.** Yeniden adlandırma alt ağacın `path`'ini güncelliyor, ama "bu klasör
nerede" sorusunun cevabı `parent_id` zinciri. İkisi ayrışırsa — yayılmamış bir yeniden adlandırma
— yürüyüş zinciri izliyor, çünkü ürünün geri kalanı onu kullanıyor.

**`trashed_at` bir sütun, çöp bir klasör değil.** Baytlar yerinde duruyor. İndeksleme yürüyüşünün
çöpteki satırları "adını hesaba katıp başka hiçbir işlem yapmadan" geçmesinin sebebi bu: onları
hariç tutmak, kullanıcının zaten sildiği şey için her on beş dakikada bir İKİNCİ satır yazardı.

**`index_queue`'nun birincil anahtarı yolu içeriyor.** Bir klasöre on bin dosya kopyalanması on bin
satır değil, `seen_at`'i ilerleyen tek satır: kuyruk olay sayısıyla değil DEĞİŞEN DİZİN sayısıyla
büyüyor.

---

## 4. İşler, aktarımlar ve sistem

```mermaid
erDiagram
    organizations ||--o{ job_queue : ""
    job_queue ||--o| job_history : "biten satır buraya taşınır"
    organizations ||--o{ snapshots : ""
    organizations ||--o{ notes : ""
    organizations ||--o{ remote_networks : ""
    organizations ||--o{ idempotency_keys : ""
    app_catalogue ||--o{ app_instances : ""
    organizations ||--o{ app_instances : ""
    organizations ||--o{ console_sessions : ""
    console_sessions ||--o{ console_commands : "denetim izi"

    job_queue {
        uuid id PK
        text kind "files.copy | storage.pool.create | ..."
        jsonb payload
        text status "queued|running|succeeded|failed|dead"
        integer attempt
        integer max_attempts
        timestamptz lease_until "süresi dolan = çökmüş işçi"
        timestamptz run_after "TEK dayanıklı zamanlayıcı"
    }
    idempotency_keys {
        text key PK
        bytea fingerprint "sha256; aynı anahtar + başka gövde = 409"
        jsonb response
    }
    console_commands {
        uuid id PK
        text command "ne yazıldığı; §16"
    }
```

**`run_after` tek dayanıklı zamanlayıcı.** TypeScript tarafında `setInterval` yok: yalnız o süreç
ayaktayken çalışan ve yeniden başlatmada kaybolan bir zamanlayıcı, bir saklama politikasının
sessizce durması demek. Her çalışma bir sonrakini kuyruğa alıyor.

**`lease_until` çökme tespitinin kendisi.** Ayrı bir kalp atışı tablosu yok. Ve `claim_job` kirası
dolmuş `running` bir işi `max_attempts`'e BAKMADAN geri alıyor — sayaç yalnız `finish_job`'da,
`failed` ile `dead` arasında seçim için okunuyor. Yani `max_attempts: 1`, bildirilmiş bir hatadan
sonraki yeniden denemeyi engelliyor; çökmüş bir işçinin işinin geri alınmasını değil.

---

## 5. Masa: işler ve bildirimler

```mermaid
erDiagram
    organizations ||--o{ tasks : ""
    users ||--o{ tasks : "atanan"
    tasks ||--o{ task_activity : "ne değişti, kim değiştirdi"
    tasks ||--o{ task_file_links : ""
    file_entries ||--o{ task_file_links : ""
    tasks ||--o{ tasks : "parça (TEK seviye)"
    tasks ||--o{ task_checklist_items : ""
    tasks ||--o{ task_tag_links : ""
    task_tags ||--o{ task_tag_links : ""
    tasks ||--o{ task_comments : ""
    tasks ||--o{ task_watchers : ""
    users ||--o{ task_watchers : "abone"
    tasks ||--o{ notifications : ""
    users ||--o{ notifications : "ALICI"

    tasks {
        uuid id PK
        text status "draft|assigned|in_progress|in_review|done|cancelled"
        text priority "low|normal|high|urgent"
        timestamptz due_at "NULL = son tarih yok"
        uuid assignee_id FK "NULL = kimseye atanmamış"
        uuid created_by FK
        uuid parent_id FK "NULL = üst seviye; tetikleyici tek seviye tutuyor"
    }
    task_checklist_items {
        uuid id PK
        text body
        timestamptz done_at "NULL = yapılmadı"
        uuid done_by FK "silinen hesapta NULL"
        float position "sürüklemek tek UPDATE"
    }
    task_tags {
        uuid id PK
        text name
        text name_folded "GENERATED; benzersizlik bunun üstünden"
        text color "sabit palet"
    }
    task_activity {
        uuid id PK
        text field "hangi alan"
        text before
        text after
    }
    task_file_links {
        uuid id PK
        uuid task_id FK
        uuid entry_id FK
    }
    task_comments {
        uuid id PK
        uuid author_id FK "silinen hesapta NULL; yorum kalır"
        text body "silinince de KALIR"
        timestamptz deleted_at "yumuşak silme"
        timestamptz edited_at "NULL = hiç düzenlenmedi"
    }
    task_watchers {
        uuid id PK
        uuid user_id FK
        text source "manual|created|assigned|commented"
    }
    notifications {
        uuid id PK
        uuid user_id FK "ALICI, aktör değil"
        text kind "task.assigned|task.unassigned|task.status|task.due|task.overdue"
        uuid task_id FK "NULL olabilir"
        text title "O AN üretilmiş cümle"
        timestamptz read_at "NULL = okunmamış"
    }
```

**Etiket KİRACININ SÖZLÜĞÜ, işin bir alanı değil.** `tasks` üzerinde bir metin dizisi daha az
tablo olurdu ve bir sözlüğün çözdüğü şeyi çözmezdi: "acil", "Acil" ve "acıl" üç ayrı etiket olur ve
kimse hangisini yazdığını hatırlamaz. Benzersizlik `name_folded` üzerinden — `fold_identity`, yani
kullanıcı adlarındaki aynı fonksiyon: büyük/küçük harf ve Türkçe i ailesi katlanıyor, **aksanlar
katlanmıyor** ("Çağrı" ile "Cagri" ayrı, çünkü arama için doğru olan kimlik için yanlış).

**Renk sabit bir paletten**, serbest bir hex alanı değil: karanlık zemine karşı görünmeyen bir
etiket, olmayan bir etiket.

**Herkes etiket oluşturup takabiliyor, yalnız yönetici yeniden adlandırıp silebiliyor.** İkisi de
kiracı çapında — bir adı değiştirmek onu kullanan her işin anlamını değiştiriyor, silmek her işten
kaldırıyor. Oluşturmayı da yöneticiye kilitlemek ise etiketlemeyi bir talep sürecine çevirir ve
kimse kullanmaz.

**Alt görev bir SÜTUN, yeni bir tablo değil.** Bir alt görev tam olarak bir görev: atanabiliyor,
kendi durumu, önceliği, son tarihi, yorumu ve izleyicisi oluyor. Ayrı bir tablo bunların hepsinin
ikinci bir kopyasını gerektirirdi, ve o kopyalar zamanla ayrışırdı.

**TEK SEVİYE, ve onu `tasks_one_level_deep` TETİKLEYİCİSİ tutuyor.** Kural bir CHECK ile ifade
edilemiyor çünkü başka bir satıra bakması gerekiyor; yalnız serviste tutulsaydı, ikinci bir yazma
yolu açıldığı gün sessizce kaybolurdu. Üç şeyi birden reddediyor: bir alt görevin kendi alt görevi,
bir işin kendine ebeveynliği, ve parçaları olan bir işin başka bir şeyin parçası olması. Keyfi
derinlikte bir ağaç, bir yapılacaklar panosunu bir dosya yöneticisine çevirir.

**Kontrol listesi maddesi bir alt görev DEĞİL, ve ikisi birden var.** Bir madde atanamıyor, son
tarihi yok, bildirim üretmiyor. Bunlardan herhangi birini isteyen şey zaten bir alt görev; biri
eksik olsaydı insanlar ötekini onun yerine kullanırdı, ve ikisi de kötü olurdu — her adım için ayrı
bir iş açmak panoyu okunmaz yapıyor, tek bir gövdeye madde madde yazmak hiçbirini takip edilebilir
yapmıyor.

**`task_watchers` bir TAHMİNİN yerini aldı.** Bildirim bir zamanlar "atanan + oluşturan" diyordu,
ve o çoğu zaman doğru cevaptı — ama yalnızca çoğu zaman, ve yanlış olduğunda hiçbir belirti
vermiyordu. İş oluşturmak, atanmak ve yorum yazmak otomatik abone ediyor, yani eski davranış hâlâ
varsayılan; artık ilgilenen üçüncü bir kişinin de bir yolu var. **Anılmak abone ETMİYOR:** bir kez
anılmanın kişiyi işin bütün gelecek gürültüsüne kaydetmesi, insanların bildirimleri okumayı bırakma
sebebi.

**Yorumlar YUMUŞAK siliniyor** ve `task_comments`'ta `DELETE` yetkisi yok — silme bir `UPDATE`.
Gövde tabloda kalıyor, API onu bir daha döndürmüyor, ve `task_activity`'ye bir denetim satırı
düşüyor. Uygulamanın satırı gerçekten kaldıracak bir yolu olmaması, yumuşak silmenin yumuşak
kalmasının tek garantisi.

**Mention'ın kendi tablosu YOK, ve bilerek.** Bir mention gövdenin içinde yaşıyor; onu ayrıca
saklamak, gövdeyle ayrışabilen ikinci bir doğruluk kaynağı olurdu. Kalıcı olan şey, çözümün o an
ürettiği BİLDİRİM — yani "kime gitti" sorusunun cevabı, adların bugünkü hâline değil o günküne
bağlı.

**Bildirim ALICI BAŞINA bir satır, olay başına değil.** Bir işin el değiştirmesi tek olay ama iki
farklı cümle: yeni atanan "sana bir iş atandı" okuyor, eski atanan "bu iş artık sende değil". Tek
satırla ikisinden biri yanlış cümleyi görürdü.

**`title` o an donduruluyor, `task_id` ise canlı.** Bildirim "ne olmuştu" sorusunu, işin kendisi
"şimdi ne durumda" sorusunu cevaplıyor; ikisi farklı sorular ve zamanla farklı cevaplar veriyorlar.

**Kimse kendi yaptığı şey için bildirim almıyor**, ve bu bir görgü kuralı değil bir işlevsellik
kararı: sürekli yanan bir zil okunmayan bir zile dönüşüyor.

**`notifications` üzerinde kısmi benzersiz indeks var** — `(organization_id, user_id, task_id,
kind)`, yalnız `read_at IS NULL` ve `task_id IS NOT NULL` için. Gecikme taraması on beş dakikada
bir koşuyor ve onsuz gecikmiş bir iş bir haftada bin satır üretirdi.

**RLS kiracıyı tutuyor, kişiyi SORGU tutuyor.** Politika `depsis.organization_id`'yi biliyor,
oturumdaki kullanıcıyı bilmiyor — `depsis.user_id` diye bir oturum değişkeni yok. Yani "başkasının
bildirimini okuyamazsın" cümlesini tutan tek şey her sorgudaki `user_id`, ve bu bilinçli: ikinci bir
oturum değişkeni eklemek, unutulduğunda SESSİZCE herkesin her şeyi gördüğü bir sistem üretirdi.
İkinci bir oturum değişkeni yoksa o risk kiracı sınırını geçemiyor.

---

## 6. Diyagramın gösteremediği: satır düzeyi güvenlik

Yukarıdaki okların hiçbiri erişim kontrolü değil. Kiracı yalıtımını **RLS** yapıyor:

- Her kiracılı tabloda `FORCE ROW LEVEL SECURITY`, yani tablonun sahibi bile atlayamıyor.
- Politika `current_setting('depsis.organization_id')` ile karşılaştırıyor, ve o değer her
  işlemin başında `SET LOCAL` ile konuyor — bind parametresiyle değil, çünkü `SET LOCAL` bir bind
  parametresi kabul etmiyor ve bunu sanmak sessizce yanlış kiracıyı seçmenin yoludur.
- Bağlantı havuza dönerken bağlam kayboluyor; bu, tümleşik testlerde ölçülüyor.

Klasör erişimini ise `folder_grants` **ve** dosya sistemindeki POSIX ACL'ler birlikte belirliyor.
Veritabanı web arayüzünü, ACL'ler SMB'yi yönetiyor, ve ikisi aynı tablodan türetiliyor — çünkü SMB
API'den hiç geçmiyor ve yalnız mod bitlerini uyguluyor. Bir tanesini güncelleyip diğerini
güncellememek, "izni kaldırdım" ile "erişim gerçekten kapandı" arasındaki farktır (ADR-0004).
