/**
 * viewer.js – viser 3D-modellen med Three.js (drej, zoom og flyt med musen/fingrene).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Viewer {
  constructor(container) {
    this.container = container;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0); // gennemsigtig – baggrunden kommer fra CSS
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // Scene med blødt "studielys"
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30343f, 0.6));
    this.scene = scene;

    // Kamera med en lampe på "hovedet", så den side man kigger på altid er oplyst
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    camera.position.set(0, 0, 5);
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    headlight.position.set(0.6, 0.8, 1);
    camera.add(headlight);
    scene.add(camera);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 1.2;
    this.controls = controls;

    // Materiale 0 = forside (foto), materiale 1 = bagside (samme foto, lidt mørkere)
    this.materials = [
      new THREE.MeshStandardMaterial({ name: 'Forside', roughness: 0.8, metalness: 0 }),
      new THREE.MeshStandardMaterial({ name: 'Bagside', roughness: 0.85, metalness: 0, color: 0x9aa0a8 }),
    ];
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.materials);
    this.mesh.name = 'Foto3D';
    this.mesh.visible = false;
    this.aiGroup = null; // AI'ens 360°-model (se loadAIModel)
    this.showingAI = false;
    this.wireframe = false;
    scene.add(this.mesh);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Sæt fotoet som "maling" (tekstur) på modellen. */
  setTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.userData.mimeType = 'image/jpeg'; // giver mindre GLB-filer
    const old = this.materials[0].map;
    for (const m of this.materials) {
      m.map = texture;
      m.needsUpdate = true;
    }
    old?.dispose();
  }

  /** Udskift modellens form med nye data fra mesh.js. */
  setModel(data, { reframe = false } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    for (const gr of data.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g.computeVertexNormals();
    g.computeBoundingBox();
    const center = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-center.x, -center.y, -center.z);
    g.computeBoundingSphere();

    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mesh.visible = !this.showingAI;
    if (reframe) this.frame();
  }

  /**
   * Indlæs en færdig 3D-model fra AI'en (GLB-fil). Den centreres og skaleres,
   * så den længste side er 2 enheder – ligesom vores egne modeller.
   * @returns {Promise<{ triangles: number }>}
   */
  async loadAIModel(blob) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const url = URL.createObjectURL(blob);
    let gltf;
    try {
      gltf = await new GLTFLoader().loadAsync(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const group = new THREE.Group();
    group.name = 'AI-model';
    group.add(model);
    group.scale.setScalar(2 / Math.max(size.x, size.y, size.z, 1e-6));

    let triangles = 0;
    group.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of [].concat(o.material)) m.wireframe = this.wireframe;
    });

    this.clearAI();
    group.visible = this.showingAI;
    this.aiGroup = group;
    this.scene.add(group);
    return { triangles: Math.round(triangles) };
  }

  /**
   * Drej AI-modellen, så den side der svarer til fotoet vender mod kameraet.
   * AI'erne bruger hver deres retning for "forfra", så vi sammenligner modellens
   * omrids set fra 4 sider med motivets omrids på fotoet og vælger den bedste.
   * @param {Uint8Array} mask  motivets maske (0–255) i størrelsen width x height
   */
  alignAIToPhoto(mask, width, height) {
    if (!this.aiGroup) return null;
    const N = 48;
    // Motivets omrids på fotoet
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] < 128) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const photo = new Uint8Array(N * N);
    const pw = x1 - x0 + 1, ph = y1 - y0 + 1;
    const ps = (N - 2) / Math.max(pw, ph);
    const pox = (N - pw * ps) / 2, poy = (N - ph * ps) / 2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = Math.floor(x0 + (i + 0.5 - pox) / ps);
        const y = Math.floor(y0 + (j + 0.5 - poy) / ps);
        photo[j * N + i] = x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= 128 ? 1 : 0;
      }
    }

    // Modellens trekanter
    const tris = [];
    const v = new THREE.Vector3();
    this.aiGroup.rotation.y = 0;
    this.aiGroup.updateMatrixWorld(true);
    this.aiGroup.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      const idx = o.geometry.index;
      const pts = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        pts[i * 3] = v.x;
        pts[i * 3 + 1] = v.y;
        pts[i * 3 + 2] = v.z;
      }
      const count = idx ? idx.count : pos.count;
      for (let k = 0; k < count; k++) tris.push(idx ? idx.getX(k) : k, pts);
    });

    // Omrids set fra en vinkel (kameraet i retning (sin θ, 0, cos θ))
    const silhouette = (theta) => {
      const c = Math.cos(theta), s = Math.sin(theta);
      const uv = [];
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (let k = 0; k < tris.length; k += 2) {
        const p = tris[k + 1], i = tris[k] * 3;
        const u = p[i] * c - p[i + 2] * s;
        const w = -p[i + 1];
        uv.push(u, w);
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (w < v0) v0 = w;
        if (w > v1) v1 = w;
      }
      const sc = (N - 2) / Math.max(u1 - u0, v1 - v0);
      const ox = (N - (u1 - u0) * sc) / 2, oy = (N - (v1 - v0) * sc) / 2;
      const g = new Uint8Array(N * N);
      for (let k = 0; k < uv.length; k += 6) {
        const ax = (uv[k] - u0) * sc + ox, ay = (uv[k + 1] - v0) * sc + oy;
        const bx = (uv[k + 2] - u0) * sc + ox, by = (uv[k + 3] - v0) * sc + oy;
        const cx = (uv[k + 4] - u0) * sc + ox, cy = (uv[k + 5] - v0) * sc + oy;
        const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(d) < 1e-9) continue;
        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx)));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let j = minY; j <= maxY; j++) {
          for (let i = minX; i <= maxX; i++) {
            const px = i + 0.5, py = j + 0.5;
            const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
            const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
            if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) g[j * N + i] = 1;
          }
        }
      }
      return g;
    };
    const iou = (a, b) => {
      let both = 0, any = 0;
      for (let k = 0; k < a.length; k++) {
        both += a[k] & b[k];
        any += a[k] | b[k];
      }
      return any ? both / any : 0;
    };

    let best = { angle: 0, score: -1 };
    for (const deg of [0, 90, 180, 270]) {
      const score = iou(photo, silhouette((deg * Math.PI) / 180));
      if (score > best.score) best = { angle: deg, score };
    }
    this.aiGroup.rotation.y = (-best.angle * Math.PI) / 180;
    this.aiGroup.updateMatrixWorld(true);
    return best;
  }

  /** Fjern AI-modellen (fx når der tages et nyt billede). */
  clearAI() {
    if (!this.aiGroup) return;
    this.aiGroup.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      for (const m of [].concat(o.material)) {
        for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
        m.dispose();
      }
    });
    this.aiGroup.removeFromParent();
    this.aiGroup = null;
  }

  /** Vis AI-modellen (true) eller vores egen model (false). */
  showAI(on) {
    this.showingAI = on;
    if (this.aiGroup) this.aiGroup.visible = on;
    this.mesh.visible = !on && this.mesh.geometry.attributes.position !== undefined;
  }

  /** Det objekt, der vises lige nu. */
  get current() {
    return this.showingAI && this.aiGroup ? this.aiGroup : this.mesh;
  }

  /** Placér kameraet, så hele modellen kan ses (lidt fra siden, så man ser at den er 3D). */
  frame() {
    const target = this.current;
    if (target === this.mesh && !this.mesh.geometry.boundingBox) return;
    this.resize(); // layoutet kan lige have ændret sig (fx når panelet dukker op)
    const box = new THREE.Box3().setFromObject(target);
    const size = box.getSize(new THREE.Vector3());
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = Math.max(size.y / 2 / Math.tan(vHalf), size.x / 2 / Math.tan(hHalf)) * 1.25 + size.z / 2;
    const dir = new THREE.Vector3(0.3, 0.12, 1).normalize();
    this.camera.position.copy(dir.multiplyScalar(dist));
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setWireframe(on) {
    this.wireframe = on;
    for (const m of this.materials) m.wireframe = on;
    this.aiGroup?.traverse((o) => {
      if (o.isMesh) for (const m of [].concat(o.material)) m.wireframe = on;
    });
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }
}
