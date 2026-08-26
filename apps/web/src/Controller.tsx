import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { api, problemMessage } from './api.js';

type Status = OpenApi.components['schemas']['ControllerStatus'];
type Network = OpenApi.components['schemas']['ControlledNetwork'];
type Member = OpenApi.components['schemas']['ControllerMember'];
type Notify = (kind: 'ok' | 'error', text: string) => void;

/**
 * Varsayılan alt ağ: `10.147.<rastgele>.0/24`.
 *
 * `192.168.x` DEĞİL, ve bu tercih bir arıza sınıfını kapatıyor. `192.168.1.0/24` dünyanın en yaygın
 * ev ağı; onu seçen bir kullanıcı, EVDE OTURURKEN kendi yönlendiricisiyle kavga eden bir rota
 * almış oluyor — ve NAS'ı hem uzaktan hem yerelden erişilemez hâle geliyor, üstelik düzeltmeye en
 * uygun makineden. `10.147` ZeroTier'in kendi geleneği ve bir ev ağında neredeyse hiç görülmüyor.
 */
function suggestSubnet(): string {
  return `10.147.${String(Math.floor(Math.random() * 254) + 1)}.0/24`;
}

/**
 * Evin kendi ZeroTier ağı — self-hosted controller.
 *
 * `zerotier-one`'ın kendisi controller; ayrı bir servis yok. Bu panel onun üç sorusunu cevaplıyor:
 * ağ var mı, kimler içeride, ve kimi içeri alıyoruz.
 *
 * ÜÇ ŞEY BİLEREK BÖYLE:
 *
 * 1. **Cihazın kendi satırında "çıkar" düğmesi yok.** Kendi yetkisini kaldıran bir NAS, kendi
 *    sunduğu ağdan düşüyor; controller herkese hizmet vermeye devam ettiği için dışarıdan hiçbir
 *    şey bozuk görünmüyor, ve geri almanın yolu tam da kopan bağlantının arkasında kalıyor. Ajan
 *    da reddediyor — bu, düğmenin hiç görünmemesi.
 *
 * 2. **"Hiç görülmedi" ayrı gösteriliyor.** Bir adresi yetkilendirmek, o cihaz ortaya çıkana kadar
 *    doğru yazılmış bir haneyle yanlış yazılmış bir haneyi ayırt edilemez kılıyor. Controller ilk
 *    temasta kimliği sabitliyor; o ana kadar satır bir SÖZ, bir olgu değil.
 *
 * 3. **Eksik kurulmuş bir ağ söyleniyor.** Controller anlamadığı yapılandırmayı sessizce atıp 200
 *    dönüyor. Sunucu uygulanan kaydı geri okuyor ve uygulanmayanı cümlesiyle veriyor; burada
 *    gösterilmeseydi, ekran yeşil ve ağ ölü olurdu.
 */
export function Controller({
  notify,
  onChanged,
}: {
  notify: Notify;
  onChanged: () => void;
}): ReactElement {
  const [status, setStatus] = useState<Status | null>(null);
  const [hidden, setHidden] = useState(false);
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('Ev');
  const [subnet, setSubnet] = useState(suggestSubnet);

  const [adding, setAdding] = useState(false);
  const [newMember, setNewMember] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const found = await api.GET('/remote/controller', {});
    if (found.data === undefined) {
      // 403 bir durum, hata değil: sıradan bir üye bu paneli görmüyor.
      if (found.response.status === 403) setHidden(true);
      return;
    }
    setStatus(found.data);

    const list = await api.GET('/remote/controller/networks', {});
    if (list.data === undefined) {
      notify('error', problemMessage(list.error, 'Yönetilen ağlar okunamadı.'));
      return;
    }
    setNetworks(list.data.items);
    setChosen((current) => current ?? list.data.items[0]?.networkId ?? null);
  }, [notify]);

  const loadMembers = useCallback(
    async (networkId: string): Promise<void> => {
      const { data, error } = await api.GET('/remote/controller/networks/{networkId}/members', {
        params: { path: { networkId } },
      });
      if (data === undefined) {
        notify('error', problemMessage(error, 'Üyeler okunamadı.'));
        setMembers([]);
        return;
      }
      setMembers(data.items);
    },
    [notify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (chosen === null) return;
    void loadMembers(chosen);
  }, [chosen, loadMembers]);

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const { data, error } = await api.POST('/remote/controller/networks', {
      body: { name: name.trim(), subnet: subnet.trim() },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Ağ kurulamadı.'));
      return;
    }
    // EKSİK KURULMUŞ BİR AĞ SESSİZ GEÇMİYOR. Controller anlamadığını atıp 200 dönüyor; sunucu
    // uygulanan kaydı geri okudu ve eksik olanı söyledi.
    if (data.shortfall.length > 0) {
      notify(
        'error',
        `Ağ kuruldu ama eksik: ${data.shortfall.join('; ')}. Bu hâlde cihazlar adres alamayabilir.`,
      );
    } else {
      notify('ok', `${data.network.name} kuruldu. Ağ kimliği: ${data.network.networkId}`);
    }
    setCreating(false);
    setChosen(data.network.networkId);
    await load();
    onChanged();
  }

  async function setAuthorized(
    memberId: string,
    authorized: boolean,
    label?: string,
  ): Promise<void> {
    if (chosen === null) return;
    setBusy(true);
    const { data, error } = await api.POST('/remote/controller/networks/{networkId}/members', {
      params: { path: { networkId: chosen } },
      body: {
        memberId,
        authorized,
        ...(label === undefined || label === '' ? {} : { label }),
      },
    });
    setBusy(false);
    if (data === undefined) {
      notify('error', problemMessage(error, 'Üye güncellenemedi.'));
      return;
    }
    notify(
      'ok',
      authorized
        ? // "Anında" DEMİYOR: controller yalnız daha önce hizmet ettiği üyelere yapılandırma
          // itebiliyor, hiç görülmemiş bir cihaz kendi döngüsüyle birkaç saniye içinde öğreniyor.
          `${data.memberId} yetkilendirildi. Cihazın bunu görmesi birkaç saniye sürebilir.`
        : `${data.memberId} artık ağda değil.`,
    );
    setAdding(false);
    setNewMember('');
    setNewLabel('');
    await loadMembers(chosen);
  }

  if (hidden) return <></>;

  const network = networks?.find((item) => item.networkId === chosen) ?? null;

  return (
    <div className="repl">
      <div className="thead">
        <span className="lbl">Evin kendi ağı</span>
        {status !== null && status.available && networks !== null && (
          <button type="button" className="lnk" onClick={() => setCreating(!creating)}>
            {creating ? 'Vazgeç' : 'Yeni ağ kur'}
          </button>
        )}
      </div>

      {status !== null && !status.available && (
        <p className="note">
          Bu kutu kendi ağını yönetemiyor: ZeroTier yanıt vermiyor. Servis çalışıyorsa yeniden
          deneyin.
        </p>
      )}

      {networks !== null && networks.length === 0 && !creating && (
        <p className="note">
          Henüz kendi ağınız yok. Kurduğunuzda cihazlarınız my.zerotier.com&apos;a bağlı olmadan,
          doğrudan bu cihazın yönettiği bir ağ üzerinden bağlanır.
        </p>
      )}

      {creating && (
        <form onSubmit={(event) => void create(event)}>
          <label className="fld">
            <span className="lbl">Ağın adı</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={64}
              required
            />
          </label>
          <label className="fld">
            <span className="lbl">Adres bloğu</span>
            <input value={subnet} onChange={(event) => setSubnet(event.target.value)} required />
            {/* Bu cümle formun en önemli parçası: en sık yapılan hata, ev ağıyla çakışan bir
                blok seçmek — ve sonucu, düzeltmeye en uygun makineden erişilemez bir NAS. */}
            <span className="note">
              EV AĞINIZLA AYNI OLMASIN. `192.168.1.0/24` gibi yaygın bir blok seçerseniz, evde
              otururken kendi yönlendiricinizle çakışır ve cihaza ulaşamazsınız.
            </span>
          </label>
          <div className="row">
            <button type="submit" className="b" disabled={busy}>
              Kur
            </button>
          </div>
        </form>
      )}

      {networks !== null && networks.length > 1 && (
        <div className="netrow">
          <span className="lbl">Ağ</span>
          <select
            className="b"
            aria-label="Hangi ağ"
            value={chosen ?? ''}
            onChange={(event) => setChosen(event.target.value)}
          >
            {networks.map((item) => (
              <option key={item.networkId} value={item.networkId}>
                {item.name} · {item.networkId}
              </option>
            ))}
          </select>
        </div>
      )}

      {network !== null && (
        <>
          <p className="note m">
            {network.networkId}
            {network.subnet === null ? '' : ` · ${network.subnet}`}
          </p>

          {!network.assignsAddresses && (
            <div className="warn">
              <span className="ic" aria-hidden>
                ⚠
              </span>
              <span className="tx">
                <b>Bu ağ adres dağıtmıyor.</b>
                Cihazlar katılabilir ama IP alamaz, yani birbirlerine ulaşamazlar. Ağı yeniden
                kurmanız gerekebilir.
              </span>
            </div>
          )}

          <div className="thead">
            <span className="lbl">Cihazlar</span>
            <button type="button" className="lnk" onClick={() => setAdding(!adding)}>
              {adding ? 'Vazgeç' : 'Cihaz ekle'}
            </button>
          </div>

          {adding && (
            <div>
              {/* Kayıt akışının İKİ yarısı var ve ikisi de burada: cihaz ağa KATILIR (aşağıdaki
                  kimlikle — kimlik bir sır değil, ağ özel olduğu için katılmak yetki vermez ve
                  controller kimliği ilk temasta sabitler), sonra yönetici onu İÇERİ ALIR. Katılan
                  cihaz kendini bekleyenler listesine kendisi yazar; adres elle de eklenebilir. */}
              <p className="note">
                <b>1.</b> Ekleyeceğiniz cihazda ZeroTier kurup bu ağa katılın — mobilde{' '}
                <i>Add Network</i>, masaüstünde:
              </p>
              <p className="note m">zerotier-cli join {network.networkId}</p>
              <p className="note">
                Katılan cihaz aşağıdaki listeye <i>onay bekliyor</i> olarak kendiliğinden düşer;
                &quot;içeri al&quot; demeniz yeter. <b>2.</b> İsterseniz beklemeden, cihazın{' '}
                <b>kendi adresini</b> yazarak da ekleyebilirsiniz — mobilde ana ekranda, masaüstünde{' '}
                <code>zerotier-cli info</code> çıktısının ikinci alanı. On onaltılık hane.
              </p>
              <label className="fld">
                <span className="lbl">Cihazın adresi</span>
                <input
                  value={newMember}
                  onChange={(event) => setNewMember(event.target.value.trim().toLowerCase())}
                  placeholder="1122334455"
                  maxLength={10}
                />
              </label>
              <label className="fld">
                <span className="lbl">Kimin cihazı</span>
                <input
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="Ayşe'nin dizüstü"
                  maxLength={64}
                />
              </label>
              <div className="row">
                <button
                  type="button"
                  className="b"
                  disabled={busy || !/^[0-9a-f]{10}$/u.test(newMember)}
                  onClick={() => void setAuthorized(newMember, true, newLabel)}
                >
                  Yetkilendir
                </button>
              </div>
            </div>
          )}

          {members !== null && members.length === 0 && (
            <p className="note">Bu ağda henüz cihaz yok.</p>
          )}

          {members !== null && members.length > 0 && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Cihaz</th>
                  <th>Durum</th>
                  <th>Adres</th>
                  <th>Kim aldı</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.memberId}>
                    <td>
                      <b>{member.label === null || member.label === '' ? '—' : member.label}</b>
                      <div className="m">{member.memberId}</div>
                    </td>
                    <td>
                      <span className={member.authorized ? 'pill ok' : 'pill warn'}>
                        {member.authorized ? 'yetkili' : 'bekliyor'}
                      </span>
                      {/* YANLIŞ YAZILMIŞ BİR HANENİN TEK GÖRÜNÜR İZİ. Cihaz ortaya çıkana kadar
                          doğru adresle yanlış adres birbirinden ayırt edilemiyor; controller ilk
                          temasta kimliği sabitliyor ve satır ancak o zaman söylediği şey oluyor. */}
                      {member.authorized && !member.seen && <div className="m">hiç bağlanmadı</div>}
                      {member.isThisAppliance && <div className="m">bu cihaz</div>}
                    </td>
                    <td className="m">
                      {member.addresses.length === 0 ? '—' : member.addresses.join(', ')}
                    </td>
                    <td className="m">{member.authorizedBy ?? 'DEPSIS dışında'}</td>
                    <td>
                      {/* Cihazın kendi satırında YOK. Ajan da reddediyor; bu, düğmenin hiç
                          görünmemesi. */}
                      {!member.isThisAppliance &&
                        (member.authorized ? (
                          <button
                            type="button"
                            className="lnk"
                            disabled={busy}
                            onClick={() => void setAuthorized(member.memberId, false)}
                          >
                            Çıkar
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="lnk"
                            disabled={busy}
                            onClick={() => void setAuthorized(member.memberId, true)}
                          >
                            Yetkilendir
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
