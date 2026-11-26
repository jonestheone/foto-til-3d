/**
 * export.js – gemmer modellen som fil.
 *
 *  GLB = 3D-model med farver (kan åbnes i fx Windows "3D Viewer", Blender,
 *        Sketchfab eller sættes ind i PowerPoint).
 *  STL = kun formen, i millimeter (til 3D-printere / slicere som Cura og PrusaSlicer).
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

export async function exportGLB(mesh) {
  // Kopi med "almindelige" materialer (fx uden trådnet)
  const materials = mesh.material.map((m) => {
    const c = m.clone();
    c.wireframe = false;
    return c;
  });
  const copy = new THREE.Mesh(mesh.geometry, materials);
  copy.name = 'Foto3D';
  const buffer = await new GLTFExporter().parseAsync(copy, { binary: true, maxTextureSize: 2048 });
  materials.forEach((m) => m.dispose());
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

/**
 * @param {THREE.Mesh} mesh
 * @param {number} sizeMM  længste side i millimeter
 */
export function exportSTL(mesh, sizeMM = 100) {
  const g = mesh.geometry.clone();
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  const s = sizeMM / Math.max(size.x, size.y, size.z);
  g.scale(s, s, s);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  // Centrér, og læg bagsiden på printpladen (z = 0). Forsiden vender opad.
  g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
  const data = new STLExporter().parse(new THREE.Mesh(g), { binary: true });
  g.dispose();
  return new Blob([data], { type: 'model/stl' });
}

/**
 * STL af AI'ens 360°-model. Den skal stå op på printpladen: i GLB-filer er "op" y,
 * men 3D-printere bruger z, så modellen vippes 90°.
 * @param {THREE.Object3D} object
 * @param {number} sizeMM  længste side i millimeter
 */
export function exportSTLStanding(object, sizeMM = 100) {
  const root = new THREE.Group();
  root.add(object.clone());
  root.rotation.x = Math.PI / 2; // y (op i GLB) → z (op på printeren)
  root.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  root.scale.setScalar(sizeMM / Math.max(size.x, size.y, size.z));
  root.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(root);
  // Centrér, og stil modellen på printpladen (z = 0)
  root.position.set(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z);
  root.updateMatrixWorld(true);
  const data = new STLExporter().parse(root, { binary: true });
  return new Blob([data], { type: 'model/stl' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
