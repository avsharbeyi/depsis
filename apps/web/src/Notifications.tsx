import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { api } from './api.js';
import { sfx } from './sfx.js';
import type { PaneId } from './App.js';

type Notification = OpenApi.components['schemas']['Notification'];

/** Bildirimler ne sıklıkta yenileniyor. Olay akışı henüz bildirim taşımıyor. */
const POLL_MS = 60_000;

/**
 * Bildirim merkezi (§7): üst çubuktaki zil ve altındaki panel.
 *
 * ZİL SAYIYI SUNUCUDAN ALIYOR, listeden saymıyor. Liste yüz satırla sınırlı ve okunmamışa
 * filtrelenebiliyor; ikisi de sayıyı yanlış yapardı, ve yanlış bir rozet, bildirim merkezini
 * insanların bakmayı bıraktığı bir yere çeviren şeyin ta kendisi.
 *
 * AÇMAK OKUNDU DEMEK DEĞİL. Bir paneli açmak "gördüm" anlamına gelmiyor — yanlış tuşa basmak da
 * paneli açıyor — ve otomatik okundu işaretlemek, kullanıcının bir daha asla bulamayacağı bir
 * hatırlatma üretiyor. İşaretleme bir tıklamayla oluyor: satırın kendisi, ya da "hepsi".
 */
export function Notifications({
  onOpenPane,
}: {
  onOpenPane: (pane: PaneId) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    const { data } = await api.GET('/notifications', {});
    if (data === undefined) return;
    setItems(data.items);
    setUnread(data.unread);
    setLoaded(true);
  }, []);

  // Panel KAPALIYKEN de dönüyor: zilin sayısı ancak sorulursa güncelleniyor, ve yalnız açıkken
  // yenilemek, bir kez bakıp kapatan birine sonsuza kadar eski bir sayı gösterirdi.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Masaya tıklamak paneli kapatıyor — üst çubuğun güç menüsüyle aynı davranış, aynı sebeple:
  // bunlar pencere değil, çapalanmış paneller, ve odak tuzakları yok.
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: MouseEvent): void => {
      const target = event.target as Node;
      const inside = (node: HTMLElement | null): boolean => node !== null && node.contains(target);
      if (!inside(button.current) && !inside(panel.current)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const markRead = useCallback(async (ids: string[] | undefined): Promise<void> => {
    // `ids` verilmezse gövdesiz istek: sunucuda ikisi de "hepsi" demek.
    const { data } = await api.POST('/notifications/read', {
      body: ids === undefined ? {} : { ids },
    });
    if (data === undefined) return;
    setUnread(data.unread);
    const now = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        (ids === undefined || ids.includes(item.id)) && item.readAt === null
          ? { ...item, readAt: now }
          : item,
      ),
    );
  }, []);

  return (
    <>
      <button
        type="button"
        className={unread > 0 ? 'tbtn bell has' : 'tbtn bell'}
        aria-label={unread > 0 ? `Bildirimler: ${unread} okunmamış` : 'Bildirimler'}
        aria-expanded={open}
        ref={button}
        onClick={() => {
          sfx.click();
          setOpen((was) => !was);
          if (!open) void load();
        }}
      >
        <span aria-hidden>🔔</span>
        {/* Rozet yalnız bir şey varken. Sıfır yazan bir rozet, göz için bir şey varmış gibi
            görünen bir şey — ve her bakışta bir kez daha bakılıyor. */}
        {unread > 0 && <b className="badge">{unread > 99 ? '99+' : unread}</b>}
      </button>

      {/* Panel GÖVDEYE portallanıyor, üst çubuğun içine değil.
          `.top` bir flex satırı ve `z-index: 6` ile kendi yığma bağlamını kuruyor; içindeki
          `position: fixed` bir panel, sayfanın geri kalanının üstünde durması gereken bir katmanı
          o bağlamın içine hapsediyor. Stil sayfasının kendi notu (styles.css:22) bunu zaten
          söylüyor — `.pmenu` dahil bütün örtüler sabit, ve güç menüsü de bu yüzden `</header>`'ın
          DIŞINDA duruyor. Zil düğmesi çubukta kalıyor; açtığı şey kalmıyor. */}
      {createPortal(
        <div className={open ? 'pmenu top notif on' : 'pmenu top notif'} ref={panel}>
          <div className="pmh">
            <span>Bildirimler</span>
            {unread > 0 && (
              <button type="button" className="lnk" onClick={() => void markRead(undefined)}>
                Hepsini okundu yap
              </button>
            )}
          </div>

          {!loaded && <p className="note">Yükleniyor…</p>}
          {loaded && items.length === 0 && <p className="note">Yeni bir şey yok.</p>}

          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.readAt === null ? 'nrow new' : 'nrow'}
              onClick={() => {
                if (item.readAt === null) void markRead([item.id]);
                // İşe götürüyor. Bir hatırlatmanın tek işe yarar tarafı, hatırlattığı şeye
                // gidebilmek — ve bildirim penceresi kapanıyor çünkü işi görev panosu gösteriyor.
                if (item.taskId !== null && item.taskId !== undefined) {
                  setOpen(false);
                  onOpenPane('tasks');
                }
              }}
            >
              <span className={`dotk k-${item.kind.replace('.', '-')}`} aria-hidden />
              <span className="tx">
                <span className="t">{item.title}</span>
                <span className="s">{when(item.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * "3 dakika önce" — bir tarih değil.
 *
 * Bir bildirim her zaman YAKIN geçmişte, ve "22.08.2026 14:03" okuyan kişinin kafasından bir
 * çıkarma yapmasını istiyor. Bir hafta öteye geçince tarih yeniden doğru cevap oluyor, çünkü
 * "9 gün önce" de aynı çıkarmayı ters yönde istiyor.
 */
export function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'az önce';
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} gün önce`;
  return new Date(iso).toLocaleDateString('tr-TR');
}
