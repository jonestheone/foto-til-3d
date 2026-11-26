/**
 * main.js – appens "hjerne": styrer brugerfladen.
 *
 *   billede ind  →  AI (ai-worker.js)  →  3D-form (mesh.js)  →  visning (viewer.js)  →  download (export.js)
 */
import { Viewer } from './viewer.js';
import { buildMeshData } from './mesh.js';
import { exportGLB, exportSTL, downloadBlob } from './export.js';
import { openWebcam } from './camera.js';

const MAX_IMAGE_SIZE = 2048; // fotoet på modellen: op til 2048 px, så det er skarpt
const ANALYSIS_SIZE = 1024; // det AI'en ser: 1024 px er det, modellerne selv bruger
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
  optHd: $('#opt-hd'),
  optWire: $('#opt-wire'),
  optRotate: $('#opt-rotate'),
  dlGlb: $('#dl-glb'),
  dlStl: $('#dl-stl'),
};
const sliders = {
  depth: { input: $('#opt-depth'), out: $('#val-depth'), format: (v) => `${v} %` },
  thick: { input: $('#opt-thick'), out: $('#val-thick'), format: (v) => `${v} %` },
  detail: { input: $('#opt-detail'), out: $('#val-detail'), format: (v) => `${v} %` },
  smooth: { input: $('#opt-smooth'), out: $('#val-smooth'), format: (v) => `${v}` },
  res: { input: $('#opt-res'), out: $('#val-res'), format: (v) => `${v}` },
};
const MODE_HELP = {
  figure: 'Motivet pustes op med en afrundet bagside – godt til ting, dyr og personer.',
  relief: 'Billedet bliver en plade med relief og flad bagside – godt til 3D-print og landskaber.',
};

export const state = {
  photo: null, // { canvas, width, height } – op til 2048 px, bruges som overflade på modellen
  analysis: null, // { canvas, width, height } – op til 1024 px, det AI'en ser
  depth: null, // Float32Array i analyse-størrelse – højere tal = tættere på kameraet
  mask: null, // Uint8Array i analyse-størrelse – 255 = motiv, 0 = baggrund
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

  // To udgaver af billedet: et skarpt til modellens overflade og et mindre til AI'en
  // (AI-modellerne arbejder alligevel med ca. 1024 px, så det sparer tid og hukommelse)
  state.photo = drawScaled(img, MAX_IMAGE_SIZE);
  state.analysis = drawScaled(state.photo.canvas, ANALYSIS_SIZE);
  img.close?.();
  const { canvas } = state.photo;
  state.depth = null;
  state.mask = null;
  state.bledTexture = null;
  drawThumb(ui.thumbPhoto, canvas);

  await analyze({ depth: true, background: ui.optBg.checked }, { reframe: true });
}

/** Tegn et billede på et nyt canvas, så den længste side højst er maxSize. */
function drawScaled(source, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const width = Math.max(8, Math.round(source.width * scale));
  const height = Math.max(8, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return { canvas, width, height };
}

/** Send billedet til AI'en og byg modellen bagefter. */
async function analyze(tasks, { reframe = false } = {}) {
  state.busy = true;
  showBusy(tasks.depth && tasks.background ? 'Analyserer billedet …' : tasks.depth ? 'Beregner dybde …' : 'Finder motivet …');
  const { canvas, width, height } = state.analysis;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const detail = ui.optHd.checked ? 'high' : 'normal'; // "ekstra skarp dybde"

  try {
    const res = await askWorker({ type: 'analyze', image: { data: pixels, width, height }, tasks, detail }, [pixels.buffer]);
    if (res.depth) state.depth = res.depth;
    state.device = res.device;

    setBusyTitle('Bygger 3D-model …');
    await nextPaint();
    if (res.mask) {
      state.mask = res.mask;
      state.bledTexture = makeBledTexture(state.photo, scaleMask(state.mask, state.analysis, state.photo));
    }
    drawMaskThumb();
    drawDepthThumb();
    showModelUI();
    rebuild({ reframe });
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
    detailBoost: sliders.detail.input.value / 100,
    smoothing: Number(sliders.smooth.input.value),
    resolution: Number(sliders.res.input.value),
  };
}

export function rebuild({ reframe = false } = {}) {
  if (!state.photo || !state.depth) return;
  const { width, height } = state.analysis; // dybde og maske har AI'ens størrelse
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

/** Skalér masken fra AI'ens størrelse op til fotoets størrelse (blødt, via et canvas). */
function scaleMask(mask, from, to) {
  if (from.width === to.width && from.height === to.height) return mask;
  const src = document.createElement('canvas');
  src.width = from.width;
  src.height = from.height;
  const img = new ImageData(from.width, from.height);
  for (let i = 0; i < mask.length; i++) {
    img.data[i * 4] = mask[i];
    img.data[i * 4 + 3] = 255;
  }
  src.getContext('2d').putImageData(img, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = to.width;
  dst.height = to.height;
  const ctx = dst.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, to.width, to.height);
  const big = ctx.getImageData(0, 0, to.width, to.height).data;
  const out = new Uint8Array(to.width * to.height);
  for (let i = 0; i < out.length; i++) out[i] = big[i * 4];
  return out;
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
  const n = w * h;
  const erodeSteps = Math.max(2, Math.round(Math.max(w, h) / 340)); // ca. 3 px ved 1024, 6 px ved 2048

  // 1) "Sikre" pixels: helt inde i motivet, et par pixels fra kanten
  let safe = new Uint8Array(n);
  for (let i = 0; i < n; i++) safe[i] = mask[i] >= 230 ? 1 : 0;
  for (let k = 0; k < erodeSteps; k++) {
    const eroded = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        eroded[i] = safe[i] & safe[i - 1] & safe[i + 1] & safe[i - w] & safe[i + w];
      }
    }
    safe = eroded;
  }

  // 2) Skub farverne udad – én ring af pixels ad gangen, kun langs kanten af motivet
  const queued = new Uint8Array(n);
  const neighbours = (i, fn) => {
    const x = i % w;
    if (x > 0) fn(i - 1);
    if (x < w - 1) fn(i + 1);
    if (i >= w) fn(i - w);
    if (i < n - w) fn(i + w);
  };
  let ring = [];
  for (let i = 0; i < n; i++) {
    if (safe[i]) continue;
    let touches = false;
    neighbours(i, (j) => (touches ||= safe[j] === 1));
    if (touches) {
      ring.push(i);
      queued[i] = 1;
    }
  }
  const rings = 4 * erodeSteps + 6;
  for (let r = 0; r < rings && ring.length; r++) {
    // Find farverne for hele ringen først, og skriv dem bagefter
    const colors = new Float32Array(ring.length * 3);
    ring.forEach((i, k) => {
      let c = 0;
      neighbours(i, (j) => {
        if (!safe[j]) return;
        colors[k * 3] += px[j * 4];
        colors[k * 3 + 1] += px[j * 4 + 1];
        colors[k * 3 + 2] += px[j * 4 + 2];
        c++;
      });
      colors[k * 3] /= c;
      colors[k * 3 + 1] /= c;
      colors[k * 3 + 2] /= c;
    });
    ring.forEach((i, k) => {
      px[i * 4] = colors[k * 3];
      px[i * 4 + 1] = colors[k * 3 + 1];
      px[i * 4 + 2] = colors[k * 3 + 2];
      safe[i] = 1;
    });
    const next = [];
    for (const i of ring) {
      neighbours(i, (j) => {
        if (!safe[j] && !queued[j]) {
          queued[j] = 1;
          next.push(j);
        }
      });
    }
    ring = next;
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
  // Fotoet i lille størrelse, hvor masken bestemmer gennemsigtigheden
  const { canvas } = state.photo;
  const { width, height } = state.analysis;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(canvas, 0, 0, w, h);
  const img = tctx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / w));
      img.data[(y * w + x) * 4 + 3] = state.mask[sy * width + sx];
    }
  }
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
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
  const { width, height } = state.analysis;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of state.depth) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const span = hi - lo || 1;
  // Farvelæg kun de pixels der skal vises i det lille billede
  const ctx = sizeThumb(ui.thumbDepth);
  const { width: w, height: h } = ui.thumbDepth;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / w));
      const t = ((state.depth[sy * width + sx] - lo) / span) * (DEPTH_COLORS.length - 1);
      const k = Math.min(DEPTH_COLORS.length - 2, Math.floor(t));
      const f = t - k;
      const a = DEPTH_COLORS[k];
      const b = DEPTH_COLORS[k + 1];
      const o = (y * w + x) * 4;
      img.data[o] = a[0] + (b[0] - a[0]) * f;
      img.data[o + 1] = a[1] + (b[1] - a[1]) * f;
      img.data[o + 2] = a[2] + (b[2] - a[2]) * f;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
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
if (isTouchDevice) {
  sliders.res.input.max = 512;
  sliders.res.input.value = 256;
}

// "Ekstra skarp dybde" er slået til, når der er et grafikkort (WebGPU) – på processoren er det for langsomt
(async () => {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    ui.optHd.checked = Boolean(adapter?.features.has('shader-f16'));
  } catch {
    ui.optHd.checked = false;
  }
})();
ui.optHd.addEventListener('change', () => {
  if (state.photo && state.depth && !state.busy) analyze({ depth: true, background: false });
});

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

/** Giv browseren et øjeblik til at tegne (fx "Bygger 3D-model …") – men vent ikke, hvis siden er skjult. */
function nextPaint() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100); // skjult side/app i baggrunden: fortsæt alligevel
    requestAnimationFrame(() => {
      clearTimeout(timer);
      setTimeout(resolve, 0);
    });
  });
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
