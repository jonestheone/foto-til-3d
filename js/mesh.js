/**
 * mesh.js – bygger et 3D-trekantnet ud fra et dybdekort (og evt. en maske).
 *
 * Sådan virker det:
 *  1. Vi lægger et gitter (fx 384 x 307 punkter) hen over billedet.
 *  2. Hvert punkt aflæser dybdekortet: tæt på kameraet = højt (z).
 *  3. Form "Figur": motivet pustes op som en ballon (Poisson-ligningen),
 *     så det får en afrundet bagside, og for- og bagside mødes i kanten.
 *     Modellen bliver lukket ("vandtæt"), så den også kan 3D-printes.
 *  4. Form "Relief": en plade med relief foran, flad bagside og lodrette sider.
 *
 * Det tunge arbejde (hvilke punkter er motiv, trekanterne, "oppustningen")
 * afhænger kun af billedet, opløsningen og formen. Det gemmes, så skyderne
 * Dybde, Tykkelse, Fremhæv detaljer og Glathed kan opdatere modellen hurtigt.
 *
 * Filen bruger ikke Three.js – den returnerer bare tal-arrays
 * (positioner, UV-koordinater og trekanter), som viewer.js viser.
 */

/**
 * @param {object} o
 * @param {number} o.width            dybdekortets bredde i pixels
 * @param {number} o.height           dybdekortets højde i pixels
 * @param {Float32Array} o.depth      dybde pr. pixel (højere = tættere på)
 * @param {Uint8Array|null} o.mask    0–255 pr. pixel (255 = motiv), eller null = hele billedet
 * @param {'figure'|'relief'} o.mode
 * @param {number} o.depthAmount      0–1: hvor kraftigt dybden vises
 * @param {number} o.thickness        0–1: tykkelse (figur) eller pladetykkelse (relief)
 * @param {number} o.rounding         0–1: hvor runde kanterne er (0 = skarpe)
 * @param {number} o.detailBoost      0–1: hvor meget små former (næse, øjne, pels) forstærkes
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
  rounding = 0.7,
  detailBoost = 0.4,
  smoothing = 1,
  resolution = 384,
}) {
  const isFigure = mode === 'figure';
  const timings = {}; // hvor lang tid hvert trin tager (ms) – nyttigt hvis noget bliver langsomt
  let lapStart = performance.now();
  const lap = (name) => {
    const now = performance.now();
    timings[name] = Math.round((now - lapStart) * 10) / 10;
    lapStart = now;
  };

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

  // ---------- 2. Formen: motivets punkter, trekanterne og "oppustningen" ----------
  const topo = getTopology(depth, mask, width, height, cols, rows, isFigure);
  const { inside, raw, tri, tc, used, onBoundary, boundaryEdges, poisson, edgeDist } = topo;
  lap('form');

  // ---------- 3. Glat dybden og skalér den til 0–1 inden for motivet ----------
  const radius = Math.round((smoothing * maxDim) / 256);
  const smooth = radius > 0 ? maskedBlur(raw, inside, cols, rows, radius) : raw;
  const [lo, hi] = percentileRange(smooth, inside, 0.01, 0.99);
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const rel = new Float32Array(n); // 0 = længst væk, 1 = tættest på
  for (let v = 0; v < n; v++) if (inside[v]) rel[v] = clamp01((smooth[v] - lo) / span);

  // Fremhæv detaljer ("unsharp mask"): forskellen mellem dybden og en udglattet
  // udgave af den er de små former (næse, øjne, pels, folder) – dem forstærker vi.
  // Store spring i dybden (fx hage → hals) må ikke forstærkes, for så opstår der
  // skarpe rygge og render langs springet. Derfor "bløddæmpes" store forskelle.
  if (detailBoost > 0) {
    const base = maskedBlur(rel, inside, cols, rows, Math.max(2, Math.round(maxDim * 0.03)));
    const k = detailBoost * 2.5;
    const limit = 0.05; // forskelle større end ca. 5 % af dybden dæmpes
    for (let v = 0; v < n; v++) {
      if (!inside[v]) continue;
      const d = rel[v] - base[v];
      rel[v] += (k * d) / (1 + Math.abs(d) / limit);
    }
  }

  // Helt ude ved motivets kant er AI'ens dybde upålidelig (den blander forgrund og
  // baggrund), og det giver takker. Derfor glider vi over i en udglattet dybde dér.
  const edgeBand = Math.max(2, maxDim / 128);
  const relEdge = maskedBlur(rel, inside, cols, rows, Math.ceil(edgeBand * 2));
  for (let v = 0; v < n; v++) {
    if (!inside[v]) continue;
    const w = smoothstep(1, 1 + edgeBand, edgeDist[v]); // 0 ved kanten, 1 længere inde
    rel[v] = relEdge[v] + (rel[v] - relEdge[v]) * w;
  }
  lap('dybde');

  // ---------- 4. Højde (z) for forside og bagside ----------
  const zFront = new Float32Array(n);
  const zBack = new Float32Array(n);
  const reliefHeight = depthAmount * 0.8;

  if (isFigure) {
    // sqrt(2u) af Poisson-løsningen giver et cirkelrundt tværsnit,
    // hvor tynde dele (arme, ører) bliver tynde og tykke dele tykke.
    // Bagsiden følger en meget udglattet dybde, så fx en næse ikke "trykkes igennem".
    const relBack = maskedBlur(rel, inside, cols, rows, Math.max(2, Math.round(maxDim * 0.05)));
    const k = 0.03 + thickness * 1.2;
    const edge = (4 * maxDim) / 256;
    for (let v = 0; v < n; v++) {
      if (!inside[v]) continue;
      const hGrid = Math.sqrt(2 * poisson[v]);
      const h = hGrid * cell * k;
      const t = smoothstep(0, edge, hGrid); // 0 ved kanten, 1 længere inde
      zFront[v] = rel[v] * reliefHeight + h;
      zBack[v] = (rel[v] + (relBack[v] - rel[v]) * t) * reliefHeight - h;
      // For- og bagside må aldrig krydse hinanden (det giver fejl ved 3D-print)
      if (zFront[v] - zBack[v] < h) {
        const mid = (zFront[v] + zBack[v]) / 2;
        zFront[v] = mid + h / 2;
        zBack[v] = mid - h / 2;
      }
    }
  } else {
    const base = 0.03 + thickness * 0.25; // pladens tykkelse
    for (let v = 0; v < n; v++) {
      if (!inside[v]) continue;
      zFront[v] = Math.max(0.005, base + rel[v] * reliefHeight);
      zBack[v] = 0;
    }
  }
  lap('højde');

  // ---------- 5. Afrund kanterne ----------
  // Position for hvert gitterpunkt på forsiden (F) og bagsiden (B).
  // I en figur er omrids-punkterne fælles for for- og bagside.
  const Fx = new Float32Array(n);
  const Fy = new Float32Array(n);
  const Bx = new Float32Array(n);
  const By = new Float32Array(n);
  const Fz = zFront;
  const Bz = zBack;
  for (let j = 0, v = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++, v++) {
      if (!used[v]) continue;
      Fx[v] = Bx[v] = i * cell - halfW;
      Fy[v] = By[v] = halfH - j * cell;
      if (isFigure && onBoundary[v]) Fz[v] = Bz[v] = (zFront[v] + zBack[v]) / 2;
    }
  }
  const band = Math.max(3, maxDim / 48); // hvor langt ind fra kanten afrundingen når (gitterceller)
  if (rounding > 0 && isFigure) {
    roundFigureEdges({ cols, rows, used, onBoundary, edgeDist, band, pairs: Math.round(rounding * 8), Fx, Fy, Fz, Bx, By, Bz });
  } else if (rounding > 0) {
    // Relief: rund pladens øverste kant af med en kvartcirkel
    const r = Math.max(1, rounding * band);
    for (let v = 0; v < n; v++) {
      if (!used[v]) continue;
      const d = edgeDist[v] - 1; // 0 ved kanten
      if (d >= r) continue;
      const drop = (r - Math.sqrt(Math.max(0, r * r - (r - d) * (r - d)))) * cell;
      Fz[v] = Math.max(Bz[v] + 0.005, Fz[v] - drop);
    }
  }
  lap('afrunding');

  // ---------- 6. Punkter (vertices) ----------
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
  const addVertex = (x, y, z) => {
    positions[vc * 3] = x;
    positions[vc * 3 + 1] = y;
    positions[vc * 3 + 2] = z;
    // Fotoet følger punktets (evt. afrundede) placering
    uvs[vc * 2] = (((x + halfW) / cell) * sx + 0.5) / width;
    uvs[vc * 2 + 1] = 1 - (((halfH - y) / cell) * sy + 0.5) / height;
    return vc++;
  };
  for (let v = 0; v < n; v++) {
    if (!used[v]) continue;
    if (isFigure && onBoundary[v]) {
      // Kantpunkter deles af for- og bagside, så modellen bliver lukket
      frontIdx[v] = backIdx[v] = addVertex(Fx[v], Fy[v], Fz[v]);
    } else {
      frontIdx[v] = addVertex(Fx[v], Fy[v], Fz[v]);
      backIdx[v] = addVertex(Bx[v], By[v], Bz[v]);
    }
    if (!isFigure && onBoundary[v]) {
      // Ekstra punkter til siderne, så de får skarpe kanter
      wallTop[v] = addVertex(Fx[v], Fy[v], Fz[v]);
      wallBottom[v] = addVertex(Bx[v], By[v], Bz[v]);
    }
  }

  // ---------- 7. Trekanter: forside (+ sider) og bagside ----------
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
  lap('punkter');

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
    timings,
    cleanupPasses: topo.passes,
  };
}

/* ------------------------------------------------------------------ */
/* Formen (gemmes mellem kald)                                         */
/* ------------------------------------------------------------------ */

let topoCache = null;

/**
 * Finder motivets punkter i gitteret, binder dem sammen med trekanter og
 * "puster" figuren op. Resultatet gemmes, så længe billede, maske,
 * opløsning og form er de samme.
 */
function getTopology(depth, mask, width, height, cols, rows, isFigure) {
  const c = topoCache;
  if (c && c.depth === depth && c.mask === mask && c.cols === cols && c.rows === rows && c.isFigure === isFigure) {
    return c;
  }
  const n = cols * rows;
  const sx = (width - 1) / (cols - 1);
  const sy = (height - 1) / (rows - 1);

  // --- Aflæs dybde og maske i gitterpunkterne ---
  const raw = new Float32Array(n);
  let coverage = new Float32Array(n); // hvor stor en del af cellen der er motiv (0–1)
  if (sx >= 1.5) {
    // Gitteret er grovere end billedet: brug gennemsnittet af alle pixels i cellen
    // (kun pixels på motivet). Det giver renere former end at nøjes med én pixel.
    const area = getAreaSums(depth, mask, width, height);
    for (let j = 0, v = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++, v++) {
        area.mean(i * sx, j * sy, sx / 2, sy / 2);
        raw[v] = area.depth;
        coverage[v] = area.coverage;
      }
    }
  } else {
    // Gitteret er finere end billedet: aflæs mellem pixels (bilineært)
    for (let j = 0, v = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++, v++) {
        raw[v] = sample(depth, width, height, i * sx, j * sy);
        coverage[v] = mask ? sample(mask, width, height, i * sx, j * sy) / 255 : 1;
      }
    }
  }
  // Et blødt omrids: sløres masken lidt, før vi bestemmer hvad der er motiv, forsvinder
  // trappetrin og tynde takker (fx enkelte hårstrå), og hjørnerne bliver runde.
  if (mask) coverage = maskedBlur(coverage, new Uint8Array(n).fill(1), cols, rows, Math.max(1, Math.round(Math.max(cols, rows) / 192)));
  let inside = new Uint8Array(n);
  for (let v = 0; v < n; v++) inside[v] = coverage[v] >= 0.5 ? 1 : 0;
  if (isFigure) inside = openMask(inside, cols, rows);
  if (mask) inside = cleanMask(inside, cols, rows);
  let insideCount = 0;
  for (let v = 0; v < n; v++) insideCount += inside[v];
  if (insideCount < 16) {
    const err = new Error('Kunne ikke finde et motiv i billedet.');
    err.code = 'NO_SUBJECT';
    throw err;
  }

  // --- Trekanter for forsiden ---
  // Hver gittercelle a-b / c-d bliver til 2 trekanter (eller 1 ved kanten af motivet).
  // Hver kant har sit eget nummer ("slot"), så vi kan tælle hvor mange trekanter der
  // bruger den: kanter der kun bruges af én trekant, er motivets omrids.
  //   vandret a-b: a    lodret a-c: n+a    diagonal a-d: 2n+a    diagonal b-c: 3n+a
  const maxIdx = (cols - 1) * (rows - 1) * 6;
  const tri = new Uint32Array(maxIdx);
  const triEdge = new Uint32Array(maxIdx); // kant-nummer for kanten tri[t] → næste hjørne
  const edgeCount = new Uint8Array(4 * n);
  const used = new Uint8Array(n);
  const onBoundary = new Uint8Array(n);
  const nearEdge = new Uint8Array(n);
  let boundaryEdges = []; // par [p, q] i samme retning som i forsidens trekant
  let tc = 0;
  const pushTri = (a, b, cc, eab, ebc, eca) => {
    tri[tc] = a;
    triEdge[tc++] = eab;
    tri[tc] = b;
    triEdge[tc++] = ebc;
    tri[tc] = cc;
    triEdge[tc++] = eca;
  };
  const nextCorner = (t) => (t % 3 === 2 ? t - 2 : t + 1);

  // I en "figur" deler for- og bagside punkterne langs omridset. Hvis et smalt sted
  // i motivet kun er ét punkt tykt, ville det give en kant med 4 trekanter (en fejl
  // ved 3D-print). Sker det, fjerner vi ét punkt dér og prøver igen.
  let passes = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    passes++;
    // Punkter inde i motivet med en nabo udenfor ("kant-agtige" punkter)
    for (let j = 0, v = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++, v++) {
        nearEdge[v] =
          inside[v] &&
          (i === 0 || j === 0 || i === cols - 1 || j === rows - 1 ||
            !inside[v - 1] || !inside[v + 1] || !inside[v - cols] || !inside[v + cols] ||
            !inside[v - cols - 1] || !inside[v - cols + 1] || !inside[v + cols - 1] || !inside[v + cols + 1])
            ? 1
            : 0;
      }
    }

    tc = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const cc = a + cols;
        const d = cc + 1;
        const count = inside[a] + inside[b] + inside[cc] + inside[d];
        if (count < 3) continue;
        const hAB = a;
        const hCD = cc;
        const vAC = n + a;
        const vBD = n + b;
        const dAD = 2 * n + a;
        const dBC = 3 * n + a;
        if (count === 4) {
          // Undgå en diagonal mellem to kantpunkter – ellers vælg den, der følger overfladen bedst
          const adNear = nearEdge[a] && nearEdge[d];
          const bcNear = nearEdge[b] && nearEdge[cc];
          const useAD = adNear !== bcNear ? !adNear : Math.abs(raw[a] - raw[d]) <= Math.abs(raw[b] - raw[cc]);
          if (useAD) {
            pushTri(a, cc, d, vAC, hCD, dAD);
            pushTri(a, d, b, dAD, vBD, hAB);
          } else {
            pushTri(a, cc, b, vAC, dBC, hAB);
            pushTri(b, cc, d, dBC, hCD, vBD);
          }
        } else if (!inside[a]) pushTri(b, cc, d, dBC, hCD, vBD);
        else if (!inside[b]) pushTri(a, cc, d, vAC, hCD, dAD);
        else if (!inside[cc]) pushTri(a, d, b, dAD, vBD, hAB);
        else pushTri(a, cc, b, vAC, dBC, hAB);
      }
    }

    edgeCount.fill(0);
    for (let t = 0; t < tc; t++) edgeCount[triEdge[t]]++;
    used.fill(0);
    onBoundary.fill(0);
    boundaryEdges = [];
    for (let t = 0; t < tc; t++) {
      const p = tri[t];
      used[p] = 1;
      if (edgeCount[triEdge[t]] === 1) {
        const q = tri[nextCorner(t)];
        boundaryEdges.push(p, q);
        onBoundary[p] = onBoundary[q] = 1;
      }
    }
    if (!isFigure) break;

    // Indvendige kanter mellem to omrids-punkter → fjern det punkt, der har færrest naboer
    let removed = 0;
    for (let t = 0; t < tc; t++) {
      const p = tri[t];
      if (!onBoundary[p]) continue;
      const q = tri[nextCorner(t)];
      if (onBoundary[q] && inside[p] && inside[q] && edgeCount[triEdge[t]] === 2) {
        const pn = countInsideNeighbours(inside, cols, rows, p);
        const qn = countInsideNeighbours(inside, cols, rows, q);
        inside[pn <= qn ? p : q] = 0;
        removed++;
      }
    }
    if (!removed) break;
  }

  // "Pust op": løs Poisson-ligningen inde i motivet (kun for figurer)
  const poisson = isFigure ? solvePoisson(inside, cols, rows) : null;
  const edgeDist = distanceToEdge(inside, cols, rows);

  topoCache = {
    depth,
    mask,
    cols,
    rows,
    isFigure,
    inside,
    raw,
    tri,
    tc,
    used,
    onBoundary,
    boundaryEdges,
    poisson,
    edgeDist,
    passes,
  };
  return topoCache;
}

/**
 * Runder en figurs kanter af med "Taubin-udglatning" af punkterne tæt på omridset:
 * hvert punkt flyttes lidt mod gennemsnittet af sine naboer (λ-skridt) og derefter
 * lidt væk igen (μ-skridt). Så bliver den skarpe kant, hvor for- og bagside mødes,
 * rund – uden at figuren skrumper. Punkter længere inde end `band` røres ikke.
 */
function roundFigureEdges({ cols, rows, used, onBoundary, edgeDist, band, pairs, Fx, Fy, Fz, Bx, By, Bz }) {
  if (pairs <= 0) return;
  const n = cols * rows;
  let m = 0;
  for (let v = 0; v < n; v++) if (used[v] && edgeDist[v] - 1 < band) m++;
  const list = new Int32Array(m);
  const weight = new Float32Array(m); // 1 ved kanten → 0 ved "band"
  const nbr = new Int32Array(m * 4).fill(-1); // op til 4 naboer pr. punkt
  for (let v = 0, k = 0; v < n; v++) {
    if (!used[v] || edgeDist[v] - 1 >= band) continue;
    list[k] = v;
    weight[k] = 1 - smoothstep(0, band, edgeDist[v] - 1);
    const i = v % cols;
    let c = k * 4;
    if (i > 0 && used[v - 1]) nbr[c++] = v - 1;
    if (i < cols - 1 && used[v + 1]) nbr[c++] = v + 1;
    if (v >= cols && used[v - cols]) nbr[c++] = v - cols;
    if (v < n - cols && used[v + cols]) nbr[c++] = v + cols;
    k++;
  }
  const out = new Float32Array(m * 6);

  const step = (factor) => {
    for (let k = 0; k < m; k++) {
      const v = list[k];
      let fx = 0, fy = 0, fz = 0; // naboer på forsiden
      let bx = 0, by = 0, bz = 0; // naboer på bagsiden
      let count = 0;
      for (let q = k * 4; q < k * 4 + 4; q++) {
        const u = nbr[q];
        if (u < 0) break;
        fx += Fx[u]; fy += Fy[u]; fz += Fz[u];
        bx += Bx[u]; by += By[u]; bz += Bz[u];
        count++;
      }
      const o = k * 6;
      if (!count) {
        out[o] = Fx[v]; out[o + 1] = Fy[v]; out[o + 2] = Fz[v];
        out[o + 3] = Bx[v]; out[o + 4] = By[v]; out[o + 5] = Bz[v];
        continue;
      }
      const w = weight[k] * factor;
      if (onBoundary[v]) {
        // Fælles kantpunkt: trækkes mod gennemsnittet af naboerne på BÅDE for- og bagside
        const ax = (fx + bx) / (2 * count);
        const ay = (fy + by) / (2 * count);
        const az = (fz + bz) / (2 * count);
        out[o] = out[o + 3] = Fx[v] + w * (ax - Fx[v]);
        out[o + 1] = out[o + 4] = Fy[v] + w * (ay - Fy[v]);
        out[o + 2] = out[o + 5] = Fz[v] + w * (az - Fz[v]);
      } else {
        out[o] = Fx[v] + w * (fx / count - Fx[v]);
        out[o + 1] = Fy[v] + w * (fy / count - Fy[v]);
        out[o + 2] = Fz[v] + w * (fz / count - Fz[v]);
        out[o + 3] = Bx[v] + w * (bx / count - Bx[v]);
        out[o + 4] = By[v] + w * (by / count - By[v]);
        out[o + 5] = Bz[v] + w * (bz / count - Bz[v]);
      }
    }
    for (let k = 0; k < m; k++) {
      const v = list[k];
      const o = k * 6;
      Fx[v] = out[o]; Fy[v] = out[o + 1]; Fz[v] = out[o + 2];
      Bx[v] = out[o + 3]; By[v] = out[o + 4]; Bz[v] = out[o + 5];
    }
  };
  for (let p = 0; p < pairs; p++) {
    step(0.5);
    step(-0.53);
  }
}

/**
 * Afstand (i gitterceller) fra hvert punkt i motivet til nærmeste punkt udenfor
 * (billedets kant tæller også som "udenfor"). Hurtig "chamfer"-metode i to gennemløb.
 */
function distanceToEdge(inside, cols, rows) {
  const n = cols * rows;
  const dist = new Float32Array(n);
  const D = Math.SQRT2;
  for (let j = 0, v = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++, v++) {
      if (!inside[v]) continue;
      let d = Math.min(i + 1, j + 1, cols - i, rows - j);
      if (i > 0) d = Math.min(d, dist[v - 1] + 1);
      if (j > 0) {
        d = Math.min(d, dist[v - cols] + 1);
        if (i > 0) d = Math.min(d, dist[v - cols - 1] + D);
        if (i < cols - 1) d = Math.min(d, dist[v - cols + 1] + D);
      }
      dist[v] = d;
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const v = j * cols + i;
      if (!inside[v]) continue;
      let d = dist[v];
      if (i < cols - 1) d = Math.min(d, dist[v + 1] + 1);
      if (j < rows - 1) {
        d = Math.min(d, dist[v + cols] + 1);
        if (i < cols - 1) d = Math.min(d, dist[v + cols + 1] + D);
        if (i > 0) d = Math.min(d, dist[v + cols - 1] + D);
      }
      dist[v] = d;
    }
  }
  return dist;
}

/* ------------------------------------------------------------------ */
/* Hjælpefunktioner                                                    */
/* ------------------------------------------------------------------ */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Antal af de 8 nabopunkter, der er inde i motivet. */
function countInsideNeighbours(inside, cols, rows, v) {
  const i = v % cols;
  const j = (v - i) / cols;
  let count = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const x = i + di;
      const y = j + dj;
      if (x >= 0 && y >= 0 && x < cols && y < rows) count += inside[y * cols + x];
    }
  }
  return count;
}

/**
 * "Summed-area tables": gør det muligt at finde gennemsnittet af et vilkårligt
 * rektangel i billedet med kun 4 opslag. Tabellerne gemmes, så de ikke skal
 * regnes forfra, hver gang man trækker i en skyder.
 */
let areaCache = null;
function getAreaSums(depth, mask, w, h) {
  if (areaCache && areaCache.depthRef === depth && areaCache.maskRef === mask) return areaCache;
  const W = w + 1;
  const sumD = new Float64Array(W * (h + 1)); // sum af dybde (kun motiv-pixels, hvis der er en maske)
  const sumM = mask ? new Uint32Array(W * (h + 1)) : null; // antal motiv-pixels
  for (let y = 0; y < h; y++) {
    let rowD = 0;
    let rowM = 0;
    const src = y * w;
    const cur = (y + 1) * W + 1;
    const prev = y * W + 1;
    for (let x = 0; x < w; x++) {
      if (mask) {
        if (mask[src + x] >= 128) {
          rowD += depth[src + x];
          rowM++;
        }
        sumM[cur + x] = sumM[prev + x] + rowM;
      } else {
        rowD += depth[src + x];
      }
      sumD[cur + x] = sumD[prev + x] + rowD;
    }
  }
  areaCache = {
    depthRef: depth,
    maskRef: mask,
    depth: 0,
    coverage: 0,
    /** Gennemsnit i rektanglet omkring (cx, cy) – resultatet lægges i .depth og .coverage */
    mean(cx, cy, rx, ry) {
      const x0 = Math.max(0, Math.round(cx - rx));
      const x1 = Math.min(w, Math.round(cx + rx) + 1);
      const y0 = Math.max(0, Math.round(cy - ry));
      const y1 = Math.min(h, Math.round(cy + ry) + 1);
      const a = y1 * W + x1;
      const b = y0 * W + x1;
      const c = y1 * W + x0;
      const d = y0 * W + x0;
      const total = (x1 - x0) * (y1 - y0);
      const sd = sumD[a] - sumD[b] - sumD[c] + sumD[d];
      if (!sumM) {
        this.depth = sd / total;
        this.coverage = 1;
        return;
      }
      const count = sumM[a] - sumM[b] - sumM[c] + sumM[d];
      this.coverage = count / total;
      this.depth = count > 0 ? sd / count : 0;
    },
  };
  return areaCache;
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
