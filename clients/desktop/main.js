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
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const { parsePairing, certificateFingerprint } = require('./pairing.js');
const zerotier = require('./zerotier.js');

if (!app.requestSingleInstanceLock()) app.quit();

const CONFIG = () => path.join(app.getPath('userData'), 'depsis.json');
const TOKEN = () => path.join(app.getPath('userData'), 'zerotier-token');
const ICON = path.join(__dirname, 'assets', 'icon.png');

/** { networkId, address, fingerprint } ya da null. */
let pairing = null;
/** Ekrana yazılan durum: { phase, text, nodeId? } */
let state = { phase: 'starting', text: 'Başlatılıyor…' };
let window = null;
let tray = null;
let timer = null;
let preparing = false;

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

function setState(next) {
  const changed = next.phase !== state.phase || next.text !== state.text;
  state = next;
  if (!changed) return;
  tray?.setToolTip(`DEPSIS — ${next.text}`);
  // Hazır olunca pencere cihazın kendisine geçiyor; hazır değilken durum sayfası gösteriliyor.
  if (window !== null && !window.isDestroyed()) {
    if (next.phase === 'ready') void window.loadURL(`https://${pairing.address}/`);
    else if (!window.webContents.getURL().startsWith('file:')) void showStatusPage();
    else window.webContents.send('state', state);
  }
  refreshTrayMenu();
}

function showStatusPage() {
  return window.loadFile(path.join(__dirname, 'ui.html'));
}

/** Cihaz cevap veriyor mu — ve cevap veren GERÇEKTEN o cihaz mı. */
function reachable() {
  return new Promise((resolve) => {
    const request = https.get(
      { host: pairing.address, path: '/api/v1/health', timeout: 4000, rejectUnauthorized: false },
      (response) => {
        const raw = response.socket.getPeerCertificate()?.raw;
        response.resume();
        resolve(raw !== undefined && certificateFingerprint(raw) === pairing.fingerprint);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
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
    if (!(await reachable())) {
      setState({ phase: 'connecting', text: 'Cihaza ulaşılıyor…', nodeId: node });
      return;
    }
    setState({ phase: 'ready', text: 'Bağlı', nodeId: node });
  } catch (error) {
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
  // Cihazın dışına gezinme yok; dış bağlantılar sistemin tarayıcısında.
  const own = (url) => pairing !== null && url.startsWith(`https://${pairing.address}/`);
  window.webContents.on('will-navigate', (event, url) => {
    if (!own(url) && !url.startsWith('file:')) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (own(url)) return { action: 'allow' };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('did-fail-load', (_event, _code, _text, url) => {
    if (own(url)) void showStatusPage();
  });
  if (state.phase === 'ready') void window.loadURL(`https://${pairing.address}/`);
  else void showStatusPage();
}

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
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) =>
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { label: 'Eşleştirmeyi kaldır', enabled: pairing !== null, click: unpair },
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
  const token = zerotier.readToken(TOKEN());
  if (token !== null && pairing !== null)
    await zerotier.leave(token, pairing.networkId).catch(() => {});
  fs.rmSync(CONFIG(), { force: true });
  pairing = null;
  openWindow();
  loop();
}

// ── durum sayfasının istekleri ────────────────────────────────────────────────────────────────

ipcMain.handle('state', () => state);

ipcMain.handle('pair', async (_event, code) => {
  const parsed = parsePairing(code);
  if (parsed === null)
    return 'Kod okunamadı. DEPSIS’in Uzak erişim ekranındaki satırı aynen yapıştırın.';
  save(code.trim());
  pairing = parsed;
  loop();
  return null;
});

ipcMain.handle('prepare', async () => {
  if (preparing) return null;
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

  // PARMAK İZİ SABİTLEME. Cihaz adresine giden her bağlantıda sertifika, eşleştirme kodundaki
  // parmak iziyle karşılaştırılıyor; uymuyorsa bağlantı reddediliyor. Başka adresler için
  // Chromium'un kendi kararı geçerli.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (pairing === null || request.hostname !== pairing.address) return callback(-3);
    callback(certificateFingerprint(request.certificate.data) === pairing.fingerprint ? 0 : -2);
  });

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', openWindow);
  refreshTrayMenu();

  if (!process.argv.includes('--hidden')) openWindow();
  loop();
});
