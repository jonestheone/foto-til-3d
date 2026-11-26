/**
 * ai3d.js – "360° AI": en rigtig 3D-model med bagside, lavet af en gratis AI.
 *
 * Fotoet (med fjernet baggrund) sendes til en offentlig AI-demo på Hugging Face,
 * som laver en hel 3D-model og sender den tilbage som en GLB-fil. Det kører på
 * Hugging Face's gratis grafikkort ("ZeroGPU"), som har en daglig kvote:
 *
 *  - "Hurtig" = Stable Fast 3D (Stability AI): tager få sekunder og virker uden login.
 *  - "Bedst"  = TRELLIS (Microsoft): flottere, men kræver en gratis Hugging Face-nøgle.
 *
 * Forbindelsen klares af Gradio's JavaScript-klient (samme som demo-siderne selv bruger).
 */
const GRADIO_CLIENT = 'https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/dist/browser.min.js';
const TIMEOUT_MS = 5 * 60 * 1000; // giv op efter 5 minutter

export const ENGINES = {
  fast: {
    name: 'Stable Fast 3D',
    space: 'stabilityai/stable-fast-3d',
    help: 'Stable Fast 3D (Stability AI) – tager få sekunder og virker uden login.',
    run: runStableFast3D,
  },
  best: {
    name: 'TRELLIS',
    space: 'trellis-community/TRELLIS',
    help: 'TRELLIS (Microsoft) – flottere, tager ca. 1 minut og kræver en gratis Hugging Face-nøgle.',
    run: runTrellis,
  },
};

/**
 * Lav en 3D-model ud fra et udklip (PNG med gennemsigtig baggrund).
 * @param {Blob} cutout
 * @param {{ engine: 'fast'|'best', token?: string, onStatus?: (s: object) => void }} options
 * @returns {Promise<{ glb: Blob, engineName: string }>}
 */
export async function generate3D(cutout, { engine = 'fast', token = '', onStatus = () => {} } = {}) {
  const e = ENGINES[engine];
  onStatus({ stage: 'connecting', engine: e.name });
  const { Client, handle_file } = await import(GRADIO_CLIENT);

  let app;
  try {
    app = await Client.connect(e.space, {
      events: ['data', 'status'],
      ...(token ? { token } : {}),
    });
  } catch (err) {
    throw codedError('UNAVAILABLE', `${e.name} kan ikke kontaktes lige nu (${err?.message || err}).`);
  }

  const url = await withTimeout(e.run(app, handle_file, cutout, onStatus), TIMEOUT_MS, `${e.name} svarede ikke i tide.`);
  onStatus({ stage: 'downloading', engine: e.name });
  const response = await fetch(url);
  if (!response.ok) throw codedError('FAILED', `Kunne ikke hente 3D-modellen (${response.status}).`);
  return { glb: await response.blob(), engineName: e.name };
}

/** Stable Fast 3D: først gemmes udklippet i demoens session, så køres "Run". */
async function runStableFast3D(app, handle_file, cutout, onStatus) {
  await app.predict('/requires_bg_remove', { image: handle_file(cutout), fr: 0.85 });
  // "Run"-knappens tekst er et skjult input i demoen, så alle input sendes i rækkefølge
  const fn = findFunction(app, 'run_button');
  const data = await follow(app.submit(fn, ['Run', handle_file(cutout), null, 0.85, 'None', -1, 1024]), onStatus);
  return fileUrl(data[2]);
}

/** TRELLIS: start en session, klargør billedet, og lav 3D-modellen + GLB-filen. */
async function runTrellis(app, handle_file, cutout, onStatus) {
  await app.predict('/start_session', {});
  const prepared = await app.predict('/preprocess_image', { image: handle_file(cutout) });
  const data = await follow(
    app.submit('/generate_and_extract_glb', {
      image: prepared.data[0],
      multiimages: [],
      seed: 0,
      ss_guidance_strength: 7.5,
      ss_sampling_steps: 12,
      slat_guidance_strength: 3,
      slat_sampling_steps: 12,
      multiimage_algo: 'stochastic',
      mesh_simplify: 0.95,
      texture_size: 1024,
    }),
    onStatus,
  );
  return fileUrl(data[1]);
}

/** Følg en kørsel i AI'ens kø og meld status tilbage, indtil resultatet kommer. */
async function follow(submission, onStatus) {
  for await (const msg of submission) {
    if (msg.type === 'status') {
      if (msg.stage === 'error') {
        const text = msg.message || 'Ukendt fejl';
        if (/quota/i.test(text) || /quota/i.test(msg.title || '')) {
          throw codedError('QUOTA', text);
        }
        throw codedError('FAILED', text);
      }
      if (msg.original_msg === 'process_starts' || msg.stage === 'generating') {
        onStatus({ stage: 'generating' });
      } else if (msg.stage === 'pending' && typeof msg.position === 'number') {
        onStatus({ stage: 'queue', position: msg.position, eta: msg.eta });
      }
    }
    if (msg.type === 'data') return msg.data;
  }
  throw codedError('FAILED', 'AI\'en stoppede uden at sende en model.');
}

function findFunction(app, apiName) {
  const deps = app.config?.dependencies || [];
  const i = deps.findIndex((d) => d.api_name === apiName);
  if (i < 0) throw codedError('FAILED', `AI-demoen har ændret sig (fandt ikke "${apiName}").`);
  return deps[i].id ?? i;
}

function fileUrl(output) {
  const file = output?.value ?? output; // nogle demoer pakker filen ind i en "update"
  if (!file?.url) throw codedError('FAILED', 'AI\'en sendte ingen 3D-fil tilbage.');
  return file.url;
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(codedError('TIMEOUT', message)), ms);
    }),
  ]);
}
