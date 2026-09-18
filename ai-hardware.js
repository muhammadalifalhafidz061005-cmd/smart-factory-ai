/* ============================================================
   Smart Factory AI — ai-hardware.js (Admin)
   START-gated: kamera + model hanya jalan setelah START VISION.
   Web Bluetooth NUS (Nordic UART Service) untuk Micro:bit v2.
   ============================================================ */

/* ---------- Mapping kelas Teachable Machine → Internal ----------
   Nama HARUS persis sama dengan label di Teachable Machine:
   "biru", "kuning", "merah" (lowercase)                    */
const TM_CLASS_MAP = {
  biru:   { key: 'biru',   label: 'Biru',   color: '#0466c8' },
  kuning: { key: 'kuning', label: 'Kuning', color: '#ffee32' },
  merah:  { key: 'merah',  label: 'Merah',  color: '#ef4444' }
};
const EXPECTED_LABELS = Object.keys(TM_CLASS_MAP);

/* ---------- Mapping BIN dari micro:bit (ultrasonic per kotak) ----------
   micro:bit mengirim string WARNA MATA  saja saat barang masuk kotak:
   "kuning" = kotak kuning | "biru"   = kotak biru (pass)
   "merah"    = kotak merah (error/reject)                              */
const MICROBIT_BIN_MAP = {
  'kuning': { key: 'kuning', label: 'bin-kuning' },
  'biru':   { key: 'biru',   label: 'bin-biru (Pass)' },
  'merah':  { key: 'merah',  label: 'bin-merah' }
};
/* Kamera biru → harus biru, dst. Cocok = MATCH, beda = ERROR */
const EXPECTED_BIN = {
  biru:   'biru',
  kuning: 'kuning',
  merah:  'merah'
};

function normalizeMicrobitBin(raw) {
  const s = String(raw || '').trim().toLowerCase();
  // match warna murni: "kuning", "biru", "merah"
  if (MICROBIT_BIN_MAP[s]) return s;
  // alias: "kuning" saja → "kuning", dst.
  if (s === 'kuning') return 'kuning';
  if (s === 'biru') return 'biru';
  if (s === 'merah') return 'merah';
  return null;
}

/* ---------- Web Bluetooth NUS Constants ---------- */
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UUID_TX_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Micro:bit → Web (Notify)
const UUID_RX_WRITE  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Web → Micro:bit (Write)
const TIMEOUT_MS = 3000; // 3 detik timeout menunggu balasan micro:bit

const CONFIDENCE_THRESHOLD = 0.75;
const COOLDOWN_MS = 3000; // jeda antar trigger (ala guru)
const BIN_TIMEOUT_MS = 3000; // 3 detik tak ada data micro:bit → ERROR (Miss-sort)
const STORAGE_KEY = 'sfai_tm_model_url';

// Bluetooth state
let bleDevice = null;
let rxCharWrite = null;   // Web → Micro:bit (Write)
let txCharNotify = null;  // Micro:bit → Web (Notify)
let isConnected = false;
let isConnecting = false;
let rxBuffer = '';

const MODES = {
  servo: {
    id: 'servo',
    name: 'Fast Sorting (Servo)',
    desc: 'High Throughput',
    flow: {
      kuning: { step: 'SERVO → bin-kuning', type: 'servo' },
      merah:  { step: 'SERVO → bin-merah', type: 'servo' },
      biru:   { step: 'SERVO → bin-biru (Pass)', type: 'servo' }
    }
  },
  recovery: {
    id: 'recovery',
    name: 'Robotic Recovery (Precision)',
    desc: 'Precision Handling',
    flow: {
      kuning: { step: 'IR → STOP → ARM → bin-kuning', type: 'arm' },
      merah:  { step: 'IR → STOP → ARM → bin-merah', type: 'arm' },
      biru:   { step: 'IR → STOP → ARM → bin-biru (Pass)', type: 'arm' }
    }
  }
};

/* ---------- State ---------- */
let tmModel = null;
let tmLabels = [];
let videoEl = null;
let predictCanvas = null;
let visionRunning = false;
let detectLoopId = null;
let currentMode = 'servo';
let isCoolingDown = false;
let pendingTxKey = null;
let pendingDest = null;
let pendingPayload = null;
let binTimeoutId = null;
let pendingColor = null;      // warna yang dikirim kamera (menunggu echo)
let lastSentCommand = null;   // perintah terakhir dikirim ke micro:bit
let matchTimeout = null;      // 3 detik timeout menunggu echo micro:bit

/* ---------- Safe DOM Element Getter ---------- */
function $(id) {
  return document.getElementById(id);
}
function qsa(sel, root) {
  try { return Array.from((root || document).querySelectorAll(sel)); }
  catch (e) { return []; }
}

/* ---------- Missing globals (LED / webcam / chart stubs) ---------- */
let webcam = null;
let ledInterval = null;
let connectLEDInterval = null;
let patternIdx = 0;
const patterns = [
  [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1],
  [0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0]
];

/* ---------- Cached elements (single declaration, lazy-safe) ---------- */
const cameraContainer = $('camera-container');
const tmUrlInput = $('tmUrl');
const btnStartVision = $('btnStartVision');
const aiProbs = $('aiProbs');

/* --- Safe Helpers --- */
function setLed(id, state) {
  window.dispatchEvent(new CustomEvent('sfai:led-status', { detail: { key: id, state } }));
}

function setVfLabel(text, type) {
  const el = $('vfLabel');
  if (!el) return;
  el.textContent = text;
  el.style.borderColor =
    type === 'live' ? 'rgba(52, 211, 153, 0.6)'
    : type === 'danger' ? 'rgba(248, 113, 113, 0.7)'
    : type === 'loading' ? 'rgba(250, 204, 21, 0.6)'
    : 'rgba(147, 197, 253, 0.3)';
}

function setAiTag(text, live) {
  const el = $('aiStatusTag');
  if (!el) return;
  el.innerHTML = '<span class="tag-pulse"></span>' + text;
  el.classList.toggle('live', !!live);
}

function toast(msg, type) {
  window.dispatchEvent(new CustomEvent('sfai:toast', { detail: { msg, type: type || 'info' } }));
}

/* ---------- Log helper (console + toast untuk error) ---------- */
function sysLog(msg, type) {
  try { console.log('[SFAI][' + (type || 'sys') + ']', msg); } catch (e) {}
  if (type === 'err' || type === 'timeout' || type === 'mismatch') {
    try { toast(String(msg).slice(0, 120), 'error'); } catch (e) {}
  }
}

/* ---------- Camera status (indicator + border) ---------- */
function updateCameraStatus() {
  const indicCam = $('indicCam');
  const indicCamText = $('indicCamText');
  if (pendingColor) {
    if (indicCam) indicCam.className = 'indic ok';
    if (indicCamText) indicCamText.textContent = 'Detect: ' + String(pendingColor).toUpperCase();
  } else {
    if (indicCam) indicCam.className = 'indic';
    if (indicCamText) indicCamText.textContent = visionRunning ? 'Active' : 'Idle';
  }
}

/* ---------- Chart stub (chart asli di app.js) ---------- */
function initChart() { return; }

/* ---------- QC resolve: Pending → Success / Miss-sort ---------- */
function resolveQc(payload, binValue, reason) {
  if (!payload) return;
  const norm = binValue ? normalizeMicrobitBin(binValue) : null;
  const expected = payload.destination || payload.expectedBin || null;
  let result = 'Miss-sort';
  let sensorBin = norm ? ('bin-' + norm) : (reason === 'timeout' || reason === 'timeout-override' ? 'timeout' : null);
  let sensorLabel = norm ? ('bin-' + norm) : (reason && reason.indexOf('timeout') === 0 ? 'Timeout' : 'Miss');
  if (norm && expected && norm === expected) {
    result = 'Success';
  }
  const done = Object.assign({}, payload, {
    sensorBin: sensorBin,
    sensorLabel: sensorLabel,
    result: result
  });
  try {
    window.dispatchEvent(new CustomEvent('sfai:item-detected', { detail: done }));
  } catch (e) {}
  if (result === 'Success') {
    try { showMatchSuccess(payload.color || expected || 'biru', norm || expected || 'biru'); } catch (e) {}
  } else {
    if (!norm) {
      try { showMatchError('timeout', payload.color || 'biru', null); } catch (e) {}
    } else {
      try { showMatchError('mismatch', payload.color || 'biru', norm); } catch (e) {}
    }
  }
  pendingColor = null;
  try { updateCameraStatus(); } catch (e) {}
}

function resolveBinTimeout() {
  if (!pendingPayload) return;
  const old = pendingPayload;
  pendingPayload = null;
  pendingTxKey = null;
  clearTimeout(binTimeoutId);
  binTimeoutId = null;
  resolveQc(old, null, 'timeout');
}

/* ---------- Bootstrap ---------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  // Restore URL tersimpan → aktifkan tombol START
  const savedUrl = localStorage.getItem(STORAGE_KEY);
  if (savedUrl && tmUrlInput) {
    tmUrlInput.value = savedUrl;
    markUrlReady();
  }

  if (tmUrlInput) {
    tmUrlInput.addEventListener('input', () => {
      if (btnStartVision && visionRunning) return;
      markUrlReady();
    });
    // Auto-save saat selesai mengetik (pengganti tombol Simpan di mode HP)
    tmUrlInput.addEventListener('change', () => {
      const url = (tmUrlInput.value || '').trim();
      if (!url || (btnStartVision && visionRunning)) return;
      try {
        new URL(url);
      } catch {
        return;
      }
      localStorage.setItem(STORAGE_KEY, url);
      markUrlReady();
    });
  }

  // Tombol Simpan URL — validasi + simpan lokal
  const tmSaveBtn = document.getElementById('tmSaveBtn');
  if (tmSaveBtn) {
    tmSaveBtn.addEventListener('click', () => {
      const url = (tmUrlInput.value || '').trim();
      if (!url) {
        toast('Isi URL model dulu', 'error');
        return;
      }
      try {
        new URL(url);
      } catch {
        toast('URL tidak valid (contoh: https://teachablemachine.withgoogle.com/models/xxxxxx/)', 'error');
        return;
      }
      localStorage.setItem(STORAGE_KEY, url);
      markUrlReady();
      toast('URL model tersimpan — klik START VISION', 'success');
    });
  }

  // START/PAUSE VISION — toggle kamera + AI
  if (btnStartVision) {
    btnStartVision.addEventListener('click', toggleVision);
  }

  // Kartu mode bisa diklik (klik / Enter / Spasi)
  document.querySelectorAll('.mode-detail-card[data-mode]').forEach((card) => {
    card.addEventListener('click', () => switchMode(card.dataset.mode || 'servo'));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchMode(card.dataset.mode || 'servo');
      }
    });
  });

  // Tombol Bluetooth — klik untuk connect / disconnect (UUID NUS)
  const btBtn = $('connectBtn2') || $('connectBtn');
  if (btBtn) {
    btBtn.type = 'button';
    btBtn.disabled = false;
    btBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      connectBluetooth();
    });
  }

  buildProbBars([]);
  setVfLabel('Klik START VISION untuk mengaktifkan kamera', 'idle');
  try { updateUI(false); } catch (e) {}
  try { updateCameraStatus(); } catch (e) {}
  try { showIdleMatch(); } catch (e) {}
}

function markUrlReady() {
  const has = tmUrlInput && tmUrlInput.value.trim().length > 0;
  if (!btnStartVision || visionRunning) return;
  btnStartVision.classList.toggle('ready', !!has);
  btnStartVision.disabled = !has;
}

/* ---------- TOGGLE VISION (START/PAUSE) ---------- */
function toggleVision() {
  if (visionRunning) {
    stopVision();
  } else {
    startVision();
  }
}

function stopVision() {
  visionRunning = false;
  
  // Stop detection loop
  if (detectLoopId) {
    cancelAnimationFrame(detectLoopId);
    detectLoopId = null;
  }
  
  // Stop camera stream (if using direct video)
  if (videoEl && videoEl.srcObject) {
    const tracks = videoEl.srcObject.getTracks();
    tracks.forEach(track => track.stop());
    videoEl.srcObject = null;
  }
  
  // Remove video element if exists
  if (videoEl && videoEl.parentNode) {
    videoEl.parentNode.removeChild(videoEl);
    videoEl = null;
  }
  
  // Reset UI
  const btn = $('btnStartVision');
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('running');
    btn.classList.add('ready');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>START VISION</span>';
  }
  
  setLed('led-ai', 'off');
  setLed('led-sensor', 'off');
  setAiTag('Dijeda', false);
  setVfLabel('Vision dijeda — klik START untuk melanjutkan', 'idle');
  toast('Vision dijeda', 'info');
}

/* ---------- START VISION ---------- */
async function startVision() {
  if (visionRunning) return;

  if (typeof tmImage === 'undefined') {
    toast('Library AI gagal dimuat (cek koneksi CDN)', 'error');
    setVfLabel('Library AI gagal dimuat', 'danger');
    setLed('led-ai', 'err');
    return;
  }

  const url = (tmUrlInput && tmUrlInput.value || '').trim().replace(/\/+$/, '') + '/';
  if (!url || url === '/') {
    toast('Masukkan URL Teachable Machine dulu', 'error');
    return;
  }

  localStorage.setItem(STORAGE_KEY, tmUrlInput.value.trim());
  const btn = $('btnStartVision');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>LOADING MODEL...</span>';
  }
  setVfLabel('Memuat model AI...', 'loading');

  try {
    // 1. Validasi label model
    const metaRes = await fetch(url + 'metadata.json');
    if (!metaRes.ok) throw new Error('metadata.json tidak ditemukan (HTTP ' + metaRes.status + ')');
    const metadata = await metaRes.json();
    tmLabels = metadata.labels || [];
    // Cocokkan label case-insensitive: "Biru"/"biru"/"BIRU" semua dianggap "biru"
    const tmHas = (w) => tmLabels.some((l) => String(l).toLowerCase() === w);
    const missing = EXPECTED_LABELS.filter((l) => !tmHas(l));
    if (missing.length === EXPECTED_LABELS.length) {
      throw new Error(
        'Model hanya berisi [' + tmLabels.join(', ') + '], kurang: ' + missing.join(', ') +
        '. Solusi: di Teachable Machine pastikan class: biru, kuning, merah → Train Model → Export → Upload.'
      );
    }

    // 2. Load model
    tmModel = await tmImage.load(url + 'model.json', url + 'metadata.json');

    // 3. Nyalakan kamera — pakai getUserMedia + <video> langsung
    //    (lebih andal daripada tmImage.Webcam; CSS .camera-container video sudah siap)
    await startCamera();

    const placeholder = $('camPlaceholder'); // may not exist
    if (placeholder) placeholder.style.display = 'none';

    const camBadge = $('camBadge');
    const camBadgeText = $('camBadgeText');
    if (camBadge) camBadge.classList.add('live');
    if (camBadgeText) camBadgeText.textContent = 'TM LIVE';

    const indicCam = $('indicCam');
    const indicCamText = $('indicCamText');
    if (indicCam) indicCam.className = 'indic ok';
    if (indicCamText) indicCamText.textContent = 'TM Active';

    const btnStart = $('btnStartVision');
    if (btnStart) {
      btnStart.disabled = false;
      btnStart.classList.remove('ready');
      btnStart.classList.add('running');
      btnStart.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>PAUSE</span>';
    }
    
    setLed('led-ai', 'on');
    setAiTag('Aktif', true);
    setVfLabel('Live Vision AI (Aktif)', 'live');
    toast('AI Vision Online — ' + tmLabels.join(', '), 'success');
    visionRunning = true;
    requestAnimationFrame(detectLoop);
  } catch (err) {
    console.error('[AI] START gagal:', err);
    const btn = $('btnStartVision');
    if (btn) {
      btn.disabled = false;
      btn.classList.add('ready');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>START VISION</span>';
    }
    setVfLabel('Gagal: ' + (err.message || err), 'danger');
    setLed('led-ai', 'err');
    toast('Gagal: ' + (err.message || err), 'error');
  }
}

/* ---------- Kamera ---------- */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Browser tidak mendukung kamera (butuh HTTPS/localhost).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
    audio: false
  });
  videoEl = document.createElement('video');
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.playsInline = true;
  await videoEl.play();
  videoEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;';
  cameraContainer.prepend(videoEl);

  predictCanvas = document.createElement('canvas');
  predictCanvas.width = 224;
  predictCanvas.height = 224;
  setLed('led-sensor', 'on');
}

/* ---------- Probability bars ---------- */
function buildProbBars(labels) {
  if (!aiProbs) return;
  aiProbs.innerHTML = '';
  const list = labels.length ? labels : EXPECTED_LABELS;
  list.forEach((name) => {
    const clsInfo = TM_CLASS_MAP[name] || {};
    const color = clsInfo.color || '#93c5fd';
    const label = clsInfo.label || name;
    const row = document.createElement('div');
    row.className = 'prob-row';
    row.dataset.cls = name;
    row.innerHTML =
      '<span class="prob-name">' + label + '</span>' +
      '<span class="prob-track"><span class="prob-fill" style="background:' + color + '"></span></span>' +
      '<span class="prob-pct">0%</span>';
    aiProbs.appendChild(row);
  });
}

function updateProbBars(predictions) {
  if (!aiProbs) return;
  predictions.forEach((p) => {
    const cls = String(p.className || '').toLowerCase();
    const row = aiProbs.querySelector('[data-cls="' + cls + '"]');
    if (!row) return;
    const pct = Math.round(p.probability * 100);
    row.querySelector('.prob-fill').style.width = pct + '%';
    row.querySelector('.prob-pct').textContent = pct + '%';
  });
}

/* ---------- Loop prediksi ---------- */
async function detectLoop() {
  if (!visionRunning || !tmModel || !videoEl || videoEl.readyState < 2) {
    if (visionRunning) requestAnimationFrame(detectLoop);
    return;
  }

  if (!isCoolingDown) {
    try {
      const ctx = predictCanvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, predictCanvas.width, predictCanvas.height);
      const predictions = await tmModel.predict(predictCanvas);
      updateProbBars(predictions);

      let top = null;
      for (const p of predictions) {
        if (!top || p.probability > top.probability) top = p;
      }
      if (top && top.probability >= CONFIDENCE_THRESHOLD) {
        handleDetection(top.className, top.probability);
      }
    } catch (err) {
      console.error('[AI] Prediksi gagal:', err);
    }
  }
  requestAnimationFrame(detectLoop);
}

/* ---------- Hasil deteksi → closed-loop QC (kamera vs bin micro:bit) ----------
   Berlaku SAMA untuk mode Servo & Recovery. Bedanya cuma teks aksi.
   QC identik: kamera == echo micro:bit → Success, beda/timeout → Miss-sort. */
function handleDetection(className, confidence) {
  // TM bisa mengembalikan "Biru", "biru", "MERAH" — normalisasi ke lowercase
  const cn = String(className || '').toLowerCase();
  const mapped = TM_CLASS_MAP[cn];
  if (!mapped) return;

  // Kalau transaksi lama masih pending (sensor tak kunjung bunyi), tutup sebagai Timeout dulu
  if (pendingPayload) {
    clearTimeout(binTimeoutId);
    const old = pendingPayload;
    pendingPayload = null;
    pendingTxKey = null;
    resolveQc(old, null, 'timeout-override');
  }

  // Cek koneksi Bluetooth sebelum kirim
  if (!isConnected) {
    // Set warna untuk UI tapi jangan kirim
    pendingColor = mapped.key;
    lastSentCommand = null;
    updateCameraStatus();
    const msg = `[ERROR] Micro:bit Belum Terhubung! Kamera: ${mapped.key.toUpperCase()}`;
    sysLog(msg, 'err');
    showMatchError('noconnect', mapped.key, null);
    
    // Reset setelah 1.5 detik
    clearTimeout(matchTimeout);
    matchTimeout = setTimeout(() => {
      pendingColor = null;
      updateCameraStatus();
      showIdleMatch();
    }, 1500);
    return;
  }

  isCoolingDown = true;
  const modeFlow = MODES[currentMode].flow[cn] || { step: 'UNKNOWN', type: 'unknown' };
  const dest = destFor(cn); // = EXPECTED_BIN[cn]

  pendingDest = dest;
  pendingTxKey = 'TX-' + Date.now().toString(36).toUpperCase();

  const payload = {
    key: pendingTxKey,
    id: 'OBJ-' + String(window.__sfaiTotal = (window.__sfaiTotal || 0) + 1).padStart(3, '0'),
    timestamp: new Date().toISOString(),
    // Kamera detect apa:
    color: mapped.key,
    colorLabel: mapped.label,
    confidence: Math.round(confidence * 100),
    mode: currentMode,
    modeName: MODES[currentMode].name,
    // Harusnya masuk mana:
    destination: dest,
    expectedBin: dest,
    // Sensor bin detect apa (diisi saat feedback datang):
    sensorBin: null,
    sensorLabel: 'Menunggu sensor…',
    action: modeFlow.step,
    actionType: modeFlow.type,
    result: 'Pending'
  };
  pendingPayload = payload;

  showDetectionBox(mapped, confidence);
  flashCameraBorder(mapped.color);

  // Tampilkan baris Pending dulu biar kamera vs bin kelihatan real-time
  window.dispatchEvent(new CustomEvent('sfai:item-pending', { detail: { ...payload } }));

  // Kirim warna terdeteksi ke Micro:bit → nanti di-echo balik → validasi match
  pendingColor = mapped.key; // simpan untuk handleValidation
  sendCommand(mapped.key, payload);

  // 3 detik timeout menunggu echo micro:bit → gagal = Miss-sort
  clearTimeout(matchTimeout);
  matchTimeout = setTimeout(() => handleTimeout(), TIMEOUT_MS);

  // Cooldown 3 detik ala guru
  setTimeout(() => { isCoolingDown = false; }, COOLDOWN_MS);
}

function destFor(className) {
  return EXPECTED_BIN[String(className || '').toLowerCase()] || 'biru';
}

/* ---------- Web Bluetooth Logic ---------- */
async function connectBluetooth() {
  if (isConnected) { if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect(); return; }
  if (isConnecting) return;
  if (!navigator.bluetooth || !navigator.bluetooth.requestDevice) {
    sysLog('Web Bluetooth tidak didukung. Gunakan Chrome/Edge + HTTPS.', 'err');
    alert('Web Bluetooth tidak didukung.\n\nGunakan Chrome/Edge melalui HTTPS atau http://localhost.');
    return;
  }
  isConnecting = true; rxBuffer = '';
  try {
    showConnectOverlay('Mencari Micro:bit...', 'Pastikan Micro:bit menyala & Bluetooth aktif');
    // Filter OR: Micro:bit berdasarkan nama ATAU device yang mengiklankan UART service
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'BBC micro:bit' },
        { services: [UART_SERVICE] }
      ],
      optionalServices: [UART_SERVICE]
    });
    const name = bleDevice.name || 'Micro:bit';
    const connText = $('connText'), connSub = $('connSub');
    if (connText) connText.textContent = `Menghubungkan ke ${name}...`;
    if (connSub) connSub.textContent = 'Tunggu sebentar...';
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
    const server = await bleDevice.gatt.connect();

    // Perlu layanan UART ditambahkan karena bukan primary service yang pasti di-klaim
    let service;
    try {
      service = await server.getPrimaryService(UART_SERVICE);
    } catch (e) {
      throw new Error('Layanan UART tidak ditemukan di device. Flash micro:bit dengan kode UART service (6e400001…).');
    }

    // Mapping NUS:
    //   6e400002 = RX (write di sisi micro:bit) → Web WRITE ke sini
    //   6e400003 = TX (notify di sisi micro:bit) → Web subscribe di sini
    try { rxCharWrite = await service.getCharacteristic(UUID_RX_WRITE); }
    catch (e) { rxCharWrite = await service.getCharacteristic(UUID_TX_NOTIFY); }
    try { txCharNotify = await service.getCharacteristic(UUID_TX_NOTIFY); }
    catch (e) { txCharNotify = await service.getCharacteristic(UUID_RX_WRITE); }
    await txCharNotify.startNotifications();
    txCharNotify.addEventListener('characteristicvaluechanged', handleDataReceived);
    isConnected = true; isConnecting = false; updateUI(true); hideConnectOverlay();
    sysLog(`Terhubung ke "${name}"`, 'sys');
  } catch (err) {
    isConnecting = false;
    let msg = (err && err.message) ? err.message : String(err || 'Unknown error');
    // Terjemahkan error umum Web Bluetooth jadi pesan yang jelas
    if (err && err.name === 'NotFoundError') msg = 'Tidak ada Micro:bit ditemukan — pastikan Micro:bit menyala dan tidak terhubung device lain.';
    else if (err && err.name === 'NetworkError') msg = 'Gagal connect — coba nyalakan-ulang Micro:bit dan klik sekali lagi.';
    else if (err && err.name === 'SecurityError') msg = 'Bluetooth butuh HTTPS — buka lewat Chrome/Edge HTTPS atau http://localhost.';
    sysLog('Gagal: ' + msg, 'err');
    const connText = $('connText'), connSub = $('connSub');
    if (connText) connText.textContent = 'Gagal terhubung';
    if (connSub) connSub.textContent = msg;
    setTimeout(hideConnectOverlay, 2500);
    updateUI(false);
  }
}

function onDisconnected() {
  isConnected = false;
  rxCharWrite = null;
  txCharNotify = null;
  rxBuffer = '';
  clearTimeout(matchTimeout); matchTimeout = null;
  clearTimeout(binTimeoutId); binTimeoutId = null;
  updateUI(false);
  sysLog('Bluetooth terputus', 'err');
  showMatchError('disconnect', null, null);
}

function handleDataReceived(event) {
  const chunk = new TextDecoder().decode(event.target.value);
  rxBuffer += chunk;
  let lines = rxBuffer.split('\n');
  rxBuffer = lines.pop(); // keep incomplete
  for (let line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const receivedCommand = raw; // e.g. "merah" dari micro:bit
    sysLog(`RX ← ${receivedCommand}`, 'rx');
    handleValidation(receivedCommand);
  }
}

async function sendCommand(command, payload) {
  // command: "merah"/"biru"/"kuning" lowercase → kirim murni lowercase + "\n"
  if (!isConnected || !rxCharWrite) {
    sysLog('TX gagal: belum terhubung', 'err');
    return;
  }
  // debounce: prevent same sent spam
  const toSend = String(command || '').toLowerCase(); // merah / biru / kuning
  if (toSend === String(lastSentCommand || '').toLowerCase()) {
    return;
  }
  lastSentCommand = toSend;
  try {
    const data = new TextEncoder().encode(toSend + "\n");
    await rxCharWrite.writeValue(data);
    sysLog(`TX → ${toSend}` + '\\n', 'tx');
  } catch (e) { sysLog('TX Error: ' + e.message, 'err'); }
}

function handleValidation(receivedCommand) {
  // receivedCommand adalah echo dari Micro:bit, contoh: "merah" atau "merah\n"
  clearTimeout(matchTimeout); matchTimeout = null;
  clearTimeout(binTimeoutId); binTimeoutId = null;
  const received = String(receivedCommand || '').trim().toLowerCase(); // merah / biru / kuning
  const sent = String(lastSentCommand || '').trim().toLowerCase();     // merah / biru / kuning
  const cam = pendingColor; // warna kamera yang sedang menunggu
  if (!received) return;
  // Validation: compare sent vs received (case-insensitive, keduanya lowercase)
  if (sent && received === sent) {
    const incoming = received; // merah/biru/kuning
    if (cam && cam === incoming) {
      // MATCH SUCCESS — kamera & micro:bit sepakat
      showMatchSuccess(cam, incoming);
      resolveQc(pendingPayload, incoming, null);
    } else if (cam && cam !== incoming) {
      // MISMATCH — kamera bilang X, micro:bit balas Y
      showMatchError('mismatch', cam, incoming);
      resolveQc(pendingPayload, incoming, 'mismatch');
    } else {
      // Echo OK tapi tidak ada kamera pending — cukup tampilkan saja
      showMatchSuccess(incoming, incoming);
      sysLog(`✅ ECHO OK Sent: ${sent} | Received: ${received}`, 'match');
    }
    // reset for next round after short delay
    setTimeout(() => { pendingPayload = null; pendingColor = null; updateCameraStatus(); lastSentCommand = null; }, 900);
  } else {
    // MISMATCH ERROR — micro:bit balas beda dari yang dikirim
    showMatchError('mismatch', cam || sent, received);
    resolveQc(pendingPayload, received, 'mismatch');
    setTimeout(() => { pendingPayload = null; pendingColor = null; updateCameraStatus(); lastSentCommand = null; }, 900);
  }
}

function handleTimeout() {
  if (!pendingColor) return;
  const cam = pendingColor;
  const msg = `[ERROR TIMEOUT 3s] Kamera: ${cam.toUpperCase()} | Micro:bit: No Data`;
  sysLog(msg, 'timeout');
  showMatchError('timeout', cam, null);
  pendingColor = null;
  lastSentCommand = null;
  updateCameraStatus();
}

/* ---------- Switch Mode (admin → sinkron ke mana-mana) ---------- */
function switchMode(modeId) {
  if (!MODES[modeId] || modeId === currentMode) {
    // tetap update UI walau sama (biar konsisten)
  }
  currentMode = modeId;
  const dServo = document.getElementById('detailServo');
  const dRec = document.getElementById('detailRecovery');
  if (dServo) {
    dServo.classList.toggle('active', modeId === 'servo');
    dServo.setAttribute('aria-pressed', String(modeId === 'servo'));
  }
  if (dRec) {
    dRec.classList.toggle('active', modeId === 'recovery');
    dRec.setAttribute('aria-pressed', String(modeId === 'recovery'));
  }
  const nameEl = document.getElementById('activeModeName');
  if (nameEl) nameEl.textContent = MODES[modeId].name;

  // Sinkron: event global → mode "biasa"/guest ikut berubah real-time
  window.dispatchEvent(new CustomEvent('sfai:mode-changed', {
    detail: { mode: modeId, modeName: MODES[modeId].name, modeDesc: MODES[modeId].desc }
  }));
  console.log('[AI] Mode →', MODES[modeId].name);
}

/* ---------- Visual: detection box + flash border ---------- */
function showDetectionBox(mapped, confidence) {
  const dBox = $('detectBox'), dLabel = $('detectLabel'), dConf = $('detectConfidence'), dArrow = $('detectArrow');
  if (!dBox || !dLabel || !dConf || !dArrow) return;
  dBox.style.setProperty('--detect-color', mapped.color);
  dLabel.textContent = mapped.label;
  dConf.textContent = Math.round(confidence * 100) + '% confidence';
  const dirs = ['top', 'bottom', 'left', 'right'];
  dArrow.className = 'detect-arrow ' + dirs[Math.floor(Math.random() * dirs.length)];
  dBox.classList.remove('visible', 'pulse');
  requestAnimationFrame(() => {
    dBox.classList.add('visible', 'pulse');
  });
  setTimeout(() => dBox.classList.remove('visible', 'pulse'), 2000);
}

function flashCameraBorder(color) {
  if (!cameraContainer) return;
  cameraContainer.style.borderColor = color;
  cameraContainer.style.boxShadow = 'inset 0 0 60px rgba(0,0,0,0.65), 0 0 25px ' + color;
  setTimeout(() => {
    cameraContainer.style.borderColor = '';
    cameraContainer.style.boxShadow = '';
  }, 1500);
}

/* ---------- Bluetooth Connection UI Functions ---------- */
function showConnectOverlay(text, sub) {
  const connText = $('connText'), connSub = $('connSub'), connectOverlay = $('connectOverlay');
  if (connText) connText.textContent = text || 'MENGHUBUNGKAN';
  if (connSub) connSub.textContent = sub || 'Mencari perangkat...';
  if (connectOverlay) connectOverlay.classList.add('active');
  startConnectLEDs();
}

function hideConnectOverlay() {
  const connectOverlay = $('connectOverlay');
  if (connectOverlay) connectOverlay.classList.remove('active');
  stopConnectLEDs();
}

function updateUI(connected) {
  isConnected = connected;
  const btDotEl = $('btDot'), btTextEl = $('btText');
  const btStatusEl = $('btStatus');
  const btn2 = $('connectBtn2');
  const iBt = $('indicBt'), iBtT = $('indicBtText');
  const tag = $('btStatusTag');

  if (btDotEl) btDotEl.style.background = connected ? '#22c55e' : '#ef4444';
  if (btTextEl) btTextEl.textContent = connected ? 'Terhubung — klik untuk putuskan' : 'Belum terhubung — tekan tombol di bawah';
  if (btStatusEl) {
    if (connected) btStatusEl.classList.add('connected');
    else btStatusEl.classList.remove('connected');
  }
  if (btn2) {
    btn2.disabled = false;
    btn2.textContent = connected ? 'Putuskan Koneksi' : 'Hubungkan Bluetooth';
    btn2.className = connected ? 'nav-connect disconnect' : 'nav-connect';
  }
  if (iBt) iBt.className = connected ? 'indic ok' : 'indic bad';
  if (iBtT) iBtT.textContent = connected ? 'Connected' : 'Disconnected';
  if (tag) {
    tag.innerHTML = connected
      ? '<span class="tag-pulse"></span>Terhubung'
      : '<span class="tag-pulse"></span>Belum Terhubung';
  }
  try { updateCameraStatus(); } catch (e) {}
}

/* ---------- Match Display Functions (using existing qcMatch elements) ---------- */
function showMatchSuccess(cam, mb) {
  const qcCamEl = $('qcCam'), qcBinEl = $('qcBin'), qcBadge = $('qcBadge'), qcMatchRate = $('qcMatchRate');
  if (qcCamEl) qcCamEl.textContent = cam.toUpperCase();
  if (qcBinEl) qcBinEl.textContent = mb.toUpperCase();
  if (qcBadge) { 
    qcBadge.className = 'qc-badge ok'; 
    qcBadge.textContent = 'MATCH'; 
  }
  sysLog(`[MATCH SUCCESS] Kamera: ${cam.toUpperCase()} | Micro:bit: ${mb.toUpperCase()}`, 'match');
  if (navigator.vibrate) navigator.vibrate(60);
  if (qcMatchRate) qcMatchRate.textContent = '100%';
  const icon = $('matchIcon');
  if (icon) { icon.style.transform = 'scale(1.08)'; setTimeout(() => icon.style.transform = '', 300); }
}

function showMatchError(type, cam, mb) {
  const qcCamEl = $('qcCam'), qcBinEl = $('qcBin'), qcBadge = $('qcBadge');
  if (type === 'timeout') {
    if (qcCamEl) qcCamEl.textContent = (cam || '—').toUpperCase();
    if (qcBinEl) qcBinEl.textContent = 'NO DATA';
    if (qcBadge) { qcBadge.className = 'qc-badge timeout'; qcBadge.textContent = 'TIMEOUT'; }
    sysLog(`[ERROR TIMEOUT 3s] Kamera: ${cam.toUpperCase()} | Micro:bit: No Data`, 'timeout');
  } else if (type === 'noconnect') {
    if (qcCamEl) qcCamEl.textContent = cam.toUpperCase();
    if (qcBinEl) qcBinEl.textContent = 'NOT CONNECTED';
    if (qcBadge) { qcBadge.className = 'qc-badge error'; qcBadge.textContent = 'ERROR'; }
    sysLog(`[ERROR] Micro:bit Belum Terhubung! Kamera: ${cam.toUpperCase()}`, 'err');
    if (navigator.vibrate) navigator.vibrate([80, 40, 80, 40, 80]);
  } else if (type === 'disconnect') {
    if (qcCamEl) qcCamEl.textContent = '—';
    if (qcBinEl) qcBinEl.textContent = 'DISCONNECTED';
    if (qcBadge) { qcBadge.className = 'qc-badge error'; qcBadge.textContent = 'OFF'; }
    sysLog('Bluetooth terputus', 'err');
  } else {
    if (qcCamEl) qcCamEl.textContent = (cam || '?').toUpperCase();
    if (qcBinEl) qcBinEl.textContent = (mb || '?').toUpperCase();
    if (qcBadge) { qcBadge.className = 'qc-badge error'; qcBadge.textContent = 'ERROR'; }
    const msg = `[ERROR MISMATCH] Kamera: ${String(cam || '?').toUpperCase()} | Micro:bit: ${String(mb || '?').toUpperCase()}`;
    sysLog(msg, 'mismatch');
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
  }
}

function showWaiting(mb) {
  const qcCamEl = $('qcCam'), qcBinEl = $('qcBin'), qcBadge = $('qcBadge');
  if (qcCamEl) qcCamEl.textContent = '—';
  if (qcBinEl) qcBinEl.textContent = mb.toUpperCase();
  if (qcBadge) { qcBadge.className = 'qc-badge wait'; qcBadge.textContent = 'WAIT'; }
}

function showIdleMatch() {
  const qcCamEl = $('qcCam'), qcBinEl = $('qcBin'), qcBadge = $('qcBadge');
  if (qcCamEl) qcCamEl.textContent = '—';
  if (qcBinEl) qcBinEl.textContent = '—';
  if (qcBadge) { qcBadge.className = 'qc-badge idle'; qcBadge.textContent = 'STANDBY'; }
}

function clearMatchBadgeSoon() { try { setTimeout(showIdleMatch, 2000); } catch (e) {} }

/* ---------- Connect Overlay LEDs (safe no-op, elemen tidak ada di admin.html) ---------- */
function startConnectLEDs() { return; }
function stopConnectLEDs() { if (connectLEDInterval) { try { clearInterval(connectLEDInterval); } catch (e) {} } }
function animateConnectLEDs() { return; }

/* ---------- Loader LEDs (safe no-op) ---------- */
function startLoaderLEDs() { return; }
function stopLoaderLEDs() { if (ledInterval) { try { clearInterval(ledInterval); } catch (e) {} } }
function animateLoaderLEDs() { return; }

/* ---------- Loading Simulation (safe, dilewati jika elemen tidak ada) ---------- */
function simulateLoading() { return; }

/* ---------- Init LED Grids (safe) ---------- */
function buildLEDGrid(c, cls) {
  if (!c) return;
  try {
    c.innerHTML = '';
    for (let i = 0; i < 25; i++) { const d = document.createElement('div'); d.className = cls; c.appendChild(d); }
  } catch (e) {}
}