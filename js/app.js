import { qrcode } from './vendor/qrcode.mjs';
import {
  buildDroplet,
  buildMeta,
  bytesToLatin1,
  dropletIndexes,
  DROPLET_OVERHEAD,
  META_HEADER,
  CRC_LEN,
  formatBytes,
  formatDuration,
  b64,
} from './oqtp.js';
import { FountainEncoder } from './fountain-encoder.js';
import { hashBlob, SHA256 } from './sha256.js';

const $ = (id) => document.getElementById(id);

const REALISM = 1.35; // frames a real receiver needs vs a perfect one
const META_EVERY = 20;
const BIG_FILE = 64 * 1024 * 1024;

/* Settings are expressed as the size of the code on screen, not as a byte
   count. Module count is the thing the camera has to resolve; bytes are
   whatever fits inside it, and leaving that slack unused is free throughput
   thrown away. A 69-module code at ECC M holds 331 bytes, so that is what a
   frame carries. */
const DEFAULTS = { fps: 10, modules: 69, ecc: 'M', encrypt: false };

const capCache = new Map();

/** Largest packet, in bytes, that still fits inside a given module count. */
function qrCapacity(modules, ecc) {
  const key = modules + ecc;
  if (capCache.has(key)) return capCache.get(key);
  const probe = new Uint8Array(3000).fill(65);
  const fits = (n) => {
    try {
      const qr = qrcode(0, ecc);
      qr.addData(bytesToLatin1(probe.subarray(0, n)), 'Byte');
      qr.make();
      return qr.getModuleCount() <= modules;
    } catch (e) {
      return false;
    }
  };
  let lo = 1;
  let hi = 2953;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  capCache.set(key, best);
  return best;
}

/* Every frame — droplet or metadata — is padded to exactly one frame length,
   so the code never changes size mid-transfer. If the metadata will not fit
   in the requested code, the code steps up a version rather than the
   metadata frame silently rendering bigger than the rest. */
function planFrames(metaProbe) {
  let modules = settings.modules;
  const needed = metaProbe ? META_HEADER + new TextEncoder().encode(JSON.stringify(metaProbe)).length + CRC_LEN : 0;
  let capacity = qrCapacity(modules, settings.ecc);
  while (needed > capacity && modules < 129) {
    modules += 4;
    capacity = qrCapacity(modules, settings.ecc);
  }
  return { modules, capacity, chunkSize: Math.max(1, capacity - DROPLET_OVERHEAD) };
}

/* Settings and transfer state are kept apart on purpose. Stopping a transfer
   clears the transfer; it must never leave a control showing one thing while
   the code believes another. */
const settings = { ...DEFAULTS };

const state = {
  file: null,
  bytes: null,
  meta: null,
  encoder: null,
  tid: 0,
  seed: 0,
  frames: 0,
  running: false,
  paused: false,
  startedAt: 0,
  pausedFor: 0,
  pauseStart: 0,
  lastFrameAt: 0,
  fpsEMA: 0,
  covered: null,
  coveredCount: 0,
  liveIdx: [],
  plateModules: 0,
  frameLen: 0,
  wakeLock: null,
  plainHash: null,
  hashing: false,
  bench: null,
  peakGoodput: 0,
};

/* ─────────────────────────  chrome  ───────────────────────── */

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const STEPS = ['pick', 'ready', 'send'];

function show(stage) {
  for (const s of STEPS) $('stage-' + s).hidden = s !== stage;
  const at = STEPS.indexOf(stage);
  document.querySelectorAll('.path__step').forEach((el, i) => {
    el.classList.toggle('is-current', i === at);
    el.classList.toggle('is-done', i < at);
  });
  document.body.classList.toggle('is-live', stage === 'send');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ── one source of truth for every control ── */

function syncSettingsUI() {
  $('s-fps').value = settings.fps;
  $('l-fps').value = settings.fps;
  $('o-fps').textContent = settings.fps;
  $('l-fps-out').textContent = settings.fps;
  $('s-density').value = String(settings.modules);
  $('s-ecc').value = settings.ecc;
  $('s-encrypt').checked = settings.encrypt;
  $('pw-wrap').hidden = !settings.encrypt;
  document.querySelectorAll('#fps-chips .chip').forEach((c) =>
    c.classList.toggle('is-on', Number(c.dataset.fps) === settings.fps)
  );
  const here = qrCapacity(settings.modules, settings.ecc);
  const alt = settings.ecc === 'L' ? null : qrCapacity(settings.modules, settings.ecc === 'Q' ? 'M' : 'L');
  $('ecc-hint').textContent = alt
    ? `The code stays the same size on screen either way — this only decides how much of it is data. ` +
      `Dropping a level would carry ${alt - here} more bytes a frame.`
    : 'The code stays the same size on screen either way — this only decides how much of it is data.';
  $('fps-hint').textContent =
    settings.fps > 60
      ? 'Above 60 needs a high-refresh screen on this side and a fast camera on the other. Watch the actual rate once running.'
      : settings.fps > 30
      ? 'Fast. Only worth it if the receiver reports a matching read rate.'
      : 'Faster is only faster if the camera keeps up. Start at 10.';
  refreshEstimate();
}

function setFps(v) {
  settings.fps = Math.max(2, Math.min(120, Math.round(Number(v) || DEFAULTS.fps)));
  syncSettingsUI();
}

$('s-fps').addEventListener('input', (e) => setFps(e.target.value));
$('l-fps').addEventListener('input', (e) => setFps(e.target.value));
$('fps-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) setFps(chip.dataset.fps);
});
$('s-density').addEventListener('change', (e) => {
  settings.modules = parseInt(e.target.value, 10);
  syncSettingsUI();
});
$('s-ecc').addEventListener('change', (e) => {
  settings.ecc = e.target.value;
  syncSettingsUI();
});
$('s-encrypt').addEventListener('change', (e) => {
  settings.encrypt = e.target.checked;
  syncSettingsUI();
});

function metaProbe() {
  // The real metadata, with placeholder values of the right shape, so the
  // plan accounts for the actual filename length.
  return {
    n: state.file ? state.file.name : '',
    s: state.file ? state.file.size : 0,
    m: (state.file && state.file.type) || 'application/octet-stream',
    k: 999999,
    c: 9999,
    h: '0'.repeat(64),
    ph: settings.encrypt ? '0'.repeat(64) : undefined,
    e: settings.encrypt ? { s: 'x'.repeat(24), i: 'x'.repeat(16), it: 250000 } : undefined,
  };
}

function plan() {
  return planFrames(metaProbe());
}

function chunkSize() {
  return plan().chunkSize;
}

function refreshEstimate() {
  const p = plan();
  $('density-hint').textContent =
    `A ${p.modules}×${p.modules} code carrying ${p.capacity} bytes a frame` +
    (p.modules !== settings.modules ? ' — stepped up so the file details fit in one frame.' : '.') +
    ' Smaller codes survive blur, distance and cheap cameras; error correction trades payload for robustness.';
  if (!state.file) return;
  const K = Math.max(1, Math.ceil((state.file.size + (settings.encrypt ? 16 : 0)) / p.chunkSize));
  const clean = K + Math.ceil(K / META_EVERY);
  $('r-chunks').textContent = K.toLocaleString();
  $('r-frames').textContent = clean.toLocaleString();
  $('r-time').textContent = formatDuration((clean * REALISM) / settings.fps) + ` at ${settings.fps} fps`;
  $('r-frame').textContent = `${p.chunkSize} B in a ${p.modules}² code`;
}

/* ────────────────  what this device can actually sustain  ────────────────

   The configured frame rate is a request, not a result. Two things cap the
   real one: how fast this screen refreshes, and how long a frame takes to
   encode and paint. Denser frames carry more but cost more to build, so the
   fastest setting and the fastest transfer are rarely the same thing — the
   number worth maximising is bytes per second, not frames per second.  */

const CODE_SIZES = [45, 57, 69, 81, 93, 105, 121];

function measureRefresh(frames = 32) {
  return new Promise((resolve) => {
    let n = 0;
    let t0 = 0;
    const step = (t) => {
      if (!t0) t0 = t;
      n++;
      if (n < frames) requestAnimationFrame(step);
      else resolve((1000 * (frames - 1)) / (t - t0));
    };
    requestAnimationFrame(step);
  });
}

const benchCanvas = document.createElement('canvas');
const benchCtx = benchCanvas.getContext('2d', { alpha: false });

/** Milliseconds to encode and paint one frame of a given size. */
function frameCost(frameBytes, ecc, reps = 14) {
  const payload = crypto.getRandomValues(new Uint8Array(Math.max(1, frameBytes - DROPLET_OVERHEAD)));
  const draw = (seed) => {
    const qr = qrcode(0, ecc);
    qr.addData(bytesToLatin1(buildDroplet(1, seed, payload)), 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const total = n + 8;
    if (benchCanvas.width !== total) {
      benchCanvas.width = total;
      benchCanvas.height = total;
    }
    benchCtx.fillStyle = '#fff';
    benchCtx.fillRect(0, 0, total, total);
    benchCtx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) benchCtx.fillRect(c + 4, r + 4, 1, 1);
    return n;
  };
  for (let i = 0; i < 3; i++) draw(i); // warm up the JIT
  const t0 = performance.now();
  let modules = 0;
  for (let i = 0; i < reps; i++) modules = draw(100 + i);
  return { ms: (performance.now() - t0) / reps, modules };
}

async function runBenchmark() {
  const btn = $('bench');
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  $('bench-out').hidden = false;
  $('bench-out').innerHTML = '<p class="fine">Timing this screen…</p>';
  await new Promise((r) => setTimeout(r, 30));

  const measured = await measureRefresh();
  // A backgrounded or throttled tab reports a refresh rate that is about the
  // tab, not the screen. Below 24 Hz the number is not believable, so fall
  // back to the common case and say so rather than recommending 6 fps.
  const throttled = measured < 24;
  const hz = throttled ? 60 : measured;
  const rows = [];
  for (const size of CODE_SIZES) {
    const bytes = qrCapacity(size, settings.ecc);
    if (!bytes) continue;
    const { ms, modules } = frameCost(bytes, settings.ecc);
    // 0.85 leaves the main thread room for the rest of the page; a rate you
    // cannot hold is worse than a slightly lower one you can.
    const paintCap = (1000 / ms) * 0.85;
    const fps = Math.max(2, Math.min(120, Math.floor(Math.min(hz, paintCap))));
    rows.push({ bytes, ms, modules, fps, goodput: fps * (bytes - DROPLET_OVERHEAD), capped: paintCap < hz });
    await new Promise((r) => setTimeout(r, 0));
  }

  const best = rows.reduce((a, b) => (b.goodput > a.goodput ? b : a));
  state.bench = { hz, rows, best };

  $('bench-out').innerHTML =
    `<p class="bench__hz">Screen refresh <b>${hz.toFixed(0)} Hz</b>${
      throttled ? ' (assumed — this tab looks throttled)' : ''
    } · ${best.capped ? 'building the codes is the limit' : 'the screen is the limit, not the encoder'}</p>` +
    rows
      .map(
        (r) =>
          `<div class="bench__row${r === best ? ' is-best' : ''}"><span>${r.modules}² code</span>` +
          `<span>${r.bytes} B</span><span>${r.ms.toFixed(1)} ms</span>` +
          `<span>${r.fps} fps</span><b>${formatBytes(r.goodput)}/s</b></div>`
      )
      .join('') +
    `<p class="fine">Highest sustainable rate on this screen: a <b>${best.modules}² code</b> at <b>${best.fps} fps</b>, ` +
    `about <b>${formatBytes(best.goodput)}/s</b>. This is a ceiling for this device only. Bigger codes carry more ` +
    `but are harder to read across the gap, so if the receiver's count stalls, step down one size — its read rate ` +
    `decides the real speed, not this measurement.</p>` +
    `<button type="button" class="btn btn--primary" id="bench-apply">Use a ${best.modules}² code at ${best.fps} fps</button>`;

  $('bench-apply').addEventListener('click', () => {
    settings.modules = best.modules;
    settings.fps = best.fps;
    syncSettingsUI();
    toast(`Set to a ${best.modules}² code at ${best.fps} fps — about ${formatBytes(best.goodput)}/s.`);
  });

  btn.disabled = false;
  btn.textContent = 'Measure again';
}

$('bench').addEventListener('click', runBenchmark);

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
  show('ready');
  syncSettingsUI();

  if (file.size === 0) {
    warn('That file is empty, so there is nothing to transmit.');
    $('start').disabled = true;
    return;
  }
  $('start').disabled = false;
  warn(
    file.size > BIG_FILE
      ? `${formatBytes(file.size)} over a camera link will take hours. It works, but a cable will not take hours.`
      : ''
  );

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

$('back').addEventListener('click', () => {
  state.file = null;
  state.plainHash = null;
  $('file').value = '';
  show('pick');
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

  if (settings.encrypt && !$('s-password').value) {
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

    if (settings.encrypt) {
      const { bytes, salt, iv } = await encrypt(raw, $('s-password').value);
      payload = bytes;
      encInfo = { s: b64(salt), i: b64(iv), it: 250000 };
    }

    const streamHash = encInfo ? new SHA256().update(payload).hex() : state.plainHash;

    const p = plan();
    state.frameLen = p.capacity;
    state.bytes = payload;
    state.encoder = new FountainEncoder(payload, p.chunkSize);
    state.tid = crypto.getRandomValues(new Uint16Array(1))[0];
    state.meta = {
      n: state.file.name,
      s: payload.length,
      m: state.file.type || 'application/octet-stream',
      k: state.encoder.K,
      c: p.chunkSize,
      h: streamHash,
      ph: encInfo ? state.plainHash : undefined,
      e: encInfo || undefined,
    };

    state.covered = new Uint8Array(state.encoder.K);
    state.coveredCount = 0;
    state.seed = 0;
    state.frames = 0;
    state.fpsEMA = 0;
    state.lastFrameAt = 0;
    state.startedAt = performance.now();
    state.pausedFor = 0;
    state.paused = false;
    state.running = true;
    state.peakGoodput = 0;

    measurePlate();
    $('b-name').textContent = state.file.name;
    $('pause').textContent = 'Pause';
    show('send');
    syncSettingsUI();
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
  if (state.frames % META_EVERY === 0) {
    lastDegree = 0;
    state.liveIdx = [];
    return buildMeta(state.tid, state.meta, state.frameLen);
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
  const qr = qrcode(0, settings.ecc);
  qr.addData(bytesToLatin1(packet), 'Byte');
  qr.make();

  const n = qr.getModuleCount();
  const quiet = 4;

  // Sized once to the largest frame this transfer can produce, with every
  // code centred inside it. If the canvas resized per frame, CSS would scale
  // each one differently and the module pitch would jump every time a
  // metadata frame came round, making the camera re-hunt for focus.
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

function measurePlate() {
  let max = 0;
  const probes = [
    buildMeta(state.tid, state.meta, state.frameLen),
    buildDroplet(state.tid, 0, state.encoder.droplet(0)),
  ];
  for (const p of probes) {
    const qr = qrcode(0, settings.ecc);
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

  const interval = 1000 / settings.fps;
  if (state.lastFrameAt && now - state.lastFrameAt < interval - 1) return;

  if (state.lastFrameAt) {
    const inst = 1000 / (now - state.lastFrameAt);
    state.fpsEMA = state.fpsEMA ? state.fpsEMA * 0.85 + inst * 0.15 : inst;
  }
  state.lastFrameAt = now;

  try {
    const modules = drawFrame(nextPacket());
    state.frames++;
    if (state.frames % 12 === 0) $('b-phase').textContent = phaseLabel(modules);
  } catch (err) {
    console.error(err);
    state.running = false;
    toast('Frame too large for one QR code. Pick a smaller "data per frame".', 6000);
  }
}

function phaseLabel(modules) {
  const K = state.encoder.K;
  const version = (modules - 17) / 4;
  const phase = state.seed < K ? `first pass ${state.seed}/${K}` : 'repair stream';
  return `${phase} · QR v${version} · ${settings.ecc}`;
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
  if (state.fpsEMA) {
    const goodput = state.fpsEMA * state.encoder.chunkSize;
    // ignore the first second, where the average has not settled
    if (elapsed() > 1.5 && goodput > state.peakGoodput) state.peakGoodput = goodput;
    $('t-tput').textContent = formatBytes(goodput) + '/s';
    $('t-peak').textContent = state.peakGoodput ? formatBytes(state.peakGoodput) + '/s' : '—';
  } else {
    $('t-tput').textContent = '—';
  }
  $('t-elapsed').textContent = formatDuration(elapsed());
  $('t-cover').textContent = `${state.coveredCount.toLocaleString()} / ${K.toLocaleString()}`;
  $('t-degree').textContent =
    lastDegree === 0 ? 'file details' : lastDegree === 1 ? '1 chunk' : `${lastDegree} chunks blended`;

  // If the screen cannot keep up with the asked-for rate, say so rather than
  // letting the number quietly lie.
  if (state.fpsEMA && settings.fps > 20 && state.fpsEMA < settings.fps * 0.8) {
    $('l-hint').textContent = `This screen is managing ${state.fpsEMA.toFixed(
      0
    )} fps, not ${settings.fps}. Lowering the setting will not slow it down.`;
  } else {
    $('l-hint').textContent = 'Receiver dropping frames? Slow down. Nothing is lost by going slower.';
  }
  drawRibbon(); // four times a second is plenty, and keeps the frame loop clear
  setTimeout(tickTelemetry, 250);
}

/* ── the ribbon: one tick per chunk, mirrored on the receiver ── */

const ribbon = $('ribbon');
const rctx = ribbon.getContext('2d');

function sizeRibbon() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = ribbon.clientWidth;
  if (!css) {
    // Measured while the panel was still hidden. Try again once laid out.
    requestAnimationFrame(() => {
      if (ribbon.clientWidth) sizeRibbon();
    });
    return;
  }
  ribbon.width = Math.max(1, Math.floor(css * dpr));
  ribbon.height = Math.floor(30 * dpr);
  drawRibbon();
}
window.addEventListener('resize', sizeRibbon);
window.addEventListener('orientationchange', () => setTimeout(sizeRibbon, 250));

/* One tick per chunk.

   Cell edges are snapped to whole pixels: at fractional positions, a few
   hundred chunks in a few hundred pixels half-cover each other and the strip
   comes out dim and patchy rather than solid. Coverage is expressed with
   globalAlpha against one fill colour instead of building an "rgba(...)"
   string per column, which was hundreds of allocations per redraw. */
function drawRibbon() {
  const W = ribbon.width;
  const H = ribbon.height;
  if (!W || !H) return;
  rctx.clearRect(0, 0, W, H);
  if (!state.encoder || !state.covered) return;

  const K = state.encoder.K;
  if (!K) return;
  const live = state.liveIdx.length ? new Set(state.liveIdx) : null;

  if (K <= W) {
    const gap = W / K >= 5 ? 1 : 0;
    for (let i = 0; i < K; i++) {
      const isLive = live && live.has(i);
      if (!isLive && !state.covered[i]) continue;
      rctx.fillStyle = isLive ? '#e8ecf6' : '#5b8cff';
      const x0 = Math.round((i * W) / K);
      const x1 = Math.round(((i + 1) * W) / K);
      rctx.fillRect(x0, 0, Math.max(1, x1 - x0 - gap), H);
    }
  } else {
    rctx.fillStyle = '#5b8cff';
    for (let x = 0; x < W; x++) {
      const from = Math.floor((x * K) / W);
      const to = Math.max(from + 1, Math.floor(((x + 1) * K) / W));
      let hit = 0;
      let isLive = false;
      for (let i = from; i < to; i++) {
        if (state.covered[i]) hit++;
        if (live && live.has(i)) isLive = true;
      }
      if (!hit && !isLive) continue;
      if (isLive) {
        rctx.globalAlpha = 1;
        rctx.fillStyle = '#e8ecf6';
      } else {
        rctx.globalAlpha = 0.4 + 0.6 * (hit / (to - from));
        rctx.fillStyle = '#5b8cff';
      }
      rctx.fillRect(x, 0, 1, H);
    }
    rctx.globalAlpha = 1;
  }
}

/* ─────────────────────────  controls  ───────────────────────── */

$('pause').addEventListener('click', () => {
  if (!state.running) return;
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
  if (!state.encoder) return;
  state.seed = 0;
  state.frames = 0;
  state.covered.fill(0);
  state.coveredCount = 0;
  state.liveIdx = [];
  state.startedAt = performance.now();
  state.pausedFor = 0;
  state.fpsEMA = 0;
  state.lastFrameAt = 0;
  drawRibbon();
  toast('Back to the first chunk.');
});

/* Stopping tears the transfer down completely and puts every control back in
   step with it — the settings the person chose are kept, because they chose
   them, but nothing is left showing a stale value. */
$('stop').addEventListener('click', stopTransfer);

function stopTransfer() {
  state.running = false;
  state.paused = false;
  state.encoder = null;
  state.bytes = null;
  state.meta = null;
  state.covered = null;
  state.coveredCount = 0;
  state.liveIdx = [];
  state.seed = 0;
  state.frames = 0;
  state.fpsEMA = 0;
  state.lastFrameAt = 0;
  state.pausedFor = 0;
  state.plateModules = 0;

  lastDegree = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawRibbon();

  $('pause').textContent = 'Pause';
  $('b-phase').textContent = '—';
  $('t-frames').textContent = '0';
  $('t-rate').textContent = '—';
  $('t-tput').textContent = '—';
  $('t-elapsed').textContent = '0s';
  $('t-cover').textContent = '0';
  $('t-degree').textContent = '—';
  $('t-peak').textContent = '—';
  state.peakGoodput = 0;

  releaseWakeLock();
  exitFull();
  show('ready');
  syncSettingsUI();
}

$('fullscreen').addEventListener('click', async () => {
  if (document.body.classList.contains('is-full')) {
    exitFull();
  } else {
    document.body.classList.add('is-full');
    try {
      await document.documentElement.requestFullscreen();
    } catch (e) {
      /* some browsers refuse; the class alone still gives a clean plate */
    }
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
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    $('pause').click();
  } else if (e.key === 'f') {
    $('fullscreen').click();
  } else if (e.key === 'Escape') {
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

/* ─────────────────────────  depth  ───────────────────────── */

const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Panels lean fractionally towards the pointer. Off during transmission,
// where the frame loop owns the main thread.
if (!calm && window.matchMedia('(pointer: fine)').matches) {
  let queued = false;
  window.addEventListener('pointermove', (e) => {
    if (queued || document.body.classList.contains('is-live')) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const rx = ((e.clientY - cy) / cy) * -2.2;
      const ry = ((e.clientX - cx) / cx) * 2.2;
      document.querySelectorAll('[data-tilt]').forEach((el) => {
        el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      });
    });
  });
}

const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }
  },
  { threshold: 0.18 }
);
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = i * 90 + 'ms';
  io.observe(el);
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

syncSettingsUI();
show('pick');

const cue = document.getElementById('cue');
if (cue) cue.addEventListener('click', () => document.getElementById('journey').scrollIntoView({ behavior: 'smooth', block: 'center' }));
