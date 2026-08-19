import { qrcode } from './vendor/qrcode.mjs';
import {
  buildDroplet,
  buildMeta,
  bytesToLatin1,
  dropletIndexes,
  DROPLET_OVERHEAD,
  formatBytes,
  formatDuration,
  b64,
} from './oqtp.js';
import { FountainEncoder } from './fountain-encoder.js';
import { hashBlob, SHA256 } from './sha256.js';

const $ = (id) => document.getElementById(id);

/* Rough factor between "frames a perfect receiver needs" and "frames a real
   one needs", measured on a simulated channel at ~15% loss. Used only for
   the time estimate shown before starting. */
const REALISM = 1.35;
const META_EVERY = 20;
const BIG_FILE = 64 * 1024 * 1024;

const state = {
  file: null,
  bytes: null, // what actually goes on the wire (ciphertext if encrypted)
  meta: null,
  encoder: null,
  tid: 0,
  seed: 0,
  frames: 0,
  running: false,
  paused: false,
  fps: 10,
  ecc: 'M',
  frameBytes: 300,
  startedAt: 0,
  pausedFor: 0,
  pauseStart: 0,
  lastFrameAt: 0,
  fpsEMA: 0,
  covered: null, // Uint8Array marking chunks put on screen this run
  coveredCount: 0,
  liveIdx: [],
  wakeLock: null,
  plainHash: null,
  hashing: false,
  plateModules: 0,
};

/* ─────────────────────────  chrome  ───────────────────────── */

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function show(stage) {
  for (const s of ['stage-pick', 'stage-ready', 'stage-send']) $(s).hidden = s !== stage;
}

/* ─────────────────────────  step 1  ───────────────────────── */

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) selectFile(e.target.files[0]);
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
  })
);
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) selectFile(f);
});

async function selectFile(file) {
  state.file = file;
  state.plainHash = null;
  $('r-name').textContent = file.name;
  $('r-size').textContent = formatBytes(file.size);
  $('r-type').textContent = file.type || 'unknown';
  $('r-hash').textContent = 'calculating…';
  show('stage-ready');
  refreshEstimate();

  if (file.size === 0) {
    warn('That file is empty, so there is nothing to transmit.');
    $('start').disabled = true;
    return;
  }
  $('start').disabled = false;
  warn(file.size > BIG_FILE ? `${formatBytes(file.size)} over a camera link will take hours. This works, but a cable or a network share will not.` : '');

  state.hashing = true;
  const hash = await hashBlob(file, (p) => {
    $('r-hash').textContent = `calculating… ${Math.round(p * 100)}%`;
  });
  state.hashing = false;
  state.plainHash = hash;
  $('r-hash').textContent = hash.slice(0, 16) + '…';
  $('r-hash').title = hash;
}

function warn(msg) {
  const el = $('ready-warn');
  el.textContent = msg;
  el.hidden = !msg;
}

/* ─────────────────────────  estimates  ───────────────────────── */

function readSettings() {
  state.frameBytes = parseInt($('s-density').value, 10);
  state.fps = parseInt($('s-fps').value, 10);
  state.ecc = $('s-ecc').value;
}

function chunkSize() {
  return state.frameBytes - DROPLET_OVERHEAD;
}

function refreshEstimate() {
  readSettings();
  if (!state.file) return;
  const encOverhead = $('s-encrypt').checked ? 16 : 0;
  const K = Math.max(1, Math.ceil((state.file.size + encOverhead) / chunkSize()));
  const clean = K + Math.ceil(K / META_EVERY);
  $('r-chunks').textContent = K.toLocaleString();
  $('r-frames').textContent = clean.toLocaleString();
  $('r-time').textContent =
    formatDuration((clean * REALISM) / state.fps) + ` at ${state.fps} fps`;
  $('o-fps').textContent = state.fps + ' fps';
}

['s-density', 's-ecc'].forEach((id) => $(id).addEventListener('change', refreshEstimate));
$('s-fps').addEventListener('input', refreshEstimate);
$('s-encrypt').addEventListener('change', (e) => {
  $('pw-wrap').hidden = !e.target.checked;
  refreshEstimate();
});
$('back').addEventListener('click', () => {
  state.file = null;
  $('file').value = '';
  show('stage-pick');
});

/* ─────────────────────────  encryption  ───────────────────────── */

async function encrypt(buffer, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { bytes: new Uint8Array(ct), salt, iv };
}

/* ─────────────────────────  start  ───────────────────────── */

$('start').addEventListener('click', async () => {
  if (!state.file) return;
  readSettings();

  if ($('s-encrypt').checked && !$('s-password').value) {
    toast('Type a password, or turn encryption off.');
    return;
  }
  if (state.hashing) {
    toast('Still fingerprinting the file — one moment.');
    return;
  }

  $('start').disabled = true;
  $('start').textContent = 'Preparing…';

  try {
    const raw = new Uint8Array(await state.file.arrayBuffer());
    let payload = raw;
    let encInfo = null;

    if ($('s-encrypt').checked) {
      const { bytes, salt, iv } = await encrypt(raw, $('s-password').value);
      payload = bytes;
      encInfo = { s: b64(salt), i: b64(iv), it: 250000 };
    }

    // Hash of exactly what the receiver will reconstruct.
    const streamHash = encInfo ? new SHA256().update(payload).hex() : state.plainHash;

    state.bytes = payload;
    state.encoder = new FountainEncoder(payload, chunkSize());
    state.tid = crypto.getRandomValues(new Uint16Array(1))[0];
    state.meta = {
      n: state.file.name,
      s: payload.length,
      m: state.file.type || 'application/octet-stream',
      k: state.encoder.K,
      c: chunkSize(),
      h: streamHash,
      ph: encInfo ? state.plainHash : undefined,
      e: encInfo || undefined,
    };

    state.covered = new Uint8Array(state.encoder.K);
    state.coveredCount = 0;
    state.seed = 0;
    state.frames = 0;
    state.startedAt = performance.now();
    state.pausedFor = 0;
    state.paused = false;
    state.running = true;

    measurePlate();

    $('b-name').textContent = state.file.name;
    show('stage-send');
    $('l-fps').value = state.fps;
    $('l-fps-out').textContent = state.fps + ' fps';
    sizeRibbon();
    requestWakeLock();
    requestAnimationFrame(loop);
    tickTelemetry();
  } catch (err) {
    console.error(err);
    toast('Could not read that file: ' + err.message, 5000);
  } finally {
    $('start').disabled = false;
    $('start').textContent = 'Start transmitting';
  }
});

/* ─────────────────────────  the frame loop  ───────────────────────── */

const canvas = $('qr');
const ctx = canvas.getContext('2d', { alpha: false });
let lastDegree = 1;

function nextPacket() {
  // A metadata frame every META_EVERY frames, so a receiver that joins late
  // (or looks away) learns the file's shape without restarting the sender.
  if (state.frames % META_EVERY === 0) {
    lastDegree = 0;
    state.liveIdx = [];
    return buildMeta(state.tid, state.meta);
  }
  const seed = state.seed++;
  const payload = state.encoder.droplet(seed);
  const idxs = dropletIndexes(seed, state.encoder.K, state.encoder.cdf);
  lastDegree = idxs.length;
  state.liveIdx = idxs;
  for (const i of idxs) {
    if (!state.covered[i]) {
      state.covered[i] = 1;
      state.coveredCount++;
    }
  }
  return buildDroplet(state.tid, seed, payload);
}

function drawFrame(packet) {
  const qr = qrcode(0, state.ecc);
  qr.addData(bytesToLatin1(packet), 'Byte');
  qr.make();

  const n = qr.getModuleCount();
  const quiet = 4;

  // The canvas is sized once, to the largest frame this transfer will ever
  // produce, and every code is centred inside it. If the canvas resized per
  // frame, CSS would scale each one differently and the module pitch would
  // jump every time a metadata frame came round — which makes a camera
  // hunt for focus twice a second. Constant pitch, no hunting.
  const total = Math.max(state.plateModules, n + quiet * 2);
  if (canvas.width !== total) {
    canvas.width = total;
    canvas.height = total;
  }
  const off = Math.floor((total - n) / 2);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(c + off, r + off, 1, 1);
    }
  }
  return n;
}

/** Measure the biggest code this transfer can generate, before starting. */
function measurePlate() {
  let max = 0;
  const probes = [buildMeta(state.tid, state.meta), buildDroplet(state.tid, 0, state.encoder.droplet(0))];
  for (const p of probes) {
    const qr = qrcode(0, state.ecc);
    qr.addData(bytesToLatin1(p), 'Byte');
    qr.make();
    max = Math.max(max, qr.getModuleCount() + 8);
  }
  state.plateModules = max;
}

function loop(now) {
  if (!state.running) return;
  requestAnimationFrame(loop);
  if (state.paused) return;

  const interval = 1000 / state.fps;
  if (state.lastFrameAt && now - state.lastFrameAt < interval - 1) return;

  if (state.lastFrameAt) {
    const inst = 1000 / (now - state.lastFrameAt);
    state.fpsEMA = state.fpsEMA ? state.fpsEMA * 0.85 + inst * 0.15 : inst;
  }
  state.lastFrameAt = now;

  try {
    const packet = nextPacket();
    const modules = drawFrame(packet);
    state.frames++;
    if (state.frames % 12 === 0) $('b-phase').textContent = phaseLabel(modules);
  } catch (err) {
    console.error(err);
    state.running = false;
    toast('Frame too large for one QR code. Pick a smaller "data per frame".', 6000);
  }
  drawRibbon();
}

function phaseLabel(modules) {
  const K = state.encoder.K;
  const version = (modules - 17) / 4;
  const phase = state.seed < K ? `first pass ${state.seed}/${K}` : 'repair stream';
  return `${phase} · QR v${version} · ${state.ecc}`;
}

/* ─────────────────────────  telemetry  ───────────────────────── */

function elapsed() {
  return (performance.now() - state.startedAt - state.pausedFor) / 1000;
}

function tickTelemetry() {
  if (!state.running) return;
  const K = state.encoder.K;
  $('t-frames').textContent = state.frames.toLocaleString();
  $('t-rate').textContent = state.fpsEMA ? state.fpsEMA.toFixed(1) + ' fps' : '—';
  $('t-tput').textContent = state.fpsEMA
    ? formatBytes(state.fpsEMA * chunkSize()) + '/s'
    : '—';
  $('t-elapsed').textContent = formatDuration(elapsed());
  $('t-cover').textContent = `${state.coveredCount.toLocaleString()} / ${K.toLocaleString()}`;
  $('t-degree').textContent =
    lastDegree === 0 ? 'file details' : lastDegree === 1 ? '1 chunk' : `${lastDegree} chunks blended`;
  setTimeout(tickTelemetry, 250);
}

/* ── the ribbon: one tick per chunk, the same shape on both devices ── */

const ribbon = $('ribbon');
const rctx = ribbon.getContext('2d');

function sizeRibbon() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ribbon.width = Math.max(1, Math.floor(ribbon.clientWidth * dpr));
  ribbon.height = Math.floor(30 * dpr);
  drawRibbon();
}
window.addEventListener('resize', sizeRibbon);

function drawRibbon() {
  if (!state.encoder) return;
  const K = state.encoder.K;
  const W = ribbon.width;
  const H = ribbon.height;
  rctx.clearRect(0, 0, W, H);
  const live = new Set(state.liveIdx);

  if (K <= W) {
    const w = W / K;
    for (let i = 0; i < K; i++) {
      if (live.has(i)) rctx.fillStyle = '#12161a';
      else if (state.covered[i]) rctx.fillStyle = '#1f3bd6';
      else continue;
      rctx.fillRect(i * w, 0, Math.max(1, w - (w > 3 ? 1 : 0)), H);
    }
  } else {
    const per = K / W;
    for (let x = 0; x < W; x++) {
      const from = Math.floor(x * per);
      const to = Math.min(K, Math.floor((x + 1) * per));
      let hit = 0;
      let isLive = false;
      for (let i = from; i < to; i++) {
        if (state.covered[i]) hit++;
        if (live.has(i)) isLive = true;
      }
      if (!hit && !isLive) continue;
      const f = hit / Math.max(1, to - from);
      rctx.fillStyle = isLive ? '#12161a' : `rgba(31,59,214,${0.25 + 0.75 * f})`;
      rctx.fillRect(x, 0, 1, H);
    }
  }
}

/* ─────────────────────────  controls  ───────────────────────── */

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? 'Resume' : 'Pause';
  if (state.paused) {
    state.pauseStart = performance.now();
    releaseWakeLock();
  } else {
    state.pausedFor += performance.now() - state.pauseStart;
    state.lastFrameAt = 0;
    requestWakeLock();
  }
});

$('restart').addEventListener('click', () => {
  state.seed = 0;
  state.frames = 0;
  state.covered.fill(0);
  state.coveredCount = 0;
  state.startedAt = performance.now();
  state.pausedFor = 0;
  toast('Back to the first chunk.');
});

$('stop').addEventListener('click', () => {
  state.running = false;
  releaseWakeLock();
  exitFull();
  show('stage-ready');
});

$('l-fps').addEventListener('input', (e) => {
  state.fps = parseInt(e.target.value, 10);
  $('l-fps-out').textContent = state.fps + ' fps';
  $('s-fps').value = state.fps;
});

$('fullscreen').addEventListener('click', async () => {
  if (document.fullscreenElement) {
    exitFull();
  } else {
    try {
      await document.documentElement.requestFullscreen();
    } catch (e) {
      /* some browsers refuse; the class still gives a clean plate */
    }
    document.body.classList.add('is-full');
  }
});

function exitFull() {
  document.body.classList.remove('is-full');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('is-full');
  sizeRibbon();
});

document.addEventListener('keydown', (e) => {
  if (!state.running) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('pause').click();
  } else if (e.key === 'f') {
    $('fullscreen').click();
  } else if (e.key === 'Escape' && document.body.classList.contains('is-full')) {
    exitFull();
  }
});

/* Keep the screen awake — a sleeping display ends the transfer. */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    /* not fatal */
  }
}
function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running && !state.paused) requestWakeLock();
});

/* ─────────────────────────  offline shell  ───────────────────────── */

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

refreshEstimate();
