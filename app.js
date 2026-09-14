/* ============================================================
   Smart Factory AI — app.js (Admin)
   UI: dock header, toast, theme, Firebase sync, mode sync,
   log 7 kolom, KPI, chart distribusi, export CSV, modal bug.
   Tanpa hosting: localStorage + event (simulasi).
   ============================================================ */

/* ---------- Header: bar di posisi atas, ketarik jadi dock saat scroll (FLIP) ---------- */
const header = document.querySelector('.app-header');
const headerNav = document.querySelector('.header-center');
const DOCK_THRESHOLD = 40;
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let dockTicking = false;
let dockFlipToken = 0;
let lastScrollY = 0;

function updateDock() {
  dockTicking = false;
  if (!header) return;
  
  const shouldDock = window.scrollY > DOCK_THRESHOLD;
  const wasDocked = header.classList.contains('is-dock');
  
  if (wasDocked === shouldDock) {
    // Update scroll progress even if dock state didn't change
    if (shouldDock) updateScrollProgress();
    return;
  }

  // FLIP: ukur posisi menu sebelum & sesudah, lalu luncurkan halus
  let first = null;
  const token = ++dockFlipToken;
  
  if (headerNav && !reducedMotion) {
    // Force layout calculation
    headerNav.style.transition = 'none';
    headerNav.style.transform = '';
    first = headerNav.getBoundingClientRect();
  }

  // Toggle class
  header.classList.toggle('is-dock', shouldDock);

  // FLIP animation
  if (headerNav && first && !reducedMotion) {
    const last = headerNav.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const scaleX = first.width / last.width;
    const scaleY = first.height / last.height;
    
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
      headerNav.style.transition = 'none';
      headerNav.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
      headerNav.style.transformOrigin = 'center center';
      
      // Force reflow
      headerNav.offsetHeight;
      
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (token !== dockFlipToken) return;
          headerNav.style.transition = 'transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)';
          headerNav.style.transform = 'translate(0, 0) scale(1, 1)';
          setTimeout(() => {
            if (token !== dockFlipToken) return;
            headerNav.style.transition = '';
            headerNav.style.transform = '';
            headerNav.style.transformOrigin = '';
          }, 750);
        });
      });
    }
  }

  // Add subtle header transform during transition
  if (!reducedMotion) {
    header.style.transition = 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), background 0.4s cubic-bezier(0.22, 1, 0.36, 1), padding 0.4s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.4s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.4s cubic-bezier(0.22, 1, 0.36, 1)';
    if (shouldDock) {
      header.style.transform = 'translateY(-4px)';
      requestAnimationFrame(() => {
        header.style.transform = 'translateY(0)';
      });
    }
  }

  // Update scroll progress after dock state change
  if (shouldDock) updateScrollProgress();
}

function updateScrollProgress() {
  if (!header || !header.classList.contains('is-dock')) return;
  
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  const progress = maxScroll > 0 ? window.scrollY / maxScroll : 0;
  
  header.classList.toggle('has-scroll', progress > 0.01);
  header.style.setProperty('--scroll-progress', progress.toFixed(3));
}

window.addEventListener('scroll', () => {
  if (!dockTicking) {
    window.requestAnimationFrame(updateDock);
    dockTicking = true;
  }
  lastScrollY = window.scrollY;
}, { passive: true });

// Initialize on load
updateDock();

// Handle resize to recalculate dock state
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateDock, 100);
});

/* ---------- Toast ---------- */
const toastOverlay = document.getElementById('toastOverlay');
const toastBox = document.getElementById('toast');
const toastMsg = document.getElementById('toastMsg');
let toastTimer = null;

function showToast(msg, type) {
  if (!toastOverlay || !toastMsg) return;
  toastMsg.textContent = msg;
  toastBox.className = 'toast ' + (type || 'info');
  toastOverlay.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastOverlay.classList.remove('show'), 3000);
}
window.addEventListener('sfai:toast', (e) => showToast(e.detail.msg, e.detail.type));



/* ---------- State transaksi + statistik ---------- */
const logBody = document.getElementById('logBody');
const MAX_LOG_ROWS = 50;
const transactions = [];
const stats = {
  total: 0, success: 0, miss: 0,
  servo: { total: 0, success: 0, dist: { biru: 0, kuning: 0, silver: 0 } },
  recovery: { total: 0, success: 0, dist: { biru: 0, kuning: 0, silver: 0 } }
};
let currentMode = 'servo';
const MODE_NAMES = {
  servo: 'Fast Sorting',
  recovery: 'Robotic Recovery',
  fast: 'Fast Sorting',
  thinking: 'Thinking Sorting',
  hybrid: 'Hybrid Mode'
};
const DOT_COLORS = { biru: '#0466c8', kuning: '#ffee32', silver: '#e9ecef' };

function setLed(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('on', 'err');
  if (state === 'on') el.classList.add('on');
  if (state === 'err') el.classList.add('err');
}

/* Sync LED status ke header (led-fb, led-bt, led-ai, led-sensor) + dock */
function syncLedStatus(key, state) {
  setLed(key, state);
  const dockId = 'dock' + key.charAt(0).toUpperCase() + key.slice(1); // ledFb -> dockLedFb
  setLed(dockId, state);
}

/* Sync semua LED dari ai-hardware.js event */
window.addEventListener('sfai:led-status', (e) => {
  if (e.detail && e.detail.key && e.detail.state) {
    syncLedStatus(e.detail.key, e.detail.state);
  }
});

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return '-'; }
}

/* ---------- Tabel log (7 kolom) ---------- */
function rowHtml(p) {
  const dot = DOT_COLORS[p.color] || '#94a3b8';
  const cap = p.color ? p.color.charAt(0).toUpperCase() + p.color.slice(1) : '-';
  const badge = p.result === 'Success' ? 'badge-ok' : (p.result === 'Miss-sort' ? 'badge-err' : 'badge-pending');
  return (
    '<td>' + fmtTime(p.timestamp) + '</td>' +
    '<td><code class="tx-id">' + (p.id || '-') + '</code></td>' +
    '<td><span class="color-chip"><span class="dot" style="background:' + dot + '"></span>' + (p.colorLabel || cap) + '</span></td>' +
    '<td class="tx-conf">' + (p.confidence != null ? p.confidence + '%' : '-') + '</td>' +
    '<td><span class="mode-chip">' + (MODE_NAMES[p.mode] || p.mode || '-') + '</span></td>' +
    '<td class="tx-action">' + (p.action || '-') + '</td>' +
    '<td><span class="status-badge ' + badge + '">' + (p.result || 'Pending') + '</span></td>'
  );
}

function addLogRow(p) {
  if (!logBody) return;
  const empty = logBody.querySelector('.empty-state');
  if (empty) empty.closest('tr').remove();
  const tr = document.createElement('tr');
  tr.innerHTML = rowHtml(p);
  logBody.prepend(tr);
  while (logBody.children.length > MAX_LOG_ROWS) logBody.lastChild.remove();
}

function refreshLogTable() {
  if (!logBody) return;
  logBody.innerHTML = '';
  if (!transactions.length) {
    logBody.innerHTML = '<tr><td colspan="7" class="empty-state"><span>Belum ada transaksi.<br>Data sortir akan tampil secara real-time di sini.</span></td></tr>';
    return;
  }
  transactions.slice(0, MAX_LOG_ROWS).forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = rowHtml(p);
    logBody.appendChild(tr);
  });
}

/* ---------- Statistik + KPI ---------- */
function recalcStats() {
  stats.total = transactions.length;
  stats.success = transactions.filter((t) => t.result === 'Success').length;
  stats.miss = transactions.filter((t) => t.result === 'Miss-sort').length;

  ['servo', 'recovery'].forEach((m) => {
    const list = transactions.filter((t) => t.mode === m);
    stats[m].total = list.length;
    stats[m].success = list.filter((t) => t.result === 'Success').length;
    stats[m].dist = { biru: 0, kuning: 0, silver: 0 };
    list.forEach((t) => { if (stats[m].dist[t.color] != null) stats[m].dist[t.color]++; });
  });

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const cnt = (c) => transactions.filter((t) => t.color === c && t.result === 'Success').length;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + '%' : '0%');

  set('kpiTotal', stats.total);
  set('kpiBiru', cnt('biru'));
  set('kpiKuning', cnt('kuning'));
  set('kpiSilver', cnt('silver'));
  set('kpiSuccessRate', pct(stats.success, stats.total));
  set('kpiErrorRate', pct(stats.miss, stats.total));

  // Bar distribusi + success rate per warna (Ringkasan Kerja)
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const perColor = {};
  ['biru', 'kuning', 'silver'].forEach((c) => {
    const list = transactions.filter((t) => t.color === c);
    perColor[c] = { total: list.length, ok: list.filter((t) => t.result === 'Success').length };
  });
  const maxTotal = Math.max(1, perColor.biru.total, perColor.kuning.total, perColor.silver.total);
  ['biru', 'kuning', 'silver'].forEach((c) => {
    const v = perColor[c];
    set('rate' + cap(c), pct(v.ok, v.total));
    const bar = document.getElementById('bar' + cap(c));
    if (bar) bar.style.height = Math.max(8, Math.round((v.total / maxTotal) * 100)) + '%';
  });

  const cur = stats[currentMode] || stats.servo;
  set('kpiModeRate', pct(cur.success, cur.total));
  set('kpiModeLabel', 'Mode: ' + (currentMode === 'recovery' ? 'Recovery' : 'Servo'));
  set('statServoTotal', stats.servo.total);
  set('statServoRate', pct(stats.servo.success, stats.servo.total));
  set('statRecoveryTotal', stats.recovery.total);
  set('statRecoveryRate', pct(stats.recovery.success, stats.recovery.total));

  drawCharts();
}

function recordTransaction(p) {
  const idx = transactions.findIndex((t) => t.key && t.key === p.key);
  if (idx >= 0) transactions[idx] = p;
  else transactions.unshift(p);
  refreshLogTable();
  recalcStats();
  // Persist lokal (tanpa hosting)
  try { localStorage.setItem('sfai_tx', JSON.stringify(transactions.slice(0, 200))); } catch {}
}

/* Restore transaksi lokal */
try {
  const saved = JSON.parse(localStorage.getItem('sfai_tx') || '[]');
  if (Array.isArray(saved) && saved.length) {
    saved.forEach((p) => transactions.push(p));
    refreshLogTable();
    recalcStats();
  }
} catch {}

/* ---------- Event dari ai-hardware.js ---------- */
window.addEventListener('sfai:item-detected', (e) => recordTransaction(e.detail));

window.addEventListener('sfai:command-sent', (e) => {
  setLed('led-bt', 'on'); // simulasi hardware terkirim
  setTimeout(() => setLed('led-bt', 'off'), 1500);
});

/* Mode berubah di admin → sinkron ke seluruh tampilan (real-time) */
window.addEventListener('sfai:mode-changed', (e) => {
  currentMode = e.detail.mode || 'servo';
  const hint = document.getElementById('modeHint');
  const nameEl = document.getElementById('activeModeName');
  if (nameEl) nameEl.textContent = e.detail.modeName;
  if (hint) {
    const strong = hint.querySelector('strong');
    if (strong) strong.textContent = e.detail.modeName;
  }
  recalcStats();
  showToast('Mode → ' + e.detail.modeName, 'info');
  // Sinkron silang-tab (guest ikut berubah di waktu yang sama)
  try { localStorage.setItem('sfai_mode', JSON.stringify(e.detail)); } catch {}
});

/* Sinkron mode antar tab (storage event = real-time) */
window.addEventListener('storage', (e) => {
  if (e.key === 'sfai_mode' && e.newValue) {
    try {
      const d = JSON.parse(e.newValue);
      if (d.mode && d.mode !== currentMode) {
        currentMode = d.mode;
        const dServo = document.getElementById('detailServo');
        const dRec = document.getElementById('detailRecovery');
        if (dServo) dServo.classList.toggle('active', d.mode === 'servo');
        if (dRec) dRec.classList.toggle('active', d.mode === 'recovery');
        recalcStats();
      }
    } catch {}
  }
});

/* ---------- Firebase SYNC (admin only, opsional) ---------- */
(function initFirebaseSync() {
  const keyEl = document.getElementById('fbKey');
  const urlEl = document.getElementById('fbUrl');
  const btn = document.getElementById('btnSyncFb');
  if (!keyEl || !urlEl || !btn) return;

  try {
    const cfg = JSON.parse(localStorage.getItem('sfai_fb') || '{}');
    if (cfg.key) keyEl.value = cfg.key;
    if (cfg.url) urlEl.value = cfg.url;
  } catch {}

  btn.addEventListener('click', async () => {
    const key = keyEl.value.trim();
    const url = urlEl.value.trim();
    if (!key || !url) {
      showToast('Lengkapi API Key & DB URL dulu', 'error');
      setLed('led-fb', 'err');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'SYNC...';
    try {
      const { initializeApp, getApps, deleteApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const { getDatabase, ref, onValue } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js');
      const apps = getApps();
      if (apps.length) await deleteApp(apps[0]);
      const projectId = (url.split('//')[1] || '').split('.')[0];
      const app = initializeApp({ apiKey: key, databaseURL: url, projectId });
      const db = getDatabase(app);
      onValue(ref(db, 'smart_factory/sorting_line/transactions'), (snap) => {
        const data = snap.val();
        if (!data) return;
        Object.values(data).forEach((tx) => {
          recordTransaction({
            key: tx.id || String(tx.timestamp),
            id: tx.id,
            timestamp: new Date(tx.timestamp).toISOString(),
            color: (tx.ai_class || '').toLowerCase(),
            colorLabel: tx.ai_class,
            confidence: tx.confidence,
            mode: tx.sorting_mode === 'ROBOTIC_RECOVERY' ? 'recovery' : 'servo',
            destination: tx.destination,
            action: tx.destination,
            actionType: 'servo',
            result: tx.result
          });
        });
      });
      localStorage.setItem('sfai_fb', JSON.stringify({ key, url }));
      setLed('led-fb', 'on');
      const connTag = document.getElementById('connTag');
      if (connTag) connTag.textContent = 'Terhubung';
      showToast('Database tersinkron', 'success');
    } catch (err) {
      console.error('[FB]', err);
      setLed('led-fb', 'err');
      showToast('Sync gagal: ' + (err.message || err), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'SYNC DB';
    }
  });
})();

/* ---------- Chart distribusi ---------- */
let chartServo = null;
let chartRecovery = null;

function makeChart(id, data, colors) {
  const el = document.getElementById(id);
  if (!el || typeof Chart === 'undefined') return null;
  return new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Merah', 'Kuning', 'Hitam', 'Biru'],
      datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false, barThickness: 22 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: 'rgba(148,163,184,0.15)' } },
        x: { grid: { display: false }, ticks: { font: { size: 10 } } }
      },
      animation: { duration: 400 }
    }
  });
}

function drawCharts() {
  if (typeof Chart === 'undefined') return;
  const colors = ['#0466c8', '#ffee32', '#e9ecef'];
  const sData = [stats.servo.dist.biru, stats.servo.dist.kuning, stats.servo.dist.silver];
  const rData = [stats.recovery.dist.biru, stats.recovery.dist.kuning, stats.recovery.dist.silver];
  if (!chartServo) chartServo = makeChart('chartServo', sData, colors);
  else { chartServo.data.datasets[0].data = sData; chartServo.update(); }
  if (!chartRecovery) chartRecovery = makeChart('chartRecovery', rData, colors);
  else { chartRecovery.data.datasets[0].data = rData; chartRecovery.update(); }
}
drawCharts();

/* ---------- Export (dropdown: PDF / Excel / Docs) ---------- */
(function initExport() {
  const wrap = document.getElementById('exportWrap');
  const mainBtn = document.getElementById('btnExport');
  const menu = document.getElementById('exportMenu');

  // Fallback: markup lama (satu tombol langsung PDF)
  if (!wrap || !mainBtn || !menu) {
    const btn = document.getElementById('btnExportPdf') || document.getElementById('btnExportCsv');
    if (!btn) return;
    btn.addEventListener('click', () => runExport('pdf', btn));
    return;
  }

  const setOpen = (open) => {
    wrap.classList.toggle('open', open);
    mainBtn.setAttribute('aria-expanded', String(open));
  };

  mainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!transactions.length) {
      showToast('Belum ada data untuk diekspor', 'error');
      return;
    }
    setOpen(!wrap.classList.contains('open'));
  });

  menu.querySelectorAll('.export-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const fmt = opt.dataset.format || 'pdf';
      setOpen(false);
      runExport(fmt, mainBtn);
    });
  });

  document.addEventListener('click', (e) => {
    if (wrap.classList.contains('open') && !wrap.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.classList.contains('open')) setOpen(false);
  });
})();

async function runExport(fmt, btn) {
  if (!transactions.length) {
    showToast('Belum ada data untuk diekspor', 'error');
    return;
  }
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Membuat ' + String(fmt).toUpperCase() + '...</span>';
  }
  try {
    if (fmt === 'excel') await exportSortingExcel();
    else if (fmt === 'docs') exportSortingDocs();
    else exportSortingPdf();
    showToast('File ' + String(fmt).toUpperCase() + ' berhasil diunduh', 'success');
  } catch (err) {
    console.error('[EXPORT]', err);
    showToast('Gagal membuat ' + String(fmt).toUpperCase() + ': ' + (err.message || err), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.innerHTML = originalHtml;
    }
  }
}

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

const EXPORT_COLOR_BG = { biru: '#0466c8', kuning: '#ffee32', silver: '#e9ecef' };
const EXPORT_STATUS_BG = { Success: '#38b000', 'Miss-sort': '#6a040f', Pending: '#f77f00' };

function exportRows() {
  return transactions.map((t) => ({
    waktu: fmtTime(t.timestamp),
    id: t.id || '-',
    kelas: t.colorLabel || (t.color ? t.color.charAt(0).toUpperCase() + t.color.slice(1) : '-'),
    color: t.color || '',
    conf: t.confidence != null ? t.confidence + '%' : '-',
    mode: t.modeName || MODE_NAMES[t.mode] || t.mode || '-',
    aksi: t.action || t.destination || '-',
    status: t.result || 'Pending'
  }));
}

function exportSummary() {
  const total = stats.total || transactions.length;
  const success = stats.success || 0;
  const miss = stats.miss || 0;
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 100) + '%' : '0%');
  const cnt = (c) => transactions.filter((t) => t.color === c).length;
  return {
    total, success, miss,
    successRate: rate(success, total),
    errorRate: rate(miss, total),
    biru: cnt('biru'), kuning: cnt('kuning'), silver: cnt('silver'),
    servo: (stats.servo && stats.servo.total) || 0,
    recovery: (stats.recovery && stats.recovery.total) || 0
  };
}

/* ----- Export Excel (.xlsx asli via ExcelJS, berwarna & rapi) ----- */
async function exportSortingExcel() {
  const s = exportSummary();
  const rows = exportRows();
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fileDate = now.toISOString().slice(0, 10);

  // Tanpa library → fallback HTML .xls yang sudah dirapikan
  if (!window.ExcelJS || !window.ExcelJS.Workbook) {
    fallbackExcelHtml(s, rows, dateStr, fileDate);
    return;
  }

  const ARGB = {
    navy: 'FF0F172A', header: 'FF1E293B', white: 'FFFFFFFF', ink: 'FF0F172A',
    gray: 'FF64748B', zebra: 'FFF1F5F9', border: 'FFCBD5E1',
    biru: 'FF0466C8', kuning: 'FFFFEE32', silver: 'FFE9ECEF',
    success: 'FF38B000', miss: 'FF6A040F', pending: 'FFF77F00', dark: 'FF1E293B'
  };
  const thinBorder = {
    top: { style: 'thin', color: { argb: ARGB.border } },
    left: { style: 'thin', color: { argb: ARGB.border } },
    bottom: { style: 'thin', color: { argb: ARGB.border } },
    right: { style: 'thin', color: { argb: ARGB.border } }
  };
  const fillOf = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: hex } });

  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Smart Factory AI';
  wb.created = now;
  const ws = wb.addWorksheet('Sorting Report', {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 6 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });
  ws.columns = [
    { width: 14 }, { width: 17 }, { width: 13 }, { width: 10 },
    { width: 28 }, { width: 36 }, { width: 14 }
  ];

  // Judul
  ws.mergeCells('A1:G1');
  const title = ws.getCell('A1');
  title.value = 'SMART FACTORY AI — SORTING REPORT';
  title.font = { bold: true, size: 16, color: { argb: ARGB.white } };
  title.fill = fillOf(ARGB.navy);
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 30;

  // Subjudul
  ws.mergeCells('A2:G2');
  const sub = ws.getCell('A2');
  sub.value = 'Closed-Loop QC  •  Diekspor: ' + dateStr;
  sub.font = { size: 10, color: { argb: ARGB.gray } };
  sub.alignment = { vertical: 'middle' };
  ws.getRow(2).height = 18;

  // Ringkasan KPI
  const kpiLabels = ['Total', 'Success', 'Error Rate', 'Biru', 'Kuning', 'Silver', 'Servo', 'Recovery'];
  const kpiValues = [s.total, s.success + ' (' + s.successRate + ')', s.errorRate, s.biru, s.kuning, s.silver, s.servo, s.recovery];
  const kpiFills = [ARGB.header, ARGB.success, ARGB.miss, ARGB.biru, ARGB.kuning, ARGB.silver, ARGB.header, ARGB.accent_purple || ARGB.header];
  const lr = ws.getRow(3);
  const vr = ws.getRow(4);
  kpiLabels.forEach((label, i) => {
    const col = i + 1;
    const lc = lr.getCell(col);
    lc.value = label;
    lc.font = { bold: true, size: 8, color: { argb: ARGB.white } };
    lc.fill = fillOf(ARGB.header);
    lc.alignment = { horizontal: 'center', vertical: 'middle' };
    lc.border = thinBorder;
    const vc = vr.getCell(col);
    vc.value = kpiValues[i];
    vc.font = { bold: true, size: 11, color: { argb: (i === 4 ? ARGB.dark : ARGB.white) } };
    vc.fill = fillOf(kpiFills[i]);
    vc.alignment = { horizontal: 'center', vertical: 'middle' };
    vc.border = thinBorder;
  });
  lr.height = 16;
  vr.height = 22;
  ws.getRow(5).height = 6; // spacer

  // Header tabel
  const headers = ['Waktu', 'ID Barang', 'Kelas AI', 'Conf.', 'Mode', 'Aksi Hardware', 'Status QC'];
  const hr = ws.getRow(6);
  headers.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, size: 10, color: { argb: ARGB.white } };
    c.fill = fillOf(ARGB.header);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder;
  });
  hr.height = 22;

  // Baris data
  const KELAS_ARGB = { biru: ARGB.biru, kuning: ARGB.kuning, silver: ARGB.silver };
  rows.forEach((r, idx) => {
    const row = ws.getRow(7 + idx);
    const vals = [r.waktu, r.id, r.kelas, r.conf, r.mode, r.aksi, r.status];
    vals.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v;
      c.font = { size: 10, color: { argb: ARGB.ink }, bold: (i === 2 || i === 6) };
      c.border = thinBorder;
      c.alignment = { vertical: 'middle', wrapText: (i === 4 || i === 5), horizontal: ([0, 2, 3, 6].includes(i) ? 'center' : 'left') };
      if (idx % 2 === 1) c.fill = fillOf(ARGB.zebra);
    });
    // Warna Kelas AI
    const kc = row.getCell(3);
    kc.fill = fillOf(KELAS_ARGB[r.color] || ARGB.gray);
    kc.font = { bold: true, size: 10, color: { argb: (r.color === 'kuning' ? ARGB.dark : ARGB.white) } };
    kc.alignment = { horizontal: 'center', vertical: 'middle' };
    // Warna Status QC
    const sc = row.getCell(7);
    if (r.status === 'Success') {
      sc.fill = fillOf(ARGB.success);
      sc.font = { bold: true, size: 10, color: { argb: ARGB.white } };
    } else if (r.status === 'Miss-sort') {
      sc.fill = fillOf(ARGB.miss);
      sc.font = { bold: true, size: 10, color: { argb: ARGB.white } };
    } else {
      sc.fill = fillOf(ARGB.pending);
      sc.font = { bold: true, size: 10, color: { argb: ARGB.dark } };
    }
    sc.alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 20;
  });

  ws.autoFilter = { from: 'A6', to: 'G6' };

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'Sorting_Report_' + fileDate + '.xlsx'
  );
}

/* ----- Fallback Excel (.xls HTML rapi, kolom fix) ----- */
function fallbackExcelHtml(s, rows, dateStr, fileDate) {
  const trs = rows.map((r, i) => {
    const bg = EXPORT_COLOR_BG[r.color] || '#64748b';
    const fg = r.color === 'kuning' || r.color === 'silver' ? '#1e293b' : '#ffffff';
    const sbg = EXPORT_STATUS_BG[r.status] || '#f77f00';
    const sfg = r.status === 'Pending' ? '#1e293b' : '#ffffff';
    const zebra = i % 2 ? 'background:#f1f5f9;' : 'background:#ffffff;';
    const cell = 'border:1px solid #cbd5e1;padding:5px;font-size:10pt;vertical-align:middle;';
    return '<tr>' +
      '<td width="90" style="' + zebra + cell + 'text-align:center;white-space:nowrap;">' + escHtml(r.waktu) + '</td>' +
      '<td width="110" style="' + zebra + cell + 'white-space:nowrap;">' + escHtml(r.id) + '</td>' +
      '<td width="80" style="background:' + bg + ';color:' + fg + ';font-weight:bold;text-align:center;' + cell + '">' + escHtml(r.kelas) + '</td>' +
      '<td width="60" style="' + zebra + cell + 'text-align:center;white-space:nowrap;">' + escHtml(r.conf) + '</td>' +
      '<td width="180" style="' + zebra + cell + 'word-wrap:break-word;">' + escHtml(r.mode) + '</td>' +
      '<td width="230" style="' + zebra + cell + 'word-wrap:break-word;">' + escHtml(r.aksi) + '</td>' +
      '<td width="90" style="background:' + sbg + ';color:' + sfg + ';font-weight:bold;text-align:center;' + cell + 'white-space:nowrap;">' + escHtml(r.status) + '</td>' +
      '</tr>';
  }).join('');

  const kpi = (label, val, bg) =>
    '<td width="100" style="background:' + bg + ';color:#ffffff;font-weight:bold;text-align:center;border:1px solid #cbd5e1;padding:5px;font-size:10pt;">' + label + ': ' + val + '</td>';

  const html =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    '<head><meta charset="UTF-8">' +
    '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>' +
    '<x:Name>Sorting Report</x:Name><x:WorksheetOptions><x:FitToPage/><x:PrintTitles>' +
    '<x:Titles>$6:$6</x:Titles></x:PrintTitles></x:WorksheetOptions>' +
    '</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>' +
    '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;table-layout:fixed;width:840px;">' +
    '<tr><td colspan="7" style="background:#0f172a;color:#ffffff;font-weight:bold;font-size:14pt;padding:10px;">SMART FACTORY AI — SORTING REPORT</td></tr>' +
    '<tr><td colspan="7" style="color:#64748b;font-size:9pt;padding:4px 10px;">Closed-Loop QC • Diekspor: ' + escHtml(dateStr) + '</td></tr>' +
    '<tr>' + kpi('Total', s.total, '#1e293b') + kpi('Success', s.success + ' (' + s.successRate + ')', '#059669') +
    kpi('Error', s.errorRate, '#dc2626') + kpi('Biru', s.biru, '#0466c8') + kpi('Kuning', s.kuning, '#e6d400') +
    kpi('Silver', s.silver, '#ced4da') + kpi('Servo', s.servo, '#2563eb') + kpi('Recovery', s.recovery, '#5a189a') + '</tr>' +
    '<tr><td colspan="7" style="height:8px;"></td></tr>' +
    '<tr style="background:#1e293b;color:#ffffff;font-weight:bold;font-size:10pt;text-align:center;">' +
    '<th style="border:1px solid #1e293b;padding:6px;">Waktu</th><th style="border:1px solid #1e293b;padding:6px;">ID Barang</th>' +
    '<th style="border:1px solid #1e293b;padding:6px;">Kelas AI</th><th style="border:1px solid #1e293b;padding:6px;">Conf.</th>' +
    '<th style="border:1px solid #1e293b;padding:6px;">Mode</th><th style="border:1px solid #1e293b;padding:6px;">Aksi Hardware</th>' +
    '<th style="border:1px solid #1e293b;padding:6px;">Status QC</th></tr>' + trs + '</table></body></html>';

  downloadBlob(new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' }), 'Sorting_Report_' + fileDate + '.xls');
}

/* ----- Export Docs (.doc rapi untuk Word / Google Docs) -----
   Catatan: Word tidak mendukung flex/grid — layout murni tabel
   dengan lebar kolom fix + @page landscape + font Calibri. */
function exportSortingDocs() {
  const s = exportSummary();
  const rows = exportRows();
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fileDate = now.toISOString().slice(0, 10);

  const cell = 'border:1px solid #cbd5e1;padding:5pt;font-size:9pt;vertical-align:top;';
  const trs = rows.map((r, i) => {
    const bg = EXPORT_COLOR_BG[r.color] || '#64748b';
    const fg = r.color === 'kuning' || r.color === 'silver' ? '#1e293b' : '#ffffff';
    const sbg = EXPORT_STATUS_BG[r.status] || '#f77f00';
    const sfg = r.status === 'Pending' ? '#1e293b' : '#ffffff';
    const zebra = i % 2 ? 'background:#f1f5f9;' : 'background:#ffffff;';
    return '<tr>' +
      '<td width="75" style="' + zebra + cell + 'text-align:center;white-space:nowrap;">' + escHtml(r.waktu) + '</td>' +
      '<td width="80" style="' + zebra + cell + 'white-space:nowrap;">' + escHtml(r.id) + '</td>' +
      '<td width="65" style="background:' + bg + ';color:' + fg + ';font-weight:bold;text-align:center;' + cell + '">' + escHtml(r.kelas) + '</td>' +
      '<td width="50" style="' + zebra + cell + 'text-align:center;white-space:nowrap;">' + escHtml(r.conf) + '</td>' +
      '<td width="140" style="' + zebra + cell + '">' + escHtml(r.mode) + '</td>' +
      '<td width="175" style="' + zebra + cell + '">' + escHtml(r.aksi) + '</td>' +
      '<td width="75" style="background:' + sbg + ';color:' + sfg + ';font-weight:bold;text-align:center;' + cell + 'white-space:nowrap;">' + escHtml(r.status) + '</td>' +
      '</tr>';
  }).join('');

  const kpiCell = (label, val, bg) =>
    '<td width="94" bgcolor="' + bg + '" style="background:' + bg + ';color:#ffffff;font-weight:bold;text-align:center;border:1px solid #ffffff;padding:6pt;font-size:9pt;">' +
    escHtml(label) + '<br><span style="font-size:13pt;">' + escHtml(String(val)) + '</span></td>';

  const html =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
    '<head><meta charset="UTF-8"><title>Sorting Report</title>' +
    '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>' +
    '<w:Orientation>landscape</w:Orientation><w:Zoom>90</w:Zoom>' +
    '<w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->' +
    '<style>' +
    '@page WordSection1{size:11.0in 8.5in;mso-page-orientation:landscape;margin:0.5in 0.5in 0.5in 0.5in;}' +
    'div.WordSection1{page:WordSection1;}' +
    'body{font-family:Calibri,Arial,sans-serif;color:#0f172a;}' +
    'table{border-collapse:collapse;table-layout:fixed;}' +
    '</style></head>' +
    '<body><div class="WordSection1">' +
    // Kop: tabel 2 kolom (judul kiri, tanggal kanan)
    '<table width="660" cellspacing="0" cellpadding="0" style="width:660px;">' +
    '<tr><td width="460" bgcolor="#0f172a" style="background:#0f172a;color:#ffffff;padding:12pt;">' +
    '<span style="font-size:18pt;font-weight:bold;">Smart Factory AI</span><br>' +
    '<span style="font-size:10pt;color:#93c5fd;">Sorting Report • Closed-Loop QC</span></td>' +
    '<td width="200" bgcolor="#0f172a" style="background:#0f172a;color:#cbd5e1;padding:12pt;text-align:right;font-size:9pt;">' +
    'Diekspor<br><b>' + escHtml(dateStr) + '</b></td></tr></table>' +
    '<p style="font-size:4pt;">&nbsp;</p>' +
    // Ringkasan KPI
    '<table width="660" cellspacing="0" cellpadding="0" style="width:660px;">' +
    '<tr>' +
    kpiCell('TOTAL', s.total, '#1e293b') +
    kpiCell('SUCCESS ' + s.successRate, s.success, '#059669') +
    kpiCell('ERROR', s.errorRate, '#dc2626') +
    kpiCell('SERVO', s.servo, '#2563eb') +
    kpiCell('RECOVERY', s.recovery, '#5a189a') +
    kpiCell('BIRU', s.biru, '#0466c8') +
    kpiCell('KUNING', s.kuning, '#e6d400') +
    kpiCell('SILVER', s.silver, '#ced4da') +
    '</tr></table>' +
    '<p style="font-size:6pt;">&nbsp;</p>' +
    // Tabel data
    '<table width="660" cellspacing="0" cellpadding="0" style="width:660px;">' +
    '<tr style="background:#1e293b;color:#ffffff;font-size:9pt;font-weight:bold;text-align:center;">' +
    '<th width="75" style="border:1px solid #1e293b;padding:5pt;">Waktu</th>' +
    '<th width="80" style="border:1px solid #1e293b;padding:5pt;">ID Barang</th>' +
    '<th width="65" style="border:1px solid #1e293b;padding:5pt;">Kelas AI</th>' +
    '<th width="50" style="border:1px solid #1e293b;padding:5pt;">Conf.</th>' +
    '<th width="140" style="border:1px solid #1e293b;padding:5pt;">Mode</th>' +
    '<th width="175" style="border:1px solid #1e293b;padding:5pt;">Aksi Hardware</th>' +
    '<th width="75" style="border:1px solid #1e293b;padding:5pt;">Status QC</th>' +
    '</tr>' + trs + '</table>' +
    '<p style="color:#64748b;font-size:8pt;">Smart Factory AI © 2026 • ' + rows.length + ' transaksi • Diekspor ' + escHtml(dateStr) + '</p>' +
    '</div></body></html>';

  downloadBlob(new Blob(['\ufeff' + html], { type: 'application/msword;charset=utf-8;' }), 'Sorting_Report_' + fileDate + '.doc');
}

function pdfColor(hex) {
  const h = String(hex || '#94a3b8').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function exportSortingPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('Library PDF belum termuat (cek koneksi internet)');
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fileDate = now.toISOString().slice(0, 10);

  const total = stats.total || transactions.length;
  const success = stats.success || 0;
  const miss = stats.miss || 0;
  const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
  const errorRate = total > 0 ? Math.round((miss / total) * 100) : 0;

  const countBy = (c) => transactions.filter((t) => t.color === c).length;

  /* ----- Header bar ----- */
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageW, 30, 'F');
  doc.setFillColor(59, 130, 246);
  doc.rect(0, 30, pageW, 1.5, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Smart Factory AI', 14, 12);
  doc.setFontSize(11);
  doc.setTextColor(147, 197, 253);
  doc.text('Sorting Report  •  Closed-Loop QC  •  ' + dateStr + ' ' + timeStr, 14, 20);

  doc.setFontSize(10);
  doc.setTextColor(203, 213, 225);
  doc.text('Total: ' + total + ' barang', pageW - 14, 12, { align: 'right' });
  doc.setTextColor(110, 231, 183);
  doc.text('Success Rate: ' + successRate + '%', pageW - 14, 20, { align: 'right' });

  /* ----- Ringkasan kotak ----- */
  const summary = [
    { label: 'TOTAL DIPROSES', value: String(total), bg: '#1e293b', fg: '#ffffff' },
    { label: 'SUCCESS', value: String(success), bg: '#059669', fg: '#ffffff' },
    { label: 'ERROR RATE', value: errorRate + '%', bg: '#dc2626', fg: '#ffffff' },
    { label: 'SERVO', value: String((stats.servo && stats.servo.total) || 0), bg: '#2563eb', fg: '#ffffff' },
    { label: 'RECOVERY', value: String((stats.recovery && stats.recovery.total) || 0), bg: '#7c3aed', fg: '#ffffff' }
  ];
  let sx = 14;
  const sw = (pageW - 28 - (summary.length - 1) * 4) / summary.length;
  summary.forEach((s) => {
    doc.setFillColor(...pdfColor(s.bg));
    doc.roundedRect(sx, 36, sw, 18, 2, 2, 'F');
    doc.setTextColor(...pdfColor(s.fg));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(s.value, sx + sw / 2, 44, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(s.label, sx + sw / 2, 49.5, { align: 'center' });
    sx += sw + 4;
  });

  /* ----- Distribusi warna ----- */
  const dist = [
    { label: 'Biru (Bin B)', count: countBy('biru'), bg: '#0466c8', fg: '#ffffff' },
    { label: 'Kuning (Bin A)', count: countBy('kuning'), bg: '#ffee32', fg: '#1e293b' },
    { label: 'Silver (Pass)', count: countBy('silver'), bg: '#e9ecef', fg: '#1e293b' }
  ];
  let dx = 14;
  const dw = (pageW - 28 - (dist.length - 1) * 4) / dist.length;
  dist.forEach((d) => {
    doc.setFillColor(...pdfColor(d.bg));
    doc.roundedRect(dx, 57, dw, 12, 2, 2, 'F');
    doc.setTextColor(...pdfColor(d.fg));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(d.label + ' : ' + d.count, dx + dw / 2, 64.5, { align: 'center' });
    dx += dw + 4;
  });

  /* ----- Tabel ----- */
  const head = [['Waktu', 'ID Barang', 'Kelas AI', 'Conf.', 'Mode', 'Aksi Hardware', 'Status QC']];
  const body = transactions.slice(0, 500).map((t) => [
    fmtTime(t.timestamp),
    t.id || '-',
    t.colorLabel || (t.color ? t.color.charAt(0).toUpperCase() + t.color.slice(1) : '-'),
    (t.confidence != null ? t.confidence + '%' : '-'),
    t.modeName || MODE_NAMES[t.mode] || t.mode || '-',
    t.action || t.destination || '-',
    t.result || 'Pending'
  ]);

  const COLOR_FILL = {
    biru: '#0466c8', kuning: '#ffee32', silver: '#e9ecef'
  };

  doc.autoTable({
    head,
    body,
    startY: 73,
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 2.2, textColor: [15, 23, 42] },
    headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
    alternateRowStyles: { fillColor: [241, 245, 249] },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 28 },
      2: { cellWidth: 30, halign: 'center', fontStyle: 'bold' },
      3: { cellWidth: 18, halign: 'center' },
      4: { cellWidth: 48 },
      5: { cellWidth: 'auto' },
      6: { cellWidth: 30, halign: 'center', fontStyle: 'bold' }
    },
    didParseCell(data) {
      if (data.section !== 'body') return;
      const tx = transactions.slice(0, 500)[data.row.index];
      if (!tx) return;
      // Kolom Kelas AI (index 2) — background sesuai warna barang
      if (data.column.index === 2) {
        const fill = COLOR_FILL[tx.color] || '#64748b';
        data.cell.styles.fillColor = pdfColor(fill);
        data.cell.styles.textColor = tx.color === 'kuning' ? [30, 41, 59] : [255, 255, 255];
      }
      // Kolom Status QC (index 6) — hijau/kuning/merah
      if (data.column.index === 6) {
        if (tx.result === 'Success') {
          data.cell.styles.fillColor = [16, 185, 129];
          data.cell.styles.textColor = [255, 255, 255];
        } else if (tx.result === 'Miss-sort') {
          data.cell.styles.fillColor = [248, 113, 113];
          data.cell.styles.textColor = [255, 255, 255];
        } else {
          data.cell.styles.fillColor = [250, 204, 21];
          data.cell.styles.textColor = [30, 41, 59];
        }
      }
    },
    didDrawPage() {
      const pages = doc.internal.getNumberOfPages();
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text(
        'Smart Factory AI © 2026  •  Diekspor ' + dateStr + ' ' + timeStr,
        14,
        pageH - 8
      );
      doc.text('Halaman ' + pages, pageW - 14, pageH - 8, { align: 'right' });
    }
  });

  doc.save('Sorting_Report_' + fileDate + '.pdf');
}

/* ---------- Reset DB lokal ---------- */
(function initClear() {
  const btn = document.getElementById('btnClearDb');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!confirm('Hapus seluruh riwayat transaksi lokal?')) return;
    transactions.length = 0;
    try { localStorage.removeItem('sfai_tx'); } catch {}
    refreshLogTable();
    recalcStats();
    showToast('Database lokal dibersihkan', 'success');
  });
})();

/* ---------- Modal Bug ---------- */
(function initModal() {
  const modal = document.getElementById('bugModal');
  const openBtn = document.getElementById('reportBtn');
  if (!modal || !openBtn) return;
  const close = () => modal.classList.add('hidden');
  openBtn.addEventListener('click', () => modal.classList.remove('hidden'));
  document.getElementById('bugClose').addEventListener('click', close);
  document.getElementById('bugCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('bugForm').addEventListener('submit', (e) => {
    e.preventDefault();
    close();
    e.target.reset();
    showToast('Laporan bug terkirim', 'success');
  });
})();

/* ---------- Logout admin → kembali ke gerbang ---------- */
(function initLogout() {
  const btn = document.getElementById('menuLogoutBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    try { sessionStorage.removeItem('sfai_admin'); } catch {}
    showToast('Keluar dari mode admin', 'info');
    setTimeout(() => { window.location.href = 'index.html'; }, 600);
  });
})();

/* ---------- Topmenu dock macOS (navigasi + magnify + bounce) ---------- */
(function initTopmenu() {
  const menu = document.getElementById('topmenu');
  if (!menu) return;
  // Hanya item navigasi (tombol aksi keluar dikecualikan)
  const items = Array.from(menu.querySelectorAll(':scope > .topmenu__item[data-target]'));
  let activeItem = menu.querySelector(':scope > .topmenu__item[data-target].active') || items[0];
  let spyLock = false;
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setActive(item, scroll) {
    if (!item) return;
    if (item === activeItem) {
      if (scroll) scrollToTarget(item);
      return;
    }
    if (activeItem) activeItem.classList.remove('active');
    item.classList.add('active');
    activeItem = item;
    if (scroll) scrollToTarget(item);
  }

  function scrollToTarget(item) {
    const target = document.getElementById(item.dataset.target);
    if (!target) return;
    spyLock = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => { spyLock = false; }, 950);
  }

  function bounce(item) {
    if (reducedMotion) return;
    const ic = item.querySelector('.icon');
    if (!ic) return;
    ic.classList.remove('dock-bounce');
    void ic.offsetWidth;
    ic.classList.add('dock-bounce');
  }

  items.forEach((item) => {
    item.addEventListener('click', () => {
      bounce(item);
      setActive(item, true);
    });
  });

  // Magnify ala dock: ikon membesar mengikuti jarak kursor
  if (!reducedMotion && window.matchMedia('(hover: hover)').matches) {
    const RANGE = 130;
    const GROW = 0.65;
    const MAX_SCALE = 1.8;
    
    menu.addEventListener('mousemove', (e) => {
      const menuRect = menu.getBoundingClientRect();
      const mouseX = e.clientX - menuRect.left;
      
      items.forEach((item) => {
        const r = item.getBoundingClientRect();
        const itemCenterX = r.left + r.width / 2 - menuRect.left;
        const dist = Math.abs(mouseX - itemCenterX);
        const s = dist < RANGE ? 1 + GROW * (1 - dist / RANGE) : 1;
        const clampedScale = Math.min(s, MAX_SCALE);
        const ic = item.querySelector('.icon');
        if (ic) ic.style.setProperty('--mag', clampedScale.toFixed(3));
      });
    });
    
    menu.addEventListener('mouseleave', () => {
      items.forEach((item) => {
        const ic = item.querySelector('.icon');
        if (ic) ic.style.setProperty('--mag', 1);
      });
    });
  }

  // Scrollspy ringan: titik aktif mengikuti section yang terlihat
  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      if (spyLock) return;
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const item = items.find((i) => i.dataset.target === en.target.id);
          if (item && item !== activeItem) {
            if (activeItem) activeItem.classList.remove('active');
            item.classList.add('active');
            activeItem = item;
          }
        }
      });
    }, { rootMargin: '-35% 0px -55% 0px' });
    items.forEach((item) => {
      const sec = document.getElementById(item.dataset.target);
      if (sec) spy.observe(sec);
    });
  }
})();

/* ---------- CSS tambahan untuk tabel (badge & chip) ---------- */
(function injectTableCss() {
  const css = '.tx-id{font-size:.76rem;color:#93c5fd}.tx-conf{font-variant-numeric:tabular-nums}' +
    '.tx-action{font-size:.76rem;color:var(--text-secondary)}' +
    '.status-badge{display:inline-block;font-size:.68rem;font-weight:700;padding:3px 11px;border-radius:999px}' +
    '.badge-ok{background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.35)}' +
    '.badge-pending{background:rgba(250,204,21,.15);color:#fde047;border:1px solid rgba(250,204,21,.35)}' +
    '.badge-err{background:rgba(248,113,113,.15);color:#fca5a5;border:1px solid rgba(248,113,113,.35)}';
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
})();
