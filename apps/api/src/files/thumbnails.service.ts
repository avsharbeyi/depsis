import { Injectable, Logger } from '@nestjs/common';
import { Writable } from 'node:stream';

import { AgentDataService } from '../agent/agent-data.service.js';
import { embeddedThumbnail, type EmbeddedThumbnail } from './exif-thumbnail.js';
import { FilesService } from './files.service.js';

/**
 * EXIF'in taşıyabileceği en fazlası 64 kB ve SOI'den hemen sonra geliyor (JPEG işaretçi uzunluğu
 * 16 bit). 128 kB fazlasıyla yetiyor, ve okunan miktarın sabit olması bu ucun maliyetini DOSYA
 * BOYUTUNDAN bağımsız yapıyor: 40 megabaytlık bir RAW da 2 megabaytlık bir fotoğraf da aynı
 * 128 kB'ı okutuyor.
 */
const HEAD_BYTES = 128 * 1024;

/**
 * Önbellekteki toplam bayt sınırı. Gerçek gömülü küçük resimler ~10 kB, yani bu birkaç bin satır
 * demek — bir ızgaranın birkaç sayfası. Sayı değil BAYT sınırı, çünkü sınırlanması gereken şey
 * bellek, ve satır başına boyut on kat değişebiliyor.
 */
const CACHE_BYTES = 32 * 1024 * 1024;

/** Bir cevap: küçük resim, ya da "bu dosyanın gömülü küçük resmi yok". Hata SAKLANMIYOR. */
type Cached = { hit: EmbeddedThumbnail } | { hit: null };

/**
 * Baytlar okunamadı — dosyada küçük resim OLMADIĞI anlamına gelmiyor.
 *
 * Kendi hatası, çünkü çağıranın vereceği cevap farklı: "küçük resmi yok" 204, "okuyamadım" 503.
 * İkisini bir araya getirmek, geçici bir aksaklığı kalıcı bir olguya çevirirdi.
 */
export class ThumbnailUnreadableError extends Error {
  constructor() {
    super('the file could not be read for a thumbnail');
    this.name = 'ThumbnailUnreadableError';
  }
}

/**
 * Gömülü küçük resimler (§7 önizleme).
 *
 * BU SUNUCU HİÇBİR GÖRÜNTÜNÜN KODUNU ÇÖZMÜYOR. Ayrıntısı `exif-thumbnail.ts`'te: telefon ve
 * fotoğraf makinesi JPEG'leri küçük resmi zaten içinde taşıyor, ve onu almak bayt dilimlemek.
 * Çözüm tarayıcıda yapılıyor — sandbox'lı, sürekli denetlenen ve bu iş için sertleştirilmiş olan
 * çözücüde.
 *
 * ÖNBELLEK BELLEKTE, diskte değil. Diskte bir önbellek bir dizin, bir yapılandırma, bir temizleme
 * işi ve yeniden başlatmada tutarlılık sorusu demek; bellekte olan, süreç ölünce gidiyor ve
 * yeniden üretilmesi 128 kB'lık bir okuma. Türetilmiş veri için doğru takas bu.
 *
 * OLUMSUZ CEVAP DA ÖNBELLEKLENİYOR, ve asıl kazanç orada: bir ekran görüntüsü klasöründe HİÇBİR
 * dosyanın gömülü küçük resmi yok, ve onu önbelleklemeden her ızgara çizimi dosya başına 128 kB
 * okurdu — yani hiçbir şey göstermek için en pahalı yol.
 */
@Injectable()
export class ThumbnailsService {
  private readonly logger = new Logger(ThumbnailsService.name);

  /**
   * `Map` ekleme sırasını koruyor, yani en eski anahtar `keys().next()`. Ayrı bir LRU yapısı
   * yerine bu: sınıra çarpıldığında baştan atmak, bir küçük resim önbelleği için yeterli ve
   * doğruluğu okunabilir.
   */
  private readonly cache = new Map<string, Cached>();
  private bytes = 0;

  constructor(
    private readonly files: FilesService,
    private readonly data: AgentDataService,
  ) {}

  /**
   * Bir dosyanın gömülü küçük resmi, ya da yoksa `null`.
   *
   * ÖNBELLEĞE AJANDAN ÖNCE BAKILIYOR, ve sebebi bir sızıntı: anahtar eskiden ajanın bildirdiği
   * boyutu içerdiği için önbelleğe bakmadan önce `open_download` çağrılıyordu, isabet hâlinde ise
   * dönen jeton hiç `receive` edilmiyordu. Ajan her açık jetonu 300 saniye `pending`'de tutuyor ve
   * okuma yönündeki bir jetonu geri verecek yol yok; 64 jeton dolunca her yükleme ve her indirme
   * "too many transfers are open" ile reddediliyordu. Yani 64'ten fazla fotoğraflı bir klasörün
   * İKİNCİ açılışı — bütün cevaplar önbellekten geldiği hâlde — cihazın aktarımlarını beş dakika
   * boyunca kilitliyordu.
   *
   * Anahtar bunun yerine SATIRIN kendi alanlarından kuruluyor: `sizeBytes` ve `updatedAt`. SMB
   * üzerinden değişen bir dosyayı uzlaştırma turu satıra yazıyor, yani satır değişince anahtar da
   * değişiyor. İki tur arasındaki aralık ise aşağıda kapatılıyor: diskteki boyut satırdakinden
   * farklıysa cevap üretiliyor ama önbelleğe YAZILMIYOR.
   */
  async of(
    entryId: string,
    sizeBytes: number,
    updatedAt: Date,
    shareName: string,
    components: string[],
    correlationId: string,
    reason: string,
  ): Promise<EmbeddedThumbnail | null> {
    const key = `${entryId}:${sizeBytes}:${updatedAt.getTime()}`;

    const known = this.cache.get(key);
    if (known !== undefined) {
      // Okunan her satır sona taşınıyor: `Map`'in sırası ekleme sırası, ve silip yeniden koymak
      // onu "en son kullanılan"a çeviriyor.
      this.cache.delete(key);
      this.cache.set(key, known);
      return known.hit;
    }

    // Boş dosya: cevabı satırdan verilebiliyor, ve ajanı HİÇ AÇMIYORUZ — açılmış bir okuma jetonu
    // tüketilmeden bırakılamıyor, o yüzden gereksiz açılan her jeton beş dakikalık bir sızıntı.
    if (sizeBytes === 0) {
      this.remember(key, { hit: null });
      return null;
    }

    const opened = await this.files.openDownload(shareName, components, correlationId, reason);
    // Diskteki boyut satırdakiyle uyuşmuyorsa dosya SMB'den değişmiş ve uzlaştırma turu satırı
    // henüz güncellememiş. Cevap yine üretiliyor — kullanıcı bir görüntü görüyor — ama ESKİ satır
    // anahtarının altına yazılmıyor; yoksa yeni dosyanın küçük resmi, satır güncellenene kadar eski
    // durumun cevabı olarak kalırdı.
    const fresh = opened.size === sizeBytes;

    const want = Math.min(opened.size, HEAD_BYTES);
    // Ajan sıfır bayt bildirdi ama satır bunu demiyordu (sıfır boyutlu satır yukarıda ayrıldı):
    // dosya değişmiş, yani cevap veriliyor ama saklanmıyor.
    if (want === 0) return null;

    // OKUNAMAMAK İLE "KÜÇÜK RESMİ YOK" AYRI ŞEYLER, ve ilk hâlde ikisi de `null` dönüyordu.
    // Sonuç iki kat kötüydü: uç 204 diyerek "bu fotoğrafta küçük resim yok" diye YANLIŞ bir şey
    // söylüyor, ve o yanlış cevap ÖNBELLEĞE giriyordu — yani ajanın bir anlık aksaklığı, o dosya
    // için kalıcı bir "küçük resmi yok" hâline dönüşüyordu. Bir önbellek, yalnız doğrulanmış
    // cevapları saklamalı.
    const head = await this.head(opened.token, want);
    if (head === null) throw new ThumbnailUnreadableError();

    const found = embeddedThumbnail(head);
    if (fresh) this.remember(key, found === null ? { hit: null } : { hit: found });
    return found;
  }

  /**
   * Dosyanın ilk `length` baytı, belleğe.
   *
   * `receive` bir `Writable` istiyor ve indirme yolu onu doğrudan HTTP cevabına bağlıyor; burada
   * toplayan bir hedef veriliyor. Sınır SABİT (128 kB), yani "belleğe toplamak" bu uçta dosya
   * boyutunun bir fonksiyonu değil.
   *
   * Hata YUTULUYOR ve `null` dönüyor: bir küçük resmin üretilememesi, dosya yöneticisinin
   * açılmamasına yol açmamalı. Kayıp olan şey bir görsel, ve satır adıyla yine orada.
   */
  private async head(token: string, length: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    try {
      await this.data.receive(token, 0, length, sink);
      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.warn(
        `could not read the head of a file for its thumbnail: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private remember(key: string, value: Cached): void {
    const size = value.hit === null ? 0 : value.hit.bytes.length;
    this.cache.set(key, value);
    this.bytes += size;
    while (this.bytes > CACHE_BYTES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      const dropped = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.bytes -= dropped?.hit === null || dropped === undefined ? 0 : dropped.hit.bytes.length;
    }
  }
}
