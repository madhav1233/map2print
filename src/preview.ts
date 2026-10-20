/**
 * Three.js preview of the generated parts, coloured by layer.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PartId } from './core/types';

export interface PreviewPart {
  id: PartId;
  color: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export class Preview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  private controls: OrbitControls;
  private model = new THREE.Group();
  private meshes = new Map<PartId, THREE.Mesh>();
  private frame = 0;
  private resizeObserver: ResizeObserver;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    el.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xf4f6f0, 0x6b6656, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-0.6, 1, 0.45);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8f0, 0.5);
    fill.position.set(0.7, 0.4, -0.6);
    this.scene.add(fill);

    this.model.rotation.x = -Math.PI / 2; // model is Z-up, three.js is Y-up
    this.scene.add(this.model);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.addEventListener('change', () => this.requestRender());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el);
    this.resize();
  }

  setParts(parts: PreviewPart[], sizeMm: [number, number, number]): void {
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.model.remove(m);
    }
    this.meshes.clear();
    const [W, H] = sizeMm;
    for (const p of parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(p.indices, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.color),
        roughness: 0.82,
        metalness: 0,
        flatShading: true,
        polygonOffset: p.id === 'terrain',
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(-W / 2, -H / 2, 0);
      this.model.add(mesh);
      this.meshes.set(p.id, mesh);
    }
    const d = Math.max(W, H);
    this.camera.near = d / 100;
    this.camera.far = d * 20;
    this.camera.position.set(-d * 0.55, d * 0.85, d * 1.05);
    this.controls.target.set(0, sizeMm[2] * 0.15, 0);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  setColor(id: PartId, color: string): void {
    const m = this.meshes.get(id);
    if (!m) return;
    (m.material as THREE.MeshStandardMaterial).color.set(color);
    this.requestRender();
  }

  resize(): void {
    const w = this.el.clientWidth || 1;
    const h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (moving) this.requestRender();
    });
  }
}
