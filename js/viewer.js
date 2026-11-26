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
    this.mesh.visible = true;
    if (reframe) this.frame();
  }

  /** Placér kameraet, så hele modellen kan ses (lidt fra siden, så man ser at den er 3D). */
  frame() {
    const box = this.mesh.geometry.boundingBox;
    if (!box) return;
    this.resize(); // layoutet kan lige have ændret sig (fx når panelet dukker op)
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
    for (const m of this.materials) m.wireframe = on;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }
}
