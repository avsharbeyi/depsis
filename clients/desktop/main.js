'use strict';

/**
 * DEPSIS masaüstü uygulaması.
 *
 * Üç iş: cihazın arayüzünü kendi penceresinde açmak, bu bilgisayarı cihazın ZeroTier ağında
 * tutmak (pencere kapalıyken de — tepside kalıyor ve oturum açılışında başlıyor), ve cihazın
 * kendinden imzalı sertifikasını eşleştirme kodundaki parmak iziyle DOĞRULAMAK. Son madde
 * pazarlık konusu değil: sertifikayı körü körüne kabul eden bir uygulama, aynı ağdaki herkesin
 * kendini cihaz diye tanıtmasına izin verir.
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { parsePairing, certificateFingerprint } = require('./pairing.js');
const zerotier = require('./zerotier.js');

// İkinci kopya hiçbir şey başlatmadan çıkıyor; ilki pencereyi öne getiriyor.
if (!app.requestSingleInstanceLock()) app.exit(0);

const CONFIG = () => path.join(app.getPath('userData'), 'depsis.json');
const TOKEN = () => path.join(app.getPath('userData'), 'zerotier-token');
const ICON = path.join(__dirname, 'assets', 'icon.png');
const STATUS_PAGE = path.join(__dirname, 'ui.html');
const STATUS_URL = pathToFileURL(STATUS_PAGE).href;
/** Oturum açılışı kaydı hem yazılırken hem okunurken AYNI argümanlarla — yoksa okuma hep "kapalı". */
const LOGIN_ARGS = ['--hidden'];

/** { networkId, address, fingerprint } ya da null. */
let pairing = null;
/** Ekrana yazılan durum: { phase, text, nodeId? } */
let state = { phase: 'starting', text: 'Başlatılıyor…' };
let window = null;
let tray = null;
let timer = null;
let preparing = false;

const deviceUrl = () => `https://${pairing.address}/`;
const own = (url) => pairing !== null && url.startsWith(deviceUrl());

function load() {
  try {
    pairing = parsePairing(JSON.parse(fs.readFileSync(CONFIG(), 'utf8')).code ?? '');
  } catch {
    pairing = null;
  }
}

function save(code) {
  fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
  fs.writeFileSync(CONFIG(), JSON.stringify({ code }), 'utf8');
}

/**
 * Parmak izi sabitleme. Cihaz adresine giden her bağlantıda sertifika, eşleştirme kodundaki
 * parmak iziyle karşılaştırılıyor; uymuyorsa bağlantı reddediliyor. Başka adresler için
 * Chromium'un kendi kararı geçerli.
 *
 * Eşleştirme değişince YENİDEN kuruluyor ve açık bağlantılar kapatılıyor: Chromium doğrulama
 * sonuçlarını önbelleğe alıyor, ve eski kodla kabul edilmiş bir bağlantı yeni kodla
 * sorgulanmadan kullanılmaya devam ederdi.
 */
function pin() {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (pairing === null || request.hostname !== pairing.address) return callback(-3);
    callback(certificateFingerprint(request.certificate.data) === pairing.fingerprint ? 0 : -2);
  });
  void session.defaultSession.closeAllConnections();
}

function onStatusPage() {
  return window !== null && !window.isDestroyed() && window.webContents.getURL() === STATUS_URL;
}

/**
 * PENCERE CİHAZIN SAYFASINDAN DURUM YÜZÜNDEN ATILMIYOR. Yavaş ya da aktarmalı bir ZeroTier
 * bağlantısında tek bir yoklama zamanında cevap alamayabiliyor; eskiden bu, pencereyi durum
 * sayfasına götürüp süren bir yüklemeyi yarıda kesiyordu. Cihaz gerçekten giderse sayfanın kendi
 * yüklemesi düşüyor ve `did-fail-load` durum sayfasını açıyor.
 */
function setState(next) {
  const changed = next.phase !== state.phase || next.text !== state.text;
  state = next;
  if (!changed) return;
  tray?.setToolTip(`DEPSIS — ${next.text}`);
  if (onStatusPage()) {
    if (next.phase === 'ready') void window.loadURL(deviceUrl());
    else window.webContents.send('state', state);
  }
  refreshTrayMenu();
}

/**
 * Cihaz cevap veriyor mu — ve cevap veren GERÇEKTEN o cihaz mı.
 * 'ok' | 'mismatch' (cevap var, sertifika başka) | 'down'.
 */
function probe() {
  return new Promise((resolve) => {
    const request = https.get(
      { host: pairing.address, path: '/api/v1/health', timeout: 8000, rejectUnauthorized: false },
      (response) => {
        const raw = response.socket.getPeerCertificate()?.raw;
        response.resume();
        const same = raw !== undefined && certificateFingerprint(raw) === pairing.fingerprint;
        resolve(same ? 'ok' : 'mismatch');
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve('down'));
  });
}

/** Döngünün bir turu: eksik olan ilk adımı söylüyor ya da tamamlıyor. */
async function tick() {
  if (pairing === null) {
    setState({ phase: 'pair', text: 'Eşleştirme kodu bekleniyor' });
    return;
  }
  if (preparing) return;
  const token = zerotier.installed() ? zerotier.readToken(TOKEN()) : null;
  if (token === null) {
    setState({
      phase: 'prepare',
      text: zerotier.installed()
        ? 'ZeroTier servisine erişim izni gerekiyor'
        : 'ZeroTier bu bilgisayarda kurulu değil',
    });
    return;
  }
  try {
    const node = await zerotier.nodeId(token);
    const network = await zerotier.ensureJoined(token, pairing.networkId);
    if (network.status === 'ACCESS_DENIED' || network.status === 'REQUESTING_CONFIGURATION') {
      setState({
        phase: 'authorize',
        text: 'Cihazda bu bilgisayarın onaylanması bekleniyor',
        nodeId: node,
      });
      return;
    }
    if (network.status !== 'OK') {
      setState({ phase: 'error', text: `ZeroTier ağı: ${network.status}`, nodeId: node });
      return;
    }
    const answer = await probe();
    if (answer === 'mismatch') {
      // Cevap veren cihazın sertifikası koddakinden farklı: cihaz yeniden kurulmuş ya da adreste
      // başka biri var. İki durumda da yapılacak şey yeni kodla eşleştirmek.
      setState({
        phase: 'mismatch',
        text: 'Cihazın sertifikası eşleştirme koduyla uyuşmuyor',
        nodeId: node,
      });
      return;
    }
    if (answer === 'down') {
      // Hazırken tek bir kaçırılan yoklama "bağlanıyor"a düşürmüyor; cihaz sayfası açık kalıyor.
      if (state.phase !== 'ready') {
        setState({ phase: 'connecting', text: 'Cihaza ulaşılıyor…', nodeId: node });
      }
      return;
    }
    setState({ phase: 'ready', text: 'Bağlı', nodeId: node });
  } catch (error) {
    if (error instanceof zerotier.TokenRejected) {
      fs.rmSync(TOKEN(), { force: true });
      setState({ phase: 'prepare', text: 'ZeroTier servisine erişim izni yenilenmeli' });
      return;
    }
    setState({ phase: 'error', text: `ZeroTier servisine ulaşılamadı: ${error.message}` });
  }
}

function loop() {
  clearTimeout(timer);
  void tick().finally(() => {
    timer = setTimeout(loop, state.phase === 'ready' ? 30_000 : 4_000);
  });
}

function openWindow() {
  if (window !== null && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'DEPSIS',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#02040A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // KAPATMAK GİZLEMEK: ağ bağlantısı pencereye bağlı değil, ve uygulama tepside kalıyor.
  window.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on('did-fail-load', (_event, code, _text, url, isMainFrame) => {
    // -3 ABORTED olağan: bir indirme ya da yarıda kesilen gezinme. Cihaz sayfası gerçekten
    // açılamadıysa durum sayfasına dönülüyor ve döngü yeniden bağlanınca cihazı geri açıyor.
    if (!isMainFrame || code === -3 || !own(url)) return;
    state = { phase: 'connecting', text: 'Cihaza ulaşılıyor…', nodeId: state.nodeId };
    void window.loadFile(STATUS_PAGE);
  });
  if (state.phase === 'ready') void window.loadURL(deviceUrl());
  else void window.loadFile(STATUS_PAGE);
}

/**
 * HER pencereye aynı kilit — yalnız ilkine değil. Cihazın sayfası yeni bir pencere açarsa o da
 * cihazın dışına gidemiyor, ve dosya sürüklemek pencereyi yerel bir HTML'e götüremiyor.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (own(url) || url === STATUS_URL) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (own(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          icon: ICON,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true },
        },
      };
    }
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

function refreshTrayMenu() {
  if (tray === null) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'DEPSIS’i aç', click: openWindow },
      { label: state.text, enabled: false },
      { type: 'separator' },
      {
        label: 'Oturum açılışında başlat',
        type: 'checkbox',
        checked: app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS }),
      },
      { label: 'Eşleştirmeyi kaldır…', enabled: pairing !== null, click: () => void unpair() },
      { type: 'separator' },
      {
        label: 'Çıkış',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function unpair() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Kaldır', 'Vazgeç'],
    defaultId: 1,
    cancelId: 1,
    title: 'Eşleştirmeyi kaldır',
    message: 'Bu bilgisayar cihazın ağından çıkacak.',
    detail: 'Yeniden bağlanmak için cihazın Uzak erişim ekranındaki kod yeterli.',
  });
  if (response !== 0) return;
  const token = zerotier.readToken(TOKEN());
  if (token !== null && pairing !== null) {
    await zerotier.leave(token, pairing.networkId).catch(() => {});
  }
  fs.rmSync(CONFIG(), { force: true });
  pairing = null;
  // Aynı adreste sonradan başka bir cihaz olursa eskisinin çerezini ve önbelleğini almasın.
  await session.defaultSession.clearStorageData().catch(() => {});
  pin();
  openWindow();
  if (!onStatusPage()) void window.loadFile(STATUS_PAGE);
  loop();
}

// ── durum sayfasının istekleri ────────────────────────────────────────────────────────────────
// Yalnız uygulamanın kendi durum sayfası sorabiliyor; cihazın sayfası ya da başka bir yerel dosya
// eşleştirmeyi değiştiremiyor.
const fromStatusPage = (event) => event.senderFrame?.url === STATUS_URL;

ipcMain.handle('state', (event) => (fromStatusPage(event) ? state : null));

ipcMain.handle('pair', async (event, code) => {
  if (!fromStatusPage(event)) return 'İzin yok.';
  const parsed = parsePairing(code);
  if (parsed === null) {
    return 'Kod okunamadı. DEPSIS’in Uzak erişim ekranındaki satırı aynen yapıştırın.';
  }
  save(String(code).trim());
  pairing = parsed;
  pin();
  setState({ phase: 'starting', text: 'Bağlanılıyor…' });
  loop();
  return null;
});

ipcMain.handle('prepare', async (event) => {
  if (!fromStatusPage(event) || preparing) return null;
  preparing = true;
  setState({ phase: 'installing', text: 'ZeroTier hazırlanıyor — yönetici onayı istenecek…' });
  try {
    await zerotier.prepare(TOKEN());
    return null;
  } catch (error) {
    return error.message;
  } finally {
    preparing = false;
    loop();
  }
});

// ── yaşam döngüsü ────────────────────────────────────────────────────────────────────────────

app.on('second-instance', openWindow);
app.on('window-all-closed', () => {
  // Bilerek boş: tepside kalıyoruz.
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  load();
  pin();
  // Cihazın sayfası pano yazma, kamera (QR okuma), tam ekran isteyebiliyor; cihazın DIŞINDAN gelen
  // hiçbir izin isteği kabul edilmiyor.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback, details) =>
    callback(own(details.requestingUrl ?? '')),
  );

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', openWindow);
  refreshTrayMenu();

  if (!process.argv.includes('--hidden')) openWindow();
  loop();
});
