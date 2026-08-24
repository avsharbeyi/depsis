# ADR-XXXX: <karar başlığı>

- **Durum:** Proposed | Accepted | Accepted (provisional, PoC: P0-X) | Superseded by ADR-YYYY | Rejected
- **Tarih:** YYYY-MM-DD
- **Faz:** 0 | 1 | 2 | 3 | 4
- **Etkilenen bileşenler:** <apps/api, services/system-agent, ...>

## Bağlam

Hangi problem bu kararı gerektiriyor? Hangi kısıtlar var? Master prompt'un hangi maddesi
(§X.Y) bunu zorunlu kılıyor veya sınırlıyor?

## Değerlendirilen seçenekler

### Seçenek A — <ad>

- Artı:
- Eksi:

### Seçenek B — <ad>

- Artı:
- Eksi:

## Karar

Seçilen: **<seçenek>**

Gerekçe, ölçülebilir terimlerle. "Daha temiz" yeterli değildir; neyin ölçüldüğünü yaz.

## Kanıt

| İddia                     | Kaynak      | Güven                            |
| ------------------------- | ----------- | -------------------------------- |
| <mimariyi bağlayan iddia> | <resmî URL> | verified / inferred / unverified |

> `unverified` veya davranışsal bir iddia varsa: hangi PoC bunu ampirik olarak kanıtlayacak?
> PoC kimliği ve koşum çıktısının yolu (`docs/adr/evidence/...`) buraya yazılır.

## Sonuçlar

**Olumlu:**

**Olumsuz / kabul edilen bedel:**

**Bu kararın yasakladığı şeyler:** (ileride birinin sessizce ihlal etmemesi için)

## Geri alma maliyeti

Bu karar yanlış çıkarsa ne kaybedilir? Hangi fazda fark edilirse hâlâ ucuz olur?

## Güvenlik ve veri kaybı etkisi

Bu karar tehdit modelini nasıl değiştirir? Yeni bir güven sınırı ekliyor mu?
Veri kaybı senaryosu yaratıyor mu?

**Tehdit modelinde karşılığı:** <docs/threat-model/README.md §X | yeni bir yüzey eklemiyor>

Bu satır zorunlu ve boş bırakılamaz. Faz 0'da yazılan model "Faz 1 kodu yazıldıkça güncellenir"
diyordu ve altı yüzey — konsol, konteyner kataloğu, ZeroTier, bulk veri kanalı, SMB denetim akışı,
havuz oluşturma — modelde hiçbir karşılığı olmadan eklendi. Hiçbiri unutulmadı; hiçbirinin
unutulduğunu söyleyecek bir yer yoktu.
