/**
 * mesh.js – bygger et 3D-trekantnet ud fra et dybdekort (og evt. en maske).
 *
 * Sådan virker det:
 *  1. Vi lægger et gitter (fx 256 x 192 punkter) hen over billedet.
 *  2. Hvert punkt aflæser dybdekortet: tæt på kameraet = højt (z).
 *  3. Form "Figur": motivet pustes op som en ballon (Poisson-ligningen),
 *     så det får en afrundet bagside, og for- og bagside mødes i kanten.
 *     Modellen bliver lukket ("vandtæt"), så den også kan 3D-printes.
 *  4. Form "Relief": en plade med relief foran, flad bagside og lodrette sider.
 *
 * Filen bruger ikke Three.js – den returnerer bare tal-arrays
 * (positioner, UV-koordinater og trekanter), som viewer.js viser.
 */

/**
 * @param {object} o
 * @param {number} o.width            billedets bredde i pixels
 * @param {number} o.height           billedets højde i pixels
 * @param {Float32Array} o.depth      dybde pr. pixel (højere = tættere på)
 * @param {Uint8Array|null} o.mask    0–255 pr. pixel (255 = motiv), eller null = hele billedet
 * @param {'figure'|'relief'} o.mode
 * @param {number} o.depthAmount      0–1: hvor kraftigt dybden vises
 * @param {number} o.thickness        0–1: tykkelse (figur) eller pladetykkelse (relief)
 * @param {number} o.smoothing        0–10: hvor meget dybden glattes
 * @param {number} o.resolution       antal gitterpunkter på den længste led
 */
export function buildMeshData({
  width,
  height,
  depth,
  mask = null,
  mode = 'figure',
  depthAmount = 0.35,
  thickness = 0.5,
  smoothing = 3,
  resolution = 256,
}) {
  const isFigure = mode === 'figure';

  // ---------- 1. Gitter ----------
  const res = Math.max(16, Math.round(resolution));
  let cols, rows;
  if (width >= height) {
    cols = res;
    rows = Math.max(3, Math.round((res * height) / width));
  } else {
    rows = res;
    cols = Math.max(3, Math.round((res * width) / height));
  }
  const n = cols * rows;
  const maxDim = Math.max(cols, rows);
  const cell = 2 / (maxDim - 1); // modellens længste side er 2 enheder
  const halfW = ((cols - 1) * cell) / 2;
  const halfH = ((rows - 1) * cell) / 2;
  const sx = (width - 1) / (cols - 1);
  const sy = (height - 1) / (rows - 1);

  // ---------- 2. Aflæs dybde og maske i gitterpunkterne ----------
  const raw = new Float32Array(n);
  let inside = new Uint8Array(n);
  for (let j = 0, v = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++, v++) {
      const px = i * sx;
      const py = j * sy;
      raw[v] = sample(depth, width, height, px, py);
      inside[v] = mask ? (sample(mask, width, height, px, py) >= 128 ? 1 : 0) : 1;
    }
  }
  if (isFigure) inside = openMask(inside, cols, rows);
  if (mask) inside = cleanMask(inside, cols, rows);
  let insideCount = 0;
  for (let v = 0; v < n; v++) insideCount += inside[v];
  if (insideCount < 16) {
    const err = new Error('Kunne ikke finde et motiv i billedet.');
    err.code = 'NO_SUBJECT';
    throw err;
  }

  // ---------- 3. Glat dybden og skalér den til 0–1 inden for motivet ----------
  const radius = Math.round((smoothing * maxDim) / 256);
  const smooth = radius > 0 ? maskedBlur(raw, inside, cols, rows, radius) : raw;
  const [lo, hi] = percentileRange(smooth, inside, 0.01, 0.99);
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const rel = new Float32Array(n); // 0 = længst væk, 1 = tættest på
  for (let v = 0; v < n; v++) if (inside[v]) rel[v] = clamp01((smooth[v] - lo) / span);

  // ---------- 4. Højde (z) for forside og bagside ----------
  const zFront = new Float32Array(n);
  const zBack = new Float32Array(n);
  const reliefHeight = depthAmount * 0.8;

  if (isFigure) {
    // "Pust op": løs Poisson-ligningen inde i motivet. sqrt(2u) giver et
    // cirkelrundt tværsnit, hvor tynde dele (arme, ører) bliver tynde.
    const u = solvePoisson(inside, cols, rows);
    // Bagsiden følger en meget udglattet dybde, så fx en næse ikke "trykkes igennem"
    const relBack = maskedBlur(rel, inside, cols, rows, Math.max(2, Math.round(maxDim * 0.05)));
    const k = 0.03 + thickness * 1.2;
    const edge = (4 * maxDim) / 256;
    for (let v = 0; v < n; v++) {
      if (!inside[v]) continue;
      const hGrid = Math.sqrt(2 * u[v]);
      const h = hGrid * cell * k;
      const t = smoothstep(0, edge, hGrid); // 0 ved kanten, 1 længere inde
      zFront[v] = rel[v] * reliefHeight + h;
      zBack[v] = (rel[v] + (relBack[v] - rel[v]) * t) * reliefHeight - h;
    }
  } else {
    const base = 0.03 + thickness * 0.25; // pladens tykkelse
    for (let v = 0; v < n; v++) {
      if (!inside[v]) continue;
      zFront[v] = base + rel[v] * reliefHeight;
      zBack[v] = 0;
    }
  }

  // ---------- 5. Trekanter for forsiden ----------
  // Hver gittercelle a-b / c-d bliver til 2 trekanter (eller 1 ved kanten af motivet).
  const tri = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let tc = 0;
  const push = (a, b, c) => {
    tri[tc++] = a;
    tri[tc++] = b;
    tri[tc++] = c;
  };
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      const count = inside[a] + inside[b] + inside[c] + inside[d];
      if (count === 4) {
        // Vælg den diagonal, der følger overfladen bedst
        if (Math.abs(zFront[a] - zFront[d]) <= Math.abs(zFront[b] - zFront[c])) {
          push(a, c, d);
          push(a, d, b);
        } else {
          push(a, c, b);
          push(b, c, d);
        }
      } else if (count === 3) {
        if (!inside[a]) push(b, c, d);
        else if (!inside[b]) push(a, c, d);
        else if (!inside[c]) push(a, d, b);
        else push(a, c, b);
      }
    }
  }

  // ---------- 6. Find kanten (kantstykker der kun bruges af én trekant) ----------
  const edgeCount = new Uint8Array(4 * n);
  const slot = (p, q) => {
    if (p > q) {
      const t = p;
      p = q;
      q = t;
    }
    const diff = q - p;
    if (diff === 1) return p; // vandret
    if (diff === cols) return n + p; // lodret
    if (diff === cols + 1) return 2 * n + p; // diagonal "\"
    return 3 * n + p; // diagonal "/" (diff === cols - 1)
  };
  for (let t = 0; t < tc; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    edgeCount[slot(a, b)]++;
    edgeCount[slot(b, c)]++;
    edgeCount[slot(c, a)]++;
  }
  const used = new Uint8Array(n);
  const onBoundary = new Uint8Array(n);
  const boundaryEdges = []; // par [p, q] i samme retning som i forsidens trekant
  for (let t = 0; t < tc; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    used[a] = used[b] = used[c] = 1;
    if (edgeCount[slot(a, b)] === 1) { boundaryEdges.push(a, b); onBoundary[a] = onBoundary[b] = 1; }
    if (edgeCount[slot(b, c)] === 1) { boundaryEdges.push(b, c); onBoundary[b] = onBoundary[c] = 1; }
    if (edgeCount[slot(c, a)] === 1) { boundaryEdges.push(c, a); onBoundary[c] = onBoundary[a] = 1; }
  }

  // ---------- 7. Punkter (vertices) ----------
  let usedCount = 0;
  let boundaryCount = 0;
  for (let v = 0; v < n; v++) {
    if (!used[v]) continue;
    usedCount++;
    if (onBoundary[v]) boundaryCount++;
  }
  const vertexCount = isFigure ? usedCount * 2 - boundaryCount : (usedCount + boundaryCount) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const frontIdx = new Int32Array(n).fill(-1);
  const backIdx = new Int32Array(n).fill(-1);
  const wallTop = isFigure ? null : new Int32Array(n).fill(-1);
  const wallBottom = isFigure ? null : new Int32Array(n).fill(-1);

  let vc = 0;
  const addVertex = (v, z) => {
    const i = v % cols;
    const j = (v - i) / cols;
    positions[vc * 3] = i * cell - halfW;
    positions[vc * 3 + 1] = halfH - j * cell;
    positions[vc * 3 + 2] = z;
    uvs[vc * 2] = (i * sx + 0.5) / width;
    uvs[vc * 2 + 1] = 1 - (j * sy + 0.5) / height;
    return vc++;
  };
  for (let v = 0; v < n; v++) {
    if (!used[v]) continue;
    if (isFigure && onBoundary[v]) {
      // Kantpunkter deles af for- og bagside, så modellen bliver lukket
      frontIdx[v] = backIdx[v] = addVertex(v, (zFront[v] + zBack[v]) / 2);
    } else {
      frontIdx[v] = addVertex(v, zFront[v]);
      backIdx[v] = addVertex(v, zBack[v]);
    }
    if (!isFigure && onBoundary[v]) {
      // Ekstra punkter til siderne, så de får skarpe kanter
      wallTop[v] = addVertex(v, zFront[v]);
      wallBottom[v] = addVertex(v, zBack[v]);
    }
  }

  // ---------- 8. Trekanter: forside (+ sider) og bagside ----------
  const frontTriangles = tc / 3;
  const wallTriangles = isFigure ? 0 : boundaryEdges.length; // 2 trekanter pr. kantstykke
  const indices = new Uint32Array((frontTriangles * 2 + wallTriangles) * 3);
  let ic = 0;
  for (let t = 0; t < tc; t += 3) {
    indices[ic++] = frontIdx[tri[t]];
    indices[ic++] = frontIdx[tri[t + 1]];
    indices[ic++] = frontIdx[tri[t + 2]];
  }
  if (!isFigure) {
    for (let e = 0; e < boundaryEdges.length; e += 2) {
      const p = boundaryEdges[e];
      const q = boundaryEdges[e + 1];
      indices[ic++] = wallTop[p];
      indices[ic++] = wallBottom[p];
      indices[ic++] = wallBottom[q];
      indices[ic++] = wallTop[p];
      indices[ic++] = wallBottom[q];
      indices[ic++] = wallTop[q];
    }
  }
  const backStart = ic;
  for (let t = 0; t < tc; t += 3) {
    // Bagsiden vender den anden vej, så trekanternes rækkefølge byttes om
    indices[ic++] = backIdx[tri[t]];
    indices[ic++] = backIdx[tri[t + 2]];
    indices[ic++] = backIdx[tri[t + 1]];
  }

  return {
    positions,
    uvs,
    indices,
    groups: [
      { start: 0, count: backStart, materialIndex: 0 }, // forside (+ sider)
      { start: backStart, count: ic - backStart, materialIndex: 1 }, // bagside
    ],
    vertexCount,
    triangleCount: ic / 3,
    grid: { cols, rows },
  };
}

/* ------------------------------------------------------------------ */
/* Hjælpefunktioner                                                    */
/* ------------------------------------------------------------------ */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Bilineær aflæsning af et 2D-array (w x h) i punktet (x, y). */
function sample(arr, w, h, x, y) {
  const x0 = Math.min(Math.floor(x), w - 1);
  const y0 = Math.min(Math.floor(y), h - 1);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = arr[y0 * w + x0] * (1 - fx) + arr[y0 * w + x1] * fx;
  const bottom = arr[y1 * w + x0] * (1 - fx) + arr[y1 * w + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * "Åbning" af masken: fjerner dele der er tyndere end 3 gitterpunkter.
 * Så tynde dele kan ikke få både for- og bagside, og ville gøre modellen utæt.
 */
function openMask(inside, cols, rows) {
  const n = cols * rows;
  const eroded = new Uint8Array(n);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const v = j * cols + i;
      eroded[v] = inside[v] && inside[v - 1] && inside[v + 1] && inside[v - cols] && inside[v + cols] ? 1 : 0;
    }
  }
  const out = new Uint8Array(n);
  for (let j = 0, v = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++, v++) {
      if (!inside[v]) continue;
      out[v] =
        eroded[v] ||
        (i > 0 && eroded[v - 1]) ||
        (i < cols - 1 && eroded[v + 1]) ||
        (j > 0 && eroded[v - cols]) ||
        (j < rows - 1 && eroded[v + cols])
          ? 1
          : 0;
    }
  }
  return out;
}

/**
 * Rydder op i masken: fjerner små "øer" (støj) og lukker små huller.
 */
function cleanMask(inside, cols, rows) {
  const n = cols * rows;
  const out = new Uint8Array(inside);
  const label = new Int32Array(n);
  const queue = new Int32Array(n);

  // Finder sammenhængende områder med værdien `val` (4-naboer)
  const findRegions = (val) => {
    label.fill(-1);
    const regions = [];
    for (let s = 0; s < n; s++) {
      if (out[s] !== val || label[s] !== -1) continue;
      const id = regions.length;
      let head = 0;
      let tail = 0;
      let touchesBorder = false;
      queue[tail++] = s;
      label[s] = id;
      while (head < tail) {
        const v = queue[head++];
        const i = v % cols;
        const j = (v - i) / cols;
        if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) touchesBorder = true;
        if (i > 0 && out[v - 1] === val && label[v - 1] === -1) { label[v - 1] = id; queue[tail++] = v - 1; }
        if (i < cols - 1 && out[v + 1] === val && label[v + 1] === -1) { label[v + 1] = id; queue[tail++] = v + 1; }
        if (j > 0 && out[v - cols] === val && label[v - cols] === -1) { label[v - cols] = id; queue[tail++] = v - cols; }
        if (j < rows - 1 && out[v + cols] === val && label[v + cols] === -1) { label[v + cols] = id; queue[tail++] = v + cols; }
      }
      regions.push({ size: tail, touchesBorder });
    }
    return regions;
  };

  // 1) Fjern små øer: behold kun områder på mindst 3 % af det største
  let regions = findRegions(1);
  if (regions.length > 1) {
    let largest = 0;
    for (const r of regions) largest = Math.max(largest, r.size);
    const minSize = Math.max(12, largest * 0.03);
    for (let v = 0; v < n; v++) if (out[v] && regions[label[v]].size < minSize) out[v] = 0;
  }

  // 2) Luk små huller inde i motivet (under 0,5 % af motivets areal)
  let area = 0;
  for (let v = 0; v < n; v++) area += out[v];
  regions = findRegions(0);
  for (let v = 0; v < n; v++) {
    if (out[v]) continue;
    const r = regions[label[v]];
    if (!r.touchesBorder && r.size < area * 0.005) out[v] = 1;
  }
  return out;
}

/**
 * Sløring der kun bruger punkter inde i motivet (så baggrundens dybde ikke
 * "smitter" af på kanten). Box-blur gentaget 2 gange ≈ Gauss-sløring.
 */
function maskedBlur(values, inside, cols, rows, radius, passes = 2) {
  const n = cols * rows;
  const num = new Float32Array(n);
  const den = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    if (inside[v]) {
      num[v] = values[v];
      den[v] = 1;
    }
  }
  for (let p = 0; p < passes; p++) {
    boxBlurH(num, tmp, cols, rows, radius);
    boxBlurV(tmp, num, cols, rows, radius);
    boxBlurH(den, tmp, cols, rows, radius);
    boxBlurV(tmp, den, cols, rows, radius);
  }
  const out = new Float32Array(n);
  for (let v = 0; v < n; v++) out[v] = inside[v] && den[v] > 1e-8 ? num[v] / den[v] : values[v];
  return out;
}

function boxBlurH(src, dst, cols, rows, r) {
  const norm = 1 / (2 * r + 1);
  for (let j = 0; j < rows; j++) {
    const row = j * cols;
    let sum = 0;
    for (let i = 0; i <= Math.min(r, cols - 1); i++) sum += src[row + i];
    for (let i = 0; i < cols; i++) {
      dst[row + i] = sum * norm;
      if (i + r + 1 < cols) sum += src[row + i + r + 1];
      if (i - r >= 0) sum -= src[row + i - r];
    }
  }
}

function boxBlurV(src, dst, cols, rows, r) {
  const norm = 1 / (2 * r + 1);
  for (let i = 0; i < cols; i++) {
    let sum = 0;
    for (let j = 0; j <= Math.min(r, rows - 1); j++) sum += src[j * cols + i];
    for (let j = 0; j < rows; j++) {
      dst[j * cols + i] = sum * norm;
      if (j + r + 1 < rows) sum += src[(j + r + 1) * cols + i];
      if (j - r >= 0) sum -= src[(j - r) * cols + i];
    }
  }
}

/** Robust min/max: ser bort fra de 1 % mest ekstreme værdier i hver ende. */
function percentileRange(values, inside, pLo, pHi) {
  let count = 0;
  for (let v = 0; v < values.length; v++) count += inside[v];
  const arr = new Float32Array(count);
  for (let v = 0, k = 0; v < values.length; v++) if (inside[v]) arr[k++] = values[v];
  arr.sort();
  return [arr[Math.floor(pLo * (count - 1))], arr[Math.ceil(pHi * (count - 1))]];
}

/**
 * Løser Poisson-ligningen  ∇²u = -1  inde i motivet (u = 0 udenfor).
 * Resultatet er en blød "bakke", der er højest midt i motivet.
 * Løses hurtigt ved først at regne på et groft gitter og så forfine (multigrid-agtigt).
 */
function solvePoisson(inside, cols, rows) {
  const n = cols * rows;
  const u = new Float32Array(n);
  const maxDim = Math.max(cols, rows);

  if (maxDim <= 40) {
    sor(u, inside, cols, rows, 4 * maxDim, 2 / (1 + Math.sin(Math.PI / maxDim)));
    return u;
  }

  // Løs på et gitter med halv opløsning, og brug det som startgæt
  const cc = (cols + 1) >> 1;
  const cr = (rows + 1) >> 1;
  const coarseInside = new Uint8Array(cc * cr);
  for (let j = 0; j < cr; j++) {
    for (let i = 0; i < cc; i++) coarseInside[j * cc + i] = inside[2 * j * cols + 2 * i];
  }
  const coarse = solvePoisson(coarseInside, cc, cr);
  for (let j = 0, v = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++, v++) {
      // u vokser med afstanden i anden potens, derfor * 4 ved dobbelt opløsning
      if (inside[v]) u[v] = 4 * sample(coarse, cc, cr, i / 2, j / 2);
    }
  }
  sor(u, inside, cols, rows, 40, 1.6);
  return u;
}

/** Gauss-Seidel med over-relaksation (SOR). */
function sor(u, inside, cols, rows, iterations, omega) {
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < rows; j++) {
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        const v = row + i;
        if (!inside[v]) continue;
        const sum =
          (i > 0 ? u[v - 1] : 0) +
          (i < cols - 1 ? u[v + 1] : 0) +
          (j > 0 ? u[v - cols] : 0) +
          (j < rows - 1 ? u[v + cols] : 0);
        u[v] += omega * ((sum + 1) * 0.25 - u[v]);
      }
    }
  }
}
