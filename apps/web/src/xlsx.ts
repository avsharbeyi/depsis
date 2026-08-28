/**
 * Küçük, bağımlılıksız bir .xlsx yazıcısı.
 *
 * NEDEN CSV DEĞİL. Arşiv dışa aktarımı önce BOM'lu, noktalı virgüllü CSV'ydi ve sahibi sonucu
 * "bok gibi görünüyor" diye tarif etti — haklıydı: CSV'nin nasıl açılacağı Excel'in yerel
 * ayarına, sürümüne ve o günkü keyfine kalıyor; hücre içi satır sonları satırları kaydırıyor,
 * sütun genişliği diye bir kavram hiç yok. Gerçek bir .xlsx'te bunların hiçbiri yoruma açık
 * değil: hücre hücredir, sütunun genişliği dosyanın içinde yazar.
 *
 * NEDEN KÜTÜPHANESİZ. Bir xlsx, ZIP içinde birkaç XML. Sıkıştırmasız (STORE) ZIP yazmak CRC32
 * artı iki başlık düzeni demek — aşağıdaki ~yüz satır. Bunun için bir paket almak, tarayıcıya
 * yüzlerce kilobayt taşımak ve tedarik zincirine bir halka eklemek olurdu.
 *
 * Sınırlar bilinçli: tek sayfa, herkes metin hücresi (inlineStr), stil yok. Bir arşiv dökümünün
 * ihtiyacı bu; sayı biçimleri ve formüller gerektiğinde bu dosya büyür, bugün değil.
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** XML metin kaçışı. Excel, denetim karakterlerini reddediyor; satır sonu hariç eleniyorlar. */
function esc(value: string): string {
  return (
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
  );
}

/** A, B, … Z, AA, AB… — sütun numarasının Excel harfi. */
function column(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Sıkıştırmasız (STORE) ZIP. Yerel başlıklar + merkez dizin + son kayıt, başka hiçbir şey. */
function storeZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number): number[] => [
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0x0800), // UTF-8 adlar
      ...u16(0), // STORE
      ...u16(0),
      ...u16(0), // saat/tarih: 0 — bir dışa aktarımın anını dosya sistemi değil içindeki veri taşır
      ...u32(crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(name.length),
      ...u16(0),
    ]);
    chunks.push(local, name, entry.data);

    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(crc),
        ...u32(entry.data.length),
        ...u32(entry.data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      name,
    );
    offset += local.length + name.length + entry.data.length;
  }

  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);

  return new Blob([...chunks, ...central, end] as BlobPart[], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Tek sayfalık bir çalışma kitabı üret ve indirt.
 *
 * `widths` sütun genişlikleri, Excel'in kendi birimiyle (yaklaşık karakter); verilmezse 18.
 */
export function downloadXlsx(
  filename: string,
  sheetName: string,
  header: string[],
  rows: string[][],
  widths?: number[],
): void {
  const encoder = new TextEncoder();

  const cols = header
    .map(
      (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widths?.[i] ?? 18}" customWidth="1"/>`,
    )
    .join('');
  const row = (cells: string[], r: number): string =>
    `<row r="${r}">${cells
      .map(
        (value, i) =>
          `<c r="${column(i)}${r}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`,
      )
      .join('')}</row>`;

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${cols}</cols><sheetData>` +
    row(header, 1) +
    rows.map((cells, i) => row(cells, i + 2)).join('') +
    `</sheetData></worksheet>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
    `Target="worksheets/sheet1.xml"/></Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` +
    `Target="xl/workbook.xml"/></Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  const blob = storeZip([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rootRels) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheet) },
  ]);

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
