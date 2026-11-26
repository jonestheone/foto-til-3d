/**
 * ai-worker.js – AI-delen af appen.
 *
 * Kører i en "Web Worker" (en baggrundstråd), så siden ikke fryser mens
 * modellerne regner. Den bruger Transformers.js til at køre to AI-modeller
 * direkte i browseren:
 *
 *   1. RMBG-1.4            – finder motivet og fjerner baggrunden
 *   2. Depth Anything V2   – gætter hvor langt væk hver pixel er (dybdekort)
 *
 * Modellerne hentes fra Hugging Face første gang og gemmes derefter i
 * browserens cache. Billedet forlader aldrig computeren.
 */
import {
  pipeline,
  env,
  RawImage,
  AutoModel,
  AutoProcessor,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

env.allowLocalModels = false; // hent altid modeller fra Hugging Face (de caches lokalt)

const HIGH_DETAIL_SIZE = 1022; // længste side for dybde-AI'en i "ekstra skarp" tilstand (73 x 14)

const MODELS = {
  background: {
    id: 'briaai/RMBG-1.4', // OBS: licens kun til ikke-kommerciel brug
    label: 'Baggrunds-model',
    status: 'Finder motivet …',
    async load(options) {
      // RMBG-1.4 har en speciel opsætning, så model og "processor" indlæses hver for sig
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(this.id, { ...options, config: { model_type: 'custom' } }),
        AutoProcessor.from_pretrained(this.id),
      ]);
      return { model, processor, dispose: () => model.dispose() };
    },
    async run({ model, processor }, image) {
      const { pixel_values } = await processor(image);
      const { output } = await model({ input: pixel_values });
      let t = output[0];
      if (t.type !== 'float32') t = t.to('float32');
      if (t.data.some((x) => x < -1e-5 || x > 1 + 1e-5)) t = t.sigmoid();
      // Masken er 1024x1024 – skalér den til billedets størrelse
      const mask = await RawImage.fromTensor(t.mul(255).to('uint8')).resize(image.width, image.height);
      return Uint8Array.from(mask.data);
    },
  },
  depth: {
    id: 'onnx-community/depth-anything-v2-small', // Apache-2.0
    label: 'Dybde-model',
    status: 'Beregner dybde …',
    load(options) {
      return pipeline('depth-estimation', this.id, options);
    },
    async run(estimator, image, { detail }) {
      // Hvor stort billedet er, når dybde-AI'en ser det. Modellen er trænet på 518 px,
      // men giver skarpere detaljer (øjne, hår, folder) ved højere opløsning – på
      // bekostning af tid. Billedet skal have sider der går op i 14 (modellens "felter").
      const proc = estimator.processor.image_processor;
      proc.defaultSize ??= proc.size;
      if (detail === 'high') {
        const longSide = Math.max(image.width, image.height);
        const target = Math.min(HIGH_DETAIL_SIZE, Math.max(518, longSide));
        const scale = target / longSide;
        const to14 = (x) => Math.max(14, Math.round((x * scale) / 14) * 14);
        proc.size = { width: to14(image.width), height: to14(image.height) };
      } else {
        proc.size = proc.defaultSize;
      }
      const { predicted_depth } = await estimator(image);
      const t = predicted_depth.type === 'float32' ? predicted_depth : predicted_depth.to('float32');
      // Højere tal = tættere på kameraet. Samme størrelse som billedet.
      return Float32Array.from(t.data);
    },
  },
};

const CPU_BACKEND = { device: 'wasm', dtype: 'q8' }; // CPU: mindre, kvantiserede modeller

let backend = null; // { device: 'webgpu' | 'wasm', dtype }
const loaded = {}; // nøgle -> Promise<model>
const ready = {}; // nøgle -> true når modellen er hentet

/** Brug grafikkortet (WebGPU) hvis det kan, ellers processoren (WASM). */
async function chooseBackend() {
  if (backend) return backend;
  try {
    const adapter = await self.navigator?.gpu?.requestAdapter();
    if (adapter?.features.has('shader-f16')) {
      backend = { device: 'webgpu', dtype: 'fp16' };
      return backend;
    }
  } catch {
    /* ingen WebGPU – helt fint */
  }
  backend = CPU_BACKEND;
  return backend;
}

function load(key) {
  if (!loaded[key]) {
    const m = MODELS[key];
    const files = {};
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.file) return;
      files[p.file] = { loaded: p.loaded ?? 0, total: p.total ?? 0 };
      let sum = 0;
      let total = 0;
      for (const f of Object.values(files)) {
        sum += f.loaded;
        total += f.total;
      }
      self.postMessage({
        type: 'progress',
        key,
        label: m.label,
        loaded: sum,
        total,
        progress: total ? (sum / total) * 100 : 0,
      });
    };
    const promise = chooseBackend().then(({ device, dtype }) => m.load({ device, dtype, progress_callback }));
    loaded[key] = promise;
    // Hvis hentningen fejler, glemmer vi den, så man kan prøve igen
    promise.catch(() => {
      if (loaded[key] === promise) delete loaded[key];
    });
  }
  return loaded[key];
}

const timings = {}; // hvor lang tid hvert trin tog (vises i konsollen)

async function run(id, key, image, options) {
  if (!ready[key]) status(id, 'Henter AI-modeller …');
  let t = performance.now();
  const model = await load(key);
  timings[`${key}: indlæs`] = Math.round(performance.now() - t);
  ready[key] = true;
  status(id, MODELS[key].status);
  t = performance.now();
  const out = await MODELS[key].run(model, image, options);
  timings[`${key}: kør`] = Math.round(performance.now() - t);
  return out;
}

/** Prøv på grafikkortet – går det galt, prøver vi igen på processoren. */
async function runWithFallback(id, key, makeImage, options = {}) {
  try {
    return await run(id, key, makeImage(), options);
  } catch (err) {
    if (backend?.device !== 'webgpu') throw err;
    console.warn(`WebGPU fejlede (${key}) – skifter til CPU (WASM).`, err);
    backend = CPU_BACKEND;
    for (const k of Object.keys(loaded)) {
      const old = loaded[k];
      delete loaded[k];
      delete ready[k];
      old.then((m) => m.dispose?.()).catch(() => {});
    }
    return await run(id, key, makeImage(), options);
  }
}

function status(id, text) {
  self.postMessage({ type: 'status', id, text });
}

self.addEventListener('message', async ({ data }) => {
  // Begynd at indlæse modellerne i forvejen (mens brugeren vælger et billede)
  if (data?.type === 'preload') {
    for (const key of Object.keys(MODELS)) if (data.tasks[key]) load(key).catch(() => {});
    return;
  }
  if (data?.type !== 'analyze') return;
  const { id, image, tasks, detail = 'normal' } = data;
  const { width, height } = image;
  // Hver model får sin egen kopi af billedet (de må gerne ændre i det)
  const makeImage = () => new RawImage(new Uint8ClampedArray(image.data), width, height, 4);

  try {
    // Start hentning af de modeller vi skal bruge – de hentes samtidig
    for (const key of Object.keys(MODELS)) if (tasks[key]) load(key);

    const result = { type: 'result', id };
    const transfer = [];

    if (tasks.background) {
      result.mask = await runWithFallback(id, 'background', makeImage);
      transfer.push(result.mask.buffer);
    }
    if (tasks.depth) {
      result.depth = await runWithFallback(id, 'depth', makeImage, { detail });
      transfer.push(result.depth.buffer);
    }

    result.device = backend?.device ?? 'wasm';
    console.info(`AI-tider i ms (${result.device}):`, JSON.stringify(timings));
    for (const k of Object.keys(timings)) delete timings[k];
    self.postMessage(result, transfer);
  } catch (err) {
    console.error(err);
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
});
