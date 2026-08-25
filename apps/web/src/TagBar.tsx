import type { OpenApi } from '@depsis/contracts';
import { useCallback, useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';

export type Tag = OpenApi.components['schemas']['Tag'];
export type TagColor = Tag['color'];

/** Şemadaki `task_tags_color_known` ile aynı küme, aynı sırada. */
export const TAG_COLORS: readonly TagColor[] = ['iris', 'mint', 'cyan', 'amber', 'rose', 'slate'];

/**
 * Panonun üstündeki etiket şeridi: süzme, ve yönetici için sözlüğün bakımı.
 *
 * SÜZME HERKESE, BAKIM YÖNETİCİYE. Bir adı değiştirmek onu kullanan her işin anlamını
 * değiştiriyor, silmek her işten kaldırıyor — ikisi de kiracı çapında, ve bir üyenin yanlışlıkla
 * yaptığı bir şeyin otuz işi etkilemesi geri alınması en zor hata sınıfı. Sunucu bunu zaten
 * reddediyor; buradaki iş, çalışmayacak bir düğmeyi hiç göstermemek.
 */
export function TagBar({
  tags,
  selected,
  isAdmin,
  onToggle,
  onChanged,
  onError,
}: {
  tags: Tag[];
  /** Seçili etiket kimlikleri. Boşsa süzme yok. */
  selected: readonly string[];
  isAdmin: boolean;
  onToggle: (tagId: string) => void;
  /** Sözlük değişti; pano onu yeniden okusun. */
  onChanged: () => void;
  onError: (text: string) => void;
}): ReactElement | null {
  const [editing, setEditing] = useState(false);

  // Etiketi olmayan bir kiracıda şerit HİÇ ÇİZİLMİYOR. Boş bir süzgeç çubuğu, panonun üstünde
  // hiçbir şey yapmayan bir satır — ve etiketler tartışma panelinden oluşturuluyor, buradan değil.
  if (tags.length === 0) return null;

  return (
    <div className="tagbar">
      {tags.map((tag) =>
        editing && isAdmin ? (
          <TagEditor key={tag.id} tag={tag} onChanged={onChanged} onError={onError} />
        ) : (
          <button
            key={tag.id}
            type="button"
            className={selected.includes(tag.id) ? `tg c-${tag.color} on` : `tg c-${tag.color}`}
            aria-pressed={selected.includes(tag.id)}
            onClick={() => onToggle(tag.id)}
          >
            {tag.name}
            {/* Kullanım sayısı yalnız BAKIM kipinde: süzerken sorulan soru "hangi işler", bakım
                yaparken "hangileri bir kez yazılıp unutulmuş". */}
            {editing && <b>{tag.uses ?? 0}</b>}
          </button>
        ),
      )}
      {isAdmin && (
        <button
          type="button"
          className="lnk"
          aria-pressed={editing}
          onClick={() => setEditing((was) => !was)}
        >
          {editing ? 'Bitti' : 'Etiketleri düzenle'}
        </button>
      )}
    </div>
  );
}

/** Tek bir etiketin bakımı: ad, renk, silme. */
function TagEditor({
  tag,
  onChanged,
  onError,
}: {
  tag: Tag;
  onChanged: () => void;
  onError: (text: string) => void;
}): ReactElement {
  const [name, setName] = useState(tag.name);

  const save = useCallback(
    async (patch: { name?: string; color?: TagColor }): Promise<void> => {
      const { error, response } = await api.PATCH('/tags/{tagId}', {
        params: { path: { tagId: tag.id } },
        body: patch,
      });
      if (!response.ok) {
        onError(problemMessage(error, 'Etiket değiştirilemedi.'));
        // Ad geri alınıyor: reddedilen bir değişikliği kutuda bırakmak, kullanıcıya olmamış bir
        // şeyi olmuş göstermek. Sunucunun sık verdiği ret "bu ad başka bir etikete ait".
        setName(tag.name);
        return;
      }
      onChanged();
    },
    [onChanged, onError, tag.id, tag.name],
  );

  const remove = useCallback(async (): Promise<void> => {
    const uses = tag.uses ?? 0;
    // KAÇ İŞTEN KALKACAĞI ÖNCE SÖYLENİYOR. Sessiz bir kaskat veri kaybının en sık biçimi, ve
    // burada kaybedilen şey otuz işin sınıflandırması.
    const question =
      uses === 0
        ? `"${tag.name}" silinsin mi?`
        : `"${tag.name}" ${uses} işten kalkacak. Silinsin mi?`;
    if (!window.confirm(question)) return;

    const { error, response } = await api.DELETE('/tags/{tagId}', {
      params: { path: { tagId: tag.id } },
    });
    if (!response.ok) {
      onError(problemMessage(error, 'Etiket silinemedi.'));
      return;
    }
    onChanged();
  }, [onChanged, onError, tag.id, tag.name, tag.uses]);

  return (
    <span className={`tg c-${tag.color} edit`}>
      <input
        value={name}
        maxLength={40}
        aria-label={`"${tag.name}" etiketinin adı`}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (name.trim() !== '' && name !== tag.name) void save({ name: name.trim() });
        }}
      />
      <select
        value={tag.color}
        aria-label={`"${tag.name}" etiketinin rengi`}
        onChange={(event) => void save({ color: event.target.value as TagColor })}
      >
        {TAG_COLORS.map((color) => (
          <option key={color} value={color}>
            {color}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="del"
        aria-label={`"${tag.name}" etiketini sil`}
        onClick={() => void remove()}
      >
        ✕
      </button>
    </span>
  );
}
