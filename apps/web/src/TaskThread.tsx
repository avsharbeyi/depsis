import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { api, problemMessage } from './api.js';
import { when } from './Notifications.js';

type Comment = OpenApi.components['schemas']['TaskComment'];
type Watcher = OpenApi.components['schemas']['TaskWatcher'];

/**
 * Bir işin tartışması ve izleyicileri (§7).
 *
 * KENDİ BİLEŞENİ, ve satırın içinde açılıyor. Ayrı bir pencere olsaydı, konuşmayı okurken işin
 * durumu görünmezdi — ve bir yorumun neredeyse tamamı o duruma bir cevap.
 *
 * YALNIZ AÇILDIĞINDA YÜKLENİYOR. Panodaki her iş için bir yorum listesi çekmek, otuz işlik bir
 * panoda otuz istek demek; ve o isteklerin hepsi, kimsenin bakmadığı bir liste için.
 */
export function TaskThread({
  taskId,
  me,
  isAdmin,
  onError,
}: {
  taskId: string;
  /** Çağıranın kullanıcı adı. Silme düğmesinin kime çizileceğini bu belirliyor. */
  me: string;
  isAdmin: boolean;
  onError: (text: string) => void;
}): ReactElement {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [watching, setWatching] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /** Okunamadı ile "henüz yorum yok" ayrı şeyler; ikisini aynı ekrana çevirmek bir yalan. */
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [thread, who] = await Promise.all([
      api.GET('/tasks/{id}/comments', { params: { path: { id: taskId } } }),
      api.GET('/tasks/{id}/watchers', { params: { path: { id: taskId } } }),
    ]);
    // Sessizce dönmek panelin sonsuza kadar "Yükleniyor…" göstermesi demekti: kullanıcı bekliyor,
    // hiçbir şey gelmiyor, ve ekranda bir şeyin bozulduğuna dair tek bir işaret yok.
    if (thread.data === undefined) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setComments(thread.data.items);
    if (who.data !== undefined) {
      setWatchers(who.data.items);
      setWatching(who.data.watching);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async (): Promise<void> => {
    const body = draft.trim();
    if (body === '' || busy) return;
    setBusy(true);
    const { data, error } = await api.POST('/tasks/{id}/comments', {
      params: { path: { id: taskId } },
      body: { body },
    });
    setBusy(false);
    if (data === undefined) {
      onError(problemMessage(error, 'Yorum gönderilemedi.'));
      return;
    }
    // Taslak yalnız BAŞARIDAN sonra temizleniyor. Reddedilen bir yorumu kaybetmek, kullanıcıya
    // yazdığını yeniden yazdırmak demek — ve reddin sebebi çoğu zaman uzunluk, yani en pahalı
    // kaybedilecek metin.
    setDraft('');
    // Listeyi yeniden çekmek yerine ekliyor: sunucunun döndürdüğü satır zaten kanonik hâli, ve
    // ikinci bir istek aynı cevabı bir tur gecikmeyle getirirdi.
    //
    // AMA yalnız liste GELDİYSE. `current ?? []` yazmak, henüz yüklenmemiş bir tartışmayı tek
    // satırlık bir listeye çevirirdi — önceki bütün yorumlar ekrandan kaybolur, ve yükleme
    // bittiğinde geri gelirlerdi. Yüklenmemişse yeniden çekiliyor.
    setComments((current) => (current === null ? null : [...current, data]));
    if (comments === null || !watching) void load();
  }, [busy, comments, draft, load, onError, taskId, watching]);

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const { error, response } = await api.DELETE('/tasks/{id}/comments/{commentId}', {
        params: { path: { id: taskId, commentId: id } },
      });
      if (!response.ok) {
        onError(problemMessage(error, 'Yorum silinemedi.'));
        return;
      }
      // Satır kalıyor, gövdesi gidiyor — sunucudaki yumuşak silmenin ekrandaki karşılığı, ve
      // listeden çıkarmak konuşmada açıklanamayan bir boşluk bırakırdı.
      setComments((current) =>
        (current ?? []).map((c) => (c.id === id ? { ...c, deleted: true, body: '' } : c)),
      );
    },
    [onError, taskId],
  );

  const toggleWatch = useCallback(async (): Promise<void> => {
    const next = !watching;
    const { response, error } = next
      ? await api.PUT('/tasks/{id}/watch', { params: { path: { id: taskId } } })
      : await api.DELETE('/tasks/{id}/watch', { params: { path: { id: taskId } } });
    if (!response.ok) {
      onError(problemMessage(error, 'İzleme değiştirilemedi.'));
      return;
    }
    setWatching(next);
    void load();
  }, [load, onError, taskId, watching]);

  return (
    <div className="thread">
      <div className="thead">
        <button
          type="button"
          className={watching ? 'lnk on' : 'lnk'}
          aria-pressed={watching}
          onClick={() => void toggleWatch()}
        >
          {watching ? '👁 İzliyorsun' : '👁 İzle'}
        </button>
        {watchers.length > 0 && (
          <span className="tw" title={watchers.map((w) => w.username ?? '—').join(', ')}>
            {watchers.length} izleyici
          </span>
        )}
      </div>

      {failed && <p className="note">Yorumlar okunamadı.</p>}
      {!failed && comments === null && <p className="note">Yükleniyor…</p>}
      {comments !== null && comments.length === 0 && <p className="note">Henüz yorum yok.</p>}

      {(comments ?? []).map((comment) => (
        <div className={comment.deleted ? 'cmt gone' : 'cmt'} key={comment.id}>
          <div className="chead">
            {/* Hesap silinmişse yorum kalıyor ama adı gitmiş oluyor: yorum işin bilgisi, yazanın
                hesabının bir eklentisi değil. */}
            <b>{comment.authorUsername ?? 'Silinmiş hesap'}</b>
            <span className="s">{when(comment.createdAt)}</span>
            {comment.editedAt !== null && <span className="s">· düzenlendi</span>}
            {/* Yalnız silebilecek kişiye. Herkese çizilen bir çarpı, basıldığında 403 dönen bir
                düğme demekti — ve çalışıyormuş gibi duran bir kontrol, hiç olmayandan kötü.
                Sunucudaki kural burada İKİNCİ KEZ yazılmıyor, GÖRÜNÜRLÜĞE çevriliyor: reddi hâlâ
                sunucu veriyor, bu yalnız onu istemeyerek tetiklememek için. */}
            {!comment.deleted && (isAdmin || comment.authorUsername === me) && (
              <button
                type="button"
                className="del"
                aria-label="Yorumu sil"
                title="Yorumu sil"
                onClick={() => void remove(comment.id)}
              >
                ✕
              </button>
            )}
          </div>
          {/* Silinmiş bir yorum LİSTEDE KALIYOR ve silindiğini söylüyor. Sessizce kaybolan bir
              replika, okuyanı kendi hafızasından şüphe ettirir. */}
          <div className="cbody">
            {comment.deleted ? <i>Bu yorum silindi.</i> : highlight(comment.body)}
          </div>
        </div>
      ))}

      <div className="cadd">
        <textarea
          value={draft}
          rows={2}
          maxLength={4000}
          aria-label="Yorum yaz"
          placeholder="Yorum yaz — @ ile birini an, Ctrl+Enter ile gönder"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Ctrl+Enter, düz Enter DEĞİL: bir yorum kutusu çok satırlı, ve Enter'ın göndermesi
            // paragraf yazmayı imkânsız kılardı.
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="b pri"
          disabled={busy || draft.trim() === ''}
          onClick={() => void send()}
        >
          Gönder
        </button>
      </div>
    </div>
  );
}

/**
 * `@ad` geçen yerleri işaretle.
 *
 * YALNIZ BİÇİM, çözüm değil: bu kod bir adın gerçek bir kullanıcı olup olmadığını bilmiyor ve
 * bilmemeli — bildirimi kimin alacağına sunucu karar veriyor, ve istemcinin ikinci bir cevap
 * üretmesi zamanla ayrışan iki cevap demek. Buradaki tek iddia "burada bir anma var gibi
 * görünüyor", ki okuyan için de zaten o kadarı doğru.
 *
 * Desen sunucudakinin aynısı; farklı olsaydı, işaretlenen ile bildirim alan ayrışırdı.
 */
const MENTION = /(^|[^\w.@-])(@[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/gu;

/**
 * Cümle sonundaki noktalama boyamanın DIŞINDA kalıyor.
 *
 * Sunucu belirsizliği kullanıcı listesine soruyor ve var olan en uzun adı seçiyor; istemcinin öyle
 * bir listesi yok. Elindeki en iyi tahmin, sondaki `.`/`-`/`_` işaretlerinin cümlenin parçası
 * olduğu — ve "Bak @ayse." yazan biri o noktanın vurgulanmasını beklemiyor. Yanlış tarafa düşerse
 * kaybedilen tek şey birkaç pikselin rengi; bildirimi kimin aldığına yine sunucu karar veriyor.
 */
function paintable(name: string): string {
  let out = name;
  while (out.length > 2 && /[._-]$/u.test(out)) out = out.slice(0, -1);
  return out;
}

function highlight(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let key = 0;
  for (const match of body.matchAll(MENTION)) {
    const lead = match[1] ?? '';
    const name = paintable(match[2] ?? '');
    const start = (match.index ?? 0) + lead.length;
    if (start > at) out.push(body.slice(at, start));
    out.push(
      <em className="mention" key={`m${key++}`}>
        {name}
      </em>,
    );
    at = start + name.length;
  }
  if (at < body.length) out.push(body.slice(at));
  return out;
}
