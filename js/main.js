/**
 * main.js – appens "hjerne": styrer brugerfladen.
 *
 *   billede ind  →  AI (ai-worker.js)  →  3D-form (mesh.js)  →  visning (viewer.js)  →  download (export.js)
 */
import { Viewer } from './viewer.js';
import { buildMeshData } from './mesh.js';
import { exportGLB, exportSTL, downloadBlob } from './export.js';
import { openWebcam } from './camera.js';

const MAX_IMAGE_SIZE = 1024; // større billeder skaleres ned – det er rigeligt til 3D og meget hurtigere
const THUMB_SIZE = 200;

const $ = (sel) => document.querySelector(sel);
const ui = {
  start: $('#start'),
  busy: $('#busy'),
  busyTitle: $('#busy-title'),
  busyText: $('#busy-text'),
  progressList: $('#progress-list'),
  panel: $('#panel'),
  toast: $('#toast'),
  dropHint: $('#drop-hint'),
  viewerHint: $('#viewer-hint'),
  stats: $('#stats'),
  modeHelp: $('#mode-help'),
  btnCamera: $('#btn-camera'),
  btnPick: $('#btn-pick'),
  btnNew: $('#btn-new'),
  btnBack: $('#btn-back'),
  btnInstall: $('#btn-install'),
  iosHint: $('#ios-hint'),
  fileCamera: $('#file-camera'),
  filePick: $('#file-pick'),
  thumbPhoto: $('#thumb-photo'),
  thumbMask: $('#thumb-mask'),
  thumbDepth: $('#thumb-depth'),
  optBg: $('#opt-bg'),
  optWire: $('#opt-wire'),
  optRotate: $('#opt-rotate'),
  dlGlb: $('#dl-glb'),
  dlStl: $('#dl-stl'),
};
const sliders = {
  depth: { input: $('#opt-depth'), out: $('#val-depth'), format: (v) => `${v} %` },
  thick: { input: $('#opt-thick'), out: $('#val-thick'), format: (v) => `${v} %` },
  smooth: { input: $('#opt-smooth'), out: $('#val-smooth'), format: (v) => `${v}` },
  res: { input: $('#opt-res'), out: $('#val-res'), format: (v) => `${v}` },
};
const MODE_HELP = {
  figure: 'Motivet pustes op med en afrundet bagside – godt til ting, dyr og personer.',
  relief: 'Billedet bliver en plade med relief og flad bagside – godt til 3D-print og landskaber.',
};

export const state = {
  photo: null, // { canvas, width, height }
  depth: null, // Float32Array – højere tal = tættere på kameraet
  mask: null, // Uint8Array – 255 = motiv, 0 = baggrund
  bledTexture: null, // fotoet hvor motivets farver er "smurt" ud over kanten (se makeBledTexture)
  device: null, // 'webgpu' eller 'wasm'
  mode: 'figure',
  busy: false,
};
export const viewer = new Viewer($('#viewer'));

/* ------------------------------------------------------------------ */
/* AI-worker (kører i baggrunden)                                      */
/* ------------------------------------------------------------------ */

const worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
const jobs = new Map();
let jobCounter = 0;

worker.addEventListener('message', ({ data: msg }) => {
  if (msg.type === 'progress') return showDownloadProgress(msg);
  if (msg.type === 'status') return setBusyTitle(msg.text);
  const job = jobs.get(msg.id);
  if (!job) return;
  jobs.delete(msg.id);
  if (msg.type === 'result') job.resolve(msg);
  else job.reject(new Error(msg.message));
});
worker.addEventListener('error', (e) => {
  console.error('AI-worker fejl', e);
  for (const job of jobs.values()) {
    job.reject(new Error('AI-delen kunne ikke starte. Tjek din internetforbindelse og genindlæs siden.'));
  }
  jobs.clear();
});

function askWorker(message, transfer = []) {
  const id = ++jobCounter;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage({ ...message, id }, transfer);
  });
}

/* ------------------------------------------------------------------ */
/* Billede ind                                                         */
/* ------------------------------------------------------------------ */

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Reserve-metode til ældre browsere
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function handleFile(file) {
  if (!file || state.busy) return;
  hideToast();

  let img;
  try {
    img = await decodeImage(file);
  } catch {
    showToast('Kunne ikke læse billedet. Prøv et JPG- eller PNG-billede.');
    return;
  }

  // Skalér ned og tegn på et canvas
  const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(img.width, img.height));
  const width = Math.max(8, Math.round(img.width * scale));
  const height = Math.max(8, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  img.close?.();

  state.photo = { canvas, width, height };
  state.depth = null;
  state.mask = null;
  state.bledTexture = null;
  drawThumb(ui.thumbPhoto, canvas);

  await analyze({ depth: true, background: ui.optBg.checked });
}

/** Send billedet til AI'en og byg modellen bagefter. */
async function analyze(tasks) {
  state.busy = true;
  showBusy(tasks.depth ? 'Analyserer billedet …' : 'Finder motivet …');
  const { canvas, width, height } = state.photo;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;

  try {
    const res = await askWorker({ type: 'analyze', image: { data: pixels, width, height }, tasks }, [pixels.buffer]);
    if (res.depth) state.depth = res.depth;
    state.device = res.device;

    setBusyTitle('Bygger 3D-model …');
    await nextPaint();
    if (res.mask) {
      state.mask = res.mask;
      state.bledTexture = makeBledTexture(state.photo, state.mask);
    }
    drawMaskThumb();
    drawDepthThumb();
    showModelUI();
    rebuild({ reframe: Boolean(tasks.depth) });
  } catch (err) {
    console.error(err);
    showToast(`Der skete en fejl: ${err.message}`);
    if (!state.depth) showStart();
  } finally {
    state.busy = false;
    hideBusy();
  }
}

/* ------------------------------------------------------------------ */
/* Byg 3D-modellen                                                     */
/* ------------------------------------------------------------------ */

function currentOptions() {
  return {
    mode: state.mode,
    depthAmount: sliders.depth.input.value / 100,
    thickness: sliders.thick.input.value / 100,
    smoothing: Number(sliders.smooth.input.value),
    resolution: Number(sliders.res.input.value),
  };
}

export function rebuild({ reframe = false } = {}) {
  if (!state.photo || !state.depth) return;
  const { width, height } = state.photo;
  const useMask = ui.optBg.checked && state.mask;
  const input = { width, height, depth: state.depth, mask: useMask ? state.mask : null, ...currentOptions() };

  let data;
  let masked = Boolean(input.mask);
  try {
    data = buildMeshData(input);
  } catch (err) {
    if (err.code !== 'NO_SUBJECT') throw err;
    showToast('AI\'en kunne ikke finde et tydeligt motiv – viser hele billedet i stedet.', 'info');
    data = buildMeshData({ ...input, mask: null });
    masked = false;
  }
  setTexture(masked && state.bledTexture ? state.bledTexture : state.photo.canvas);
  viewer.setModel(data, { reframe });

  const where = state.device === 'webgpu' ? 'grafikkortet (WebGPU)' : 'processoren (WASM)';
  ui.stats.textContent = `${formatNumber(data.vertexCount)} punkter · ${formatNumber(data.triangleCount)} trekanter · AI kørte på ${where}`;
}

let currentTexture = null;
function setTexture(canvas) {
  if (canvas === currentTexture) return;
  currentTexture = canvas;
  viewer.setTexture(canvas);
}

/**
 * Laver en kopi af fotoet, hvor motivets farver "smøres" ud over kanten.
 * Ellers får siderne af 3D-modellen baggrundens farve (fx en lyserød sofa),
 * fordi pixels lige ved kanten er en blanding af motiv og baggrund.
 */
function makeBledTexture(photo, mask) {
  const { canvas, width: w, height: h } = photo;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  // 1) "Sikre" pixels: helt inde i motivet, et par pixels fra kanten
  let safe = new Uint8Array(w * h);
  for (let i = 0; i < safe.length; i++) safe[i] = mask[i] >= 230 ? 1 : 0;
  for (let k = 0; k < 3; k++) {
    const eroded = new Uint8Array(safe.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        eroded[i] = safe[i] & safe[i - 1] & safe[i + 1] & safe[i - w] & safe[i + w];
      }
    }
    safe = eroded;
  }

  // 2) Skub farverne udad – én ring af pixels ad gangen
  for (let pass = 0; pass < 16; pass++) {
    const next = safe.slice();
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (safe[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        const take = (j) => {
          r += px[j * 4];
          g += px[j * 4 + 1];
          b += px[j * 4 + 2];
          c++;
        };
        if (x > 0 && safe[i - 1]) take(i - 1);
        if (x < w - 1 && safe[i + 1]) take(i + 1);
        if (y > 0 && safe[i - w]) take(i - w);
        if (y < h - 1 && safe[i + w]) take(i + w);
        if (!c) continue;
        px[i * 4] = r / c;
        px[i * 4 + 1] = g / c;
        px[i * 4 + 2] = b / c;
        next[i] = 1;
        changed++;
      }
    }
    safe = next;
    if (!changed) break;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

let rebuildQueued = false;
function scheduleRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuild();
  });
}

function setMode(mode) {
  state.mode = mode;
  for (const btn of document.querySelectorAll('[data-mode]')) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  }
  ui.modeHelp.textContent = MODE_HELP[mode];
  scheduleRebuild();
}

/* ------------------------------------------------------------------ */
/* Små billeder (foto / motiv / dybde)                                 */
/* ------------------------------------------------------------------ */

function sizeThumb(canvas) {
  const { width, height } = state.photo;
  const s = THUMB_SIZE / Math.max(width, height);
  canvas.width = Math.max(1, Math.round(width * s));
  canvas.height = Math.max(1, Math.round(height * s));
  return canvas.getContext('2d');
}

function drawThumb(target, source) {
  sizeThumb(target).drawImage(source, 0, 0, target.width, target.height);
}

function drawMaskThumb() {
  const ctx = sizeThumb(ui.thumbMask);
  const { width: w, height: h } = ui.thumbMask;
  // Ternet baggrund (betyder "gennemsigtig")
  for (let y = 0; y < h; y += 10) {
    for (let x = 0; x < w; x += 10) {
      ctx.fillStyle = (x + y) % 20 === 0 ? '#2a3040' : '#1c212c';
      ctx.fillRect(x, y, 10, 10);
    }
  }
  if (!state.mask || !ui.optBg.checked) {
    ctx.drawImage(state.photo.canvas, 0, 0, w, h);
    return;
  }
  const { canvas, width, height } = state.photo;
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(canvas, 0, 0);
  const img = tctx.getImageData(0, 0, width, height);
  for (let i = 0; i < state.mask.length; i++) img.data[i * 4 + 3] = state.mask[i];
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0, w, h);
}

// Farveskala til dybdekortet: mørk lilla (langt væk) → gul (tæt på)
const DEPTH_COLORS = [
  [0, 0, 4],
  [87, 16, 110],
  [188, 55, 84],
  [249, 142, 9],
  [252, 255, 164],
];

function drawDepthThumb() {
  if (!state.depth) return;
  const { width, height } = state.photo;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of state.depth) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const span = hi - lo || 1;
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(width, height);
  for (let i = 0; i < state.depth.length; i++) {
    const t = ((state.depth[i] - lo) / span) * (DEPTH_COLORS.length - 1);
    const k = Math.min(DEPTH_COLORS.length - 2, Math.floor(t));
    const f = t - k;
    const a = DEPTH_COLORS[k];
    const b = DEPTH_COLORS[k + 1];
    img.data[i * 4] = a[0] + (b[0] - a[0]) * f;
    img.data[i * 4 + 1] = a[1] + (b[1] - a[1]) * f;
    img.data[i * 4 + 2] = a[2] + (b[2] - a[2]) * f;
    img.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  drawThumb(ui.thumbDepth, tmp);
}

/* ------------------------------------------------------------------ */
/* Skærme, beskeder og fremskridt                                      */
/* ------------------------------------------------------------------ */

const progressRows = new Map();

function showBusy(title) {
  ui.busyTitle.textContent = title;
  ui.busyText.textContent = '';
  ui.progressList.replaceChildren();
  progressRows.clear();
  ui.start.hidden = true;
  ui.busy.hidden = false;
}
function setBusyTitle(text) {
  ui.busyTitle.textContent = text;
}
function hideBusy() {
  ui.busy.hidden = true;
}

function showDownloadProgress({ key, label, progress, loaded, total }) {
  let row = progressRows.get(key);
  if (!row) {
    row = document.createElement('div');
    row.className = 'progress-item';
    row.innerHTML = '<div class="row"><span></span><span></span></div><div class="bar"><i></i></div>';
    ui.progressList.append(row);
    progressRows.set(key, row);
    ui.busyText.textContent = 'Første gang hentes AI-modellerne. Derefter husker browseren dem.';
  }
  const [name, amount] = row.querySelectorAll('.row span');
  name.textContent = label;
  amount.textContent = total ? `${toMB(loaded)} / ${toMB(total)} MB` : `${Math.round(progress)} %`;
  row.querySelector('i').style.width = `${Math.min(100, progress || 0).toFixed(1)}%`;
}

let toastTimer = 0;
function showToast(message, kind = 'error') {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${kind}`;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, kind === 'error' ? 10000 : 6000);
}
function hideToast() {
  ui.toast.hidden = true;
}

function showModelUI() {
  document.body.classList.add('has-model');
  ui.panel.hidden = false;
  ui.btnNew.hidden = false;
  ui.viewerHint.hidden = false;
  ui.start.hidden = true;
}
function showStart() {
  ui.start.hidden = false;
  ui.btnBack.hidden = !state.depth;
}

/* ------------------------------------------------------------------ */
/* Knapper og andre hændelser                                          */
/* ------------------------------------------------------------------ */

const isTouchDevice = matchMedia('(pointer: coarse)').matches;

async function takePhoto() {
  // Mobil: åbn telefonens kamera-app. Computer: brug webcam i en dialog.
  if (isTouchDevice || !navigator.mediaDevices?.getUserMedia) {
    ui.fileCamera.click();
    return;
  }
  try {
    const blob = await openWebcam();
    if (blob) handleFile(blob);
  } catch (err) {
    console.warn(err);
    showToast(webcamErrorText(err));
  }
}

function webcamErrorText(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Du har ikke givet adgang til kameraet. Tillad det i browseren – eller brug "Vælg billede".';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Der blev ikke fundet noget kamera. Brug "Vælg billede" i stedet.';
    case 'NotReadableError':
      return 'Kameraet bruges af et andet program. Luk det og prøv igen.';
    default:
      return `Kameraet kunne ikke åbnes: ${err?.message ?? err}`;
  }
}

// Når man trykker på en af knapperne, begynder AI-modellerne at blive indlæst,
// så de (måske) er klar, når billedet er valgt.
function preloadModels() {
  worker.postMessage({ type: 'preload', tasks: { depth: true, background: ui.optBg.checked } });
}

ui.btnCamera.addEventListener('click', () => {
  preloadModels();
  takePhoto();
});
ui.btnPick.addEventListener('click', () => {
  preloadModels();
  ui.filePick.click();
});
for (const input of [ui.fileCamera, ui.filePick]) {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = ''; // så man kan vælge samme fil igen
    handleFile(file);
  });
}
ui.btnNew.addEventListener('click', showStart);
ui.btnBack.addEventListener('click', () => (ui.start.hidden = true));

for (const btn of document.querySelectorAll('[data-mode]')) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
}

ui.optBg.addEventListener('change', async () => {
  setMode(ui.optBg.checked ? 'figure' : 'relief');
  drawMaskThumb();
  if (ui.optBg.checked && !state.mask && state.photo && !state.busy) {
    await analyze({ depth: false, background: true });
  }
});

// Telefoner: lidt færre punkter som standard, så skyderne føles hurtige
if (isTouchDevice) sliders.res.input.value = 192;

for (const s of Object.values(sliders)) {
  s.out.textContent = s.format(s.input.value);
  s.input.addEventListener('input', () => {
    s.out.textContent = s.format(s.input.value);
    scheduleRebuild();
  });
}

ui.optWire.addEventListener('change', () => viewer.setWireframe(ui.optWire.checked));
ui.optRotate.addEventListener('change', () => viewer.setAutoRotate(ui.optRotate.checked));
viewer.setAutoRotate(ui.optRotate.checked);

ui.dlGlb.addEventListener('click', () =>
  withButton(ui.dlGlb, async () => downloadBlob(await exportGLB(viewer.mesh), fileName('glb'))),
);
ui.dlStl.addEventListener('click', () =>
  withButton(ui.dlStl, async () => downloadBlob(exportSTL(viewer.mesh), fileName('stl'))),
);

async function withButton(button, fn) {
  button.disabled = true;
  try {
    await nextPaint();
    await fn();
  } catch (err) {
    console.error(err);
    showToast(`Kunne ikke gemme filen: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

// Træk-og-slip af billeder
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  ui.dropHint.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.dropHint.hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  ui.dropHint.hidden = true;
  const files = Array.from(e.dataTransfer.files);
  handleFile(files.find((f) => f.type.startsWith('image/')) ?? files[0]);
});

// Indsæt billede med Ctrl+V
window.addEventListener('paste', (e) => {
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  handleFile(item.getAsFile());
});

/* ------------------------------------------------------------------ */
/* Installation som app på telefonen (PWA)                             */
/* ------------------------------------------------------------------ */

// Service worker: gør appen installerbar og brugbar uden net.
// Kun på https (den rigtige adresse) – ikke under udvikling på localhost.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker fejlede', err));
}

const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Android/Chrome/Edge: browseren fortæller, når appen kan installeres
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  ui.btnInstall.hidden = false;
});
ui.btnInstall.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  ui.btnInstall.hidden = true;
});
window.addEventListener('appinstalled', () => {
  ui.btnInstall.hidden = true;
});

// iPhone/iPad: der er ingen installér-knap, så vi viser hvordan man gør
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !isStandalone) ui.iosHint.hidden = false;

/* ------------------------------------------------------------------ */
/* Småting                                                             */
/* ------------------------------------------------------------------ */

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
function toMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(0);
}
function formatNumber(n) {
  return n.toLocaleString('da-DK');
}
function fileName(ext) {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `foto-3d-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

setMode(state.mode);
