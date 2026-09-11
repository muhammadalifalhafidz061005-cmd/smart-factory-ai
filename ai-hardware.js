/* ============================================================
   Smart Factory AI — ai-hardware.js (Admin)
   START-gated: kamera + model hanya jalan setelah START VISION.
   Tanpa hosting: murni localStorage + event (simulasi hardware).
   ============================================================ */

/* ---------- Mapping kelas Teachable Machine → Internal ----------
   Nama HARUS persis sama dengan label di Teachable Machine:
   "Merah", "Kuning", "Hitam", "Biru"                            */
const TM_CLASS_MAP = {
  Merah:  { key: 'merah',  label: 'Merah',  color: '#ef4444' },
  Kuning: { key: 'kuning', label: 'Kuning', color: '#facc15' },
  Hitam:  { key: 'hitam',  label: 'Hitam',  color: '#94a3b8' },
  Biru:   { key: 'biru',   label: 'Biru',   color: '#3b82f6' }
};
const EXPECTED_LABELS = Object.keys(TM_CLASS_MAP);

const CONFIDENCE_THRESHOLD = 0.75;
const COOLDOWN_MS = 3000; // jeda antar trigger (ala guru)
const STORAGE_KEY = 'sfai_tm_model_url';

const MODES = {
  servo: {
    id: 'servo',
    name: 'Fast Sorting (Servo)',
    desc: 'High Throughput',
    flow: {
      Merah:  { step: 'PASS', type: 'pass' },
      Kuning: { step: 'SERVO → Y-Bin', type: 'servo' },
      Hitam:  { step: 'SERVO → B-Bin', type: 'servo' },
      Biru:   { step: 'PASS', type: 'pass' }
    }
  },
  recovery: {
    id: 'recovery',
    name: 'Robotic Recovery (Precision)',
    desc: 'Precision Handling',
    flow: {
      Merah:  { step: 'PASS', type: 'pass' },
      Kuning: { step: 'IR → STOP → ARM → Y-Bin', type: 'arm' },
      Hitam:  { step: 'IR → STOP → ARM → B-Bin', type: 'arm' },
      Biru:   { step: 'PASS', type: 'pass' }
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

/* ---------- Elemen DOM ---------- */
const cameraContainer = document.getElementById('camera-container');
const tmUrlInput = document.getElementById('tmUrl');
const btnStartVision = document.getElementById('btnStartVision');
const aiProbs = document.getElementById('aiProbs');
const aiStatusTag = document.getElementById('aiStatusTag');
const vfLabel = document.getElementById('vfLabel');
const detectBox = document.getElementById('detectBox');
const detectLabel = document.getElementById('detectLabel');
const detectConfidence = document.getElementById('detectConfidence');
const detectArrow = document.getElementById('detectArrow');

/* ---------- Helpers ---------- */
function setLed(id, state) {
  window.dispatchEvent(new CustomEvent('sfai:led-status', { detail: { key: id, state } }));
}

function setVfLabel(text, type) {
  if (!vfLabel) return;
  vfLabel.textContent = text;
  vfLabel.style.borderColor =
    type === 'live' ? 'rgba(52, 211, 153, 0.6)'
    : type === 'danger' ? 'rgba(248, 113, 113, 0.7)'
    : type === 'loading' ? 'rgba(250, 204, 21, 0.6)'
    : 'rgba(147, 197, 253, 0.3)';
}

function setAiTag(text, live) {
  if (!aiStatusTag) return;
  aiStatusTag.innerHTML = '<span class="tag-pulse"></span>' + text;
  aiStatusTag.classList.toggle('live', !!live);
}

function toast(msg, type) {
  window.dispatchEvent(new CustomEvent('sfai:toast', { detail: { msg, type: type || 'info' } }));
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

  buildProbBars([]);
  setVfLabel('Klik START VISION untuk mengaktifkan kamera', 'idle');
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
  
  // Stop camera stream
  if (videoEl && videoEl.srcObject) {
    const tracks = videoEl.srcObject.getTracks();
    tracks.forEach(track => track.stop());
    videoEl.srcObject = null;
  }
  
  // Remove video element
  if (videoEl && videoEl.parentNode) {
    videoEl.parentNode.removeChild(videoEl);
    videoEl = null;
  }
  
  // Reset UI
  btnStartVision.disabled = false;
  btnStartVision.classList.remove('running');
  btnStartVision.classList.add('ready');
  btnStartVision.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>START VISION</span>';
  
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

  const url = (tmUrlInput.value || '').trim().replace(/\/+$/, '') + '/';
  if (!url || url === '/') {
    toast('Masukkan URL Teachable Machine dulu', 'error');
    return;
  }

  localStorage.setItem(STORAGE_KEY, tmUrlInput.value.trim());
  btnStartVision.disabled = true;
  btnStartVision.innerHTML = '<span>LOADING MODEL...</span>';
  setVfLabel('Memuat model AI...', 'loading');

  try {
    // 1. Validasi label model
    const metaRes = await fetch(url + 'metadata.json');
    if (!metaRes.ok) throw new Error('metadata.json tidak ditemukan (HTTP ' + metaRes.status + ')');
    const metadata = await metaRes.json();
    tmLabels = metadata.labels || [];
    const missing = EXPECTED_LABELS.filter((l) => !tmLabels.includes(l));
    if (missing.length > 0) {
      throw new Error(
        'Model hanya berisi [' + tmLabels.join(', ') + '], kurang: ' + missing.join(', ') +
        '. Solusi: di Teachable Machine klik Train Model → Export Model → Upload, lalu pakai URL baru.'
      );
    }

    // 2. Load model
    tmModel = await tmImage.load(url + 'model.json', url + 'metadata.json');

    // 3. Nyalakan kamera
    await startCamera();

    // 4. Jalan!
    visionRunning = true;
    btnStartVision.disabled = false;
    buildProbBars(tmLabels);
    btnStartVision.classList.remove('ready');
    btnStartVision.classList.add('running');
    btnStartVision.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>PAUSE</span>';
    setLed('led-ai', 'on');
    setAiTag('Aktif', true);
    setVfLabel('Live Vision AI (Aktif)', 'live');
    toast('AI Vision Online — ' + tmLabels.join(', '), 'success');
    requestAnimationFrame(detectLoop);
  } catch (err) {
    console.error('[AI] START gagal:', err);
    btnStartVision.disabled = false;
    btnStartVision.classList.add('ready');
    btnStartVision.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>START VISION</span>';
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
    const color = (TM_CLASS_MAP[name] || {}).color || '#93c5fd';
    const row = document.createElement('div');
    row.className = 'prob-row';
    row.dataset.cls = name;
    row.innerHTML =
      '<span class="prob-name">' + name + '</span>' +
      '<span class="prob-track"><span class="prob-fill" style="background:' + color + '"></span></span>' +
      '<span class="prob-pct">0%</span>';
    aiProbs.appendChild(row);
  });
}

function updateProbBars(predictions) {
  if (!aiProbs) return;
  predictions.forEach((p) => {
    const row = aiProbs.querySelector('[data-cls="' + p.className + '"]');
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

/* ---------- Hasil deteksi → closed-loop (simulasi hardware) ---------- */
function handleDetection(className, confidence) {
  const mapped = TM_CLASS_MAP[className];
  if (!mapped) return;

  isCoolingDown = true;
  const modeFlow = MODES[currentMode].flow[className] || { step: 'UNKNOWN', type: 'unknown' };
  const dest = destFor(className);

  pendingDest = dest;
  pendingTxKey = 'TX-' + Date.now().toString(36).toUpperCase();

  const payload = {
    key: pendingTxKey,
    id: 'OBJ-' + String(window.__sfaiTotal = (window.__sfaiTotal || 0) + 1).padStart(3, '0'),
    timestamp: new Date().toISOString(),
    color: mapped.key,
    colorLabel: mapped.label,
    confidence: Math.round(confidence * 100),
    mode: currentMode,
    modeName: MODES[currentMode].name,
    destination: dest,
    action: modeFlow.step,
    actionType: modeFlow.type,
    result: 'Pending'
  };

  showDetectionBox(mapped, confidence);
  flashCameraBorder(mapped.color);

  // Kirim perintah ke otak robot: mode aktif sebagai tipe kontrol
  const modeCmd = currentMode === 'recovery' ? 'Arm' : 'Servo';
  sendCommand(modeCmd, payload);

  // Simulasi feedback sensor 1.2 detik kemudian → QC Success
  setTimeout(() => simulateSensorFeedback(payload), 1200);

  // Cooldown 3 detik ala guru
  setTimeout(() => { isCoolingDown = false; }, COOLDOWN_MS);
}

function destFor(className) {
  if (className === 'Kuning') return 'Yellow Bin';
  if (className === 'Hitam') return 'Black Bin';
  if (className === 'Merah') return 'Reject Bin';
  return 'Pass-Through';
}

/* Simulasi perintah ke hardware (ganti dengan Bluetooth saat robot siap) */
function sendCommand(cmd, payload) {
  console.log('[HW-SIM] TX →', cmd, payload);
  setLed('led-sensor', 'err'); // kuning/merah = menunggu feedback
  window.dispatchEvent(new CustomEvent('sfai:command-sent', { detail: { cmd, payload } }));
}

/* Simulasi sensor bin terpicu → update QC jadi Success */
function simulateSensorFeedback(payload) {
  payload.result = 'Success';
  setLed('led-sensor', 'on');
  window.dispatchEvent(new CustomEvent('sfai:item-detected', { detail: payload }));
  console.log('[HW-SIM] RX ← IN_' + payload.colorLabel.toUpperCase(), '→ Success');
  setTimeout(() => setLed('led-sensor', 'on'), 2000);
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
  if (!detectBox || !detectLabel || !detectConfidence || !detectArrow) return;
  detectBox.style.setProperty('--detect-color', mapped.color);
  detectLabel.textContent = mapped.label;
  detectConfidence.textContent = Math.round(confidence * 100) + '% confidence';
  const dirs = ['top', 'bottom', 'left', 'right'];
  detectArrow.className = 'detect-arrow ' + dirs[Math.floor(Math.random() * dirs.length)];
  detectBox.classList.remove('visible', 'pulse');
  requestAnimationFrame(() => {
    detectBox.classList.add('visible', 'pulse');
  });
  setTimeout(() => detectBox.classList.remove('visible', 'pulse'), 2000);
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