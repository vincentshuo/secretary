import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BodyPath, BodyView } from "../../api";

const BASE = new THREE.Color("#6fdcff");
const HOT = new THREE.Color("#ffb347");
const CHANGED = new THREE.Color("#ff5fa8");
const GHOST = new THREE.Color("#b49bff");
const FOV = 28;
const MORPH_MS = 520;
const GLOW_MS = 260;
const CAMERA_MS = 900;

const bodyVertex = /* glsl */ `
  attribute float glow;
  attribute float change;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vGlow;
  varying float vChange;
  varying float vHeight;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 view = viewMatrix * world;
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-view.xyz);
    vGlow = glow;
    vChange = change;
    vHeight = world.y;
    gl_Position = projectionMatrix * view;
  }
`;

const bodyFragment = /* glsl */ `
  uniform float time;
  uniform float motion;
  uniform float intensity;
  uniform vec3 base;
  uniform vec3 hot;
  uniform vec3 changed;
  uniform vec2 span;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vGlow;
  varying float vChange;
  varying float vHeight;
  void main() {
    float facing = clamp(abs(dot(normalize(vNormal + 1e-6), normalize(vView))), 0.0, 1.0);
    float rim = pow(1.0 - facing, 2.3);
    float lines = smoothstep(0.62, 1.0, 0.5 + 0.5 * sin(vHeight * 330.0 - time * 1.4 * motion));
    float h = (vHeight - span.x) / max(span.y - span.x, 0.001);
    float band = (fract(time * 0.07) * 1.4 - 0.2 - h) * 9.0;
    float sweep = motion * exp(-band * band);
    vec3 color = base * (0.03 + rim * 0.62 + lines * 0.05 + sweep * 0.18);
    color = mix(color, hot * (0.32 + rim * 1.1 + lines * 0.08), clamp(vGlow, 0.0, 1.0));
    color = mix(color, changed * (0.2 + rim * 0.75), clamp(vChange, 0.0, 1.0) * (1.0 - clamp(vGlow, 0.0, 1.0)));
    gl_FragColor = vec4(color * intensity, 1.0);
  }
`;

const ghostFragment = /* glsl */ `
  uniform vec3 base;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vGlow;
  varying float vChange;
  varying float vHeight;
  void main() {
    float rim = pow(1.0 - clamp(abs(dot(normalize(vNormal + 1e-6), normalize(vView))), 0.0, 1.0), 1.8);
    gl_FragColor = vec4(base * (0.05 + rim * 0.55), 1.0);
  }
`;

const particleVertex = /* glsl */ `
  attribute float phase;
  uniform float time;
  uniform float motion;
  uniform vec2 span;
  varying float vAlpha;
  void main() {
    float height = span.y - span.x;
    float t = fract(phase + time * 0.018 * motion);
    vec3 p = position;
    p.y = span.x + t * height * 1.05;
    vAlpha = sin(t * 3.14159) * 0.55;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = 2.2 * (3.0 / -view.z);
    gl_Position = projectionMatrix * view;
  }
`;

const particleFragment = /* glsl */ `
  uniform vec3 base;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(base * vAlpha * (1.0 - smoothstep(0.0, 0.5, d)), 1.0);
  }
`;

const floorFragment = /* glsl */ `
  uniform vec3 base;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float rings = (1.0 - smoothstep(0.0, 0.035, abs(fract(r * 6.0) - 0.5) - 0.46)) * (1.0 - r);
    float edge = 1.0 - smoothstep(0.0, 0.012, abs(r - 0.94));
    float pool = (1.0 - smoothstep(0.0, 0.85, r)) * 0.12;
    gl_FragColor = vec4(base * (rings * 0.16 + edge * 0.5 + pool), 1.0);
  }
`;

const floorVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

function heightRange(v: Float32Array) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < v.length; i += 3) {
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  return { min, max };
}

/** Scale a body vertically so it stands on the same floor and reaches the same height as `like`. */
export function standTo(body: Float32Array, like: Float32Array) {
  const from = heightRange(body);
  const to = heightRange(like);
  const scale = (to.max - to.min) / Math.max(from.max - from.min, 1e-6);
  const out = body.slice();
  for (let i = 1; i < out.length; i += 3) out[i] = to.min + (body[i] - from.min) * scale;
  return out;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

type Tween = { start: number; duration: number };
type PathLayer = { pid: string; line: Line2; reference: boolean };

const VIEW_DIRECTION: Record<BodyView, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0.04, 1),
  back: new THREE.Vector3(0, 0.08, -1),
  side: new THREE.Vector3(1, 0.04, 0.12),
  head: new THREE.Vector3(0.35, 0.08, 1),
  arm: new THREE.Vector3(0.75, 0.06, 0.7),
  hand: new THREE.Vector3(0.55, 0.15, 0.85),
};

export class Hologram {
  readonly canvas: HTMLCanvasElement;
  onFrame: (() => void) | null = null;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 30);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private clock = new THREE.Clock();
  private geometry = new THREE.BufferGeometry();
  private ghostGeometry = new THREE.BufferGeometry();
  private bodyMaterial: THREE.ShaderMaterial;
  private ghostMaterial: THREE.ShaderMaterial;
  private particleMaterial: THREE.ShaderMaterial;
  private body: THREE.Mesh | null = null;
  private ghost: THREE.Mesh | null = null;
  private occluder: THREE.Mesh | null = null;
  private floor: THREE.Mesh | null = null;
  private particles: THREE.Points | null = null;
  private paths = new THREE.Group();
  private layers: PathLayer[] = [];
  private masks: Record<string, Uint8Array> = {};
  private from: Float32Array | null = null;
  private target: Float32Array | null = null;
  private morph: Tween | null = null;
  private glowFrom: Float32Array | null = null;
  private glowTarget: Float32Array | null = null;
  private glowTween: Tween | null = null;
  private pendingPaths: Record<string, BodyPath[]> | null = null;
  private ghostTarget: Float32Array | null = null;
  private changed: Record<string, number> = {};
  private cameraFrom: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private cameraTo: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private cameraTween: Tween | null = null;
  private home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private span = new THREE.Vector2(0, 1.8);
  private focus: string | null = null;
  private dragging = false;
  private reduced: boolean;
  private frozenTime = 0;
  private resolution = new THREE.Vector2(1, 1);
  private resizeObserver: ResizeObserver;
  private motionQuery: MediaQueryList;

  constructor(private host: HTMLElement) {
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced = this.motionQuery.matches;
    this.motionQuery.addEventListener("change", this.onMotionPreference);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor("#03070c", 1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = "body-hologram-canvas";
    host.appendChild(this.canvas);

    const uniforms = () => ({
      time: { value: 0 },
      motion: { value: this.reduced ? 0 : 1 },
      intensity: { value: 1 },
      base: { value: BASE.clone() },
      hot: { value: HOT.clone() },
      changed: { value: CHANGED.clone() },
      span: { value: this.span },
    });
    this.bodyMaterial = new THREE.ShaderMaterial({
      vertexShader: bodyVertex,
      fragmentShader: bodyFragment,
      uniforms: uniforms(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
    });
    this.ghostMaterial = new THREE.ShaderMaterial({
      vertexShader: bodyVertex,
      fragmentShader: ghostFragment,
      uniforms: { ...uniforms(), base: { value: GHOST.clone() } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      uniforms: uniforms(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.camera.position.set(0, 1, 4);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 7;
    this.controls.enablePan = true;
    this.controls.addEventListener("start", () => {
      this.dragging = true;
      this.cameraTween = null;
    });
    this.controls.addEventListener("end", () => { this.dragging = false; });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.22, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.scene.add(this.paths);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  get interacting() {
    return this.dragging;
  }

  setTopology(faces: Uint32Array, vertexCount: number, masks: Record<string, Uint8Array>) {
    this.masks = masks;
    const index = new THREE.BufferAttribute(faces, 1);
    for (const g of [this.geometry, this.ghostGeometry]) {
      g.setIndex(index);
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      g.setAttribute("glow", new THREE.BufferAttribute(new Float32Array(vertexCount), 1));
      g.setAttribute("change", new THREE.BufferAttribute(new Float32Array(vertexCount), 1));
    }
    this.occluder = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 }));
    this.occluder.renderOrder = 0;
    this.body = new THREE.Mesh(this.geometry, this.bodyMaterial);
    this.body.renderOrder = 1;
    this.ghost = new THREE.Mesh(this.ghostGeometry, this.ghostMaterial);
    this.ghost.renderOrder = 2;
    this.ghost.visible = false;
    for (const mesh of [this.occluder, this.body, this.ghost]) {
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
  }

  /** Morph to a newly fitted body; measurement lines follow once the shape has settled. */
  setBody(vertices: Float32Array, paths: Record<string, BodyPath[]>) {
    if (!this.body) return;
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const first = !this.target;
    this.from = first ? vertices.slice() : (position.array as Float32Array).slice();
    this.target = vertices;
    this.pendingPaths = paths;
    this.morph = first || this.reduced ? null : { start: performance.now(), duration: MORPH_MS };
    if (!this.morph) this.applyMorph(1);
    if (first) this.frameBody();
    this.updateChange();
  }

  setGhost(vertices: Float32Array | null, changed: Record<string, number> = {}) {
    this.ghostTarget = vertices;
    this.changed = changed;
    if (!this.ghost) return;
    this.ghost.visible = !!vertices;
    this.updateChange();
  }

  /** Highlight one parameter's region and measuring line, and turn the camera to it. */
  setFocus(pid: string | null, view: BodyView | null) {
    if (pid === this.focus) return;
    this.focus = pid;
    const glow = this.geometry.getAttribute("glow") as THREE.BufferAttribute | undefined;
    if (glow) {
      this.glowFrom = (glow.array as Float32Array).slice();
      const mask = pid ? this.masks[pid] : null;
      this.glowTarget = new Float32Array(glow.count);
      if (mask) for (let i = 0; i < mask.length; i++) this.glowTarget[i] = mask[i] / 255;
      this.glowTween = this.reduced ? null : { start: performance.now(), duration: GLOW_MS };
      if (!this.glowTween) this.applyGlow(1);
    }
    this.styleLayers();
    if (!this.dragging) this.turnTo(pid && view ? this.viewFor(pid, view) : this.home);
  }

  /** Screen-space anchor of a parameter: its line or region point furthest toward the label. */
  anchor(pid: string, toward: "left" | "right" | "nearest", from?: { x: number; y: number }) {
    return this.project(pid, toward, this.camera, from);
  }

  /** The same anchor seen from the home view, so label layout does not chase the camera. */
  homeAnchor(pid: string, toward: "left" | "right") {
    if (!this.home) return null;
    const camera = this.camera.clone();
    camera.position.copy(this.home.position);
    camera.lookAt(this.home.target);
    camera.updateMatrixWorld();
    return this.project(pid, toward, camera);
  }

  private project(pid: string, toward: "left" | "right" | "nearest", camera: THREE.Camera, from?: { x: number; y: number }) {
    const candidates = this.anchorPoints(pid);
    if (!candidates.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best: { x: number; y: number } | null = null;
    let score = -Infinity;
    for (const p of candidates) {
      v.copy(p).project(camera);
      if (v.z > 1) continue;
      const x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      const s = toward === "left" ? -x : toward === "right" ? x : -Math.hypot(x - (from?.x ?? 0), y - (from?.y ?? 0));
      if (s > score) {
        score = s;
        best = { x, y };
      }
    }
    return best;
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.motionQuery.removeEventListener("change", this.onMotionPreference);
    this.controls.dispose();
    this.clearLayers();
    this.geometry.dispose();
    this.ghostGeometry.dispose();
    this.floor?.geometry.dispose();
    this.particles?.geometry.dispose();
    for (const m of [this.bodyMaterial, this.ghostMaterial, this.particleMaterial]) m.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private onMotionPreference = () => {
    this.reduced = this.motionQuery.matches;
    for (const m of [this.bodyMaterial, this.particleMaterial]) m.uniforms.motion.value = this.reduced ? 0 : 1;
  };

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.resolution.set(w, h);
    for (const layer of this.layers) (layer.line.material as LineMaterial).resolution.copy(this.resolution);
    if (this.home && !this.focus && !this.dragging) this.frameBody(true);
  }

  private tick = () => {
    const now = performance.now();
    if (!this.reduced) this.frozenTime = this.clock.getElapsedTime();
    for (const m of [this.bodyMaterial, this.particleMaterial]) m.uniforms.time.value = this.frozenTime;
    if (this.morph) {
      const t = Math.min(1, (now - this.morph.start) / this.morph.duration);
      this.applyMorph(ease(t));
      if (t >= 1) this.morph = null;
    }
    if (this.glowTween) {
      const t = Math.min(1, (now - this.glowTween.start) / this.glowTween.duration);
      this.applyGlow(ease(t));
      if (t >= 1) this.glowTween = null;
    }
    if (this.cameraTween && this.cameraFrom && this.cameraTo) {
      const t = ease(Math.min(1, (now - this.cameraTween.start) / this.cameraTween.duration));
      this.camera.position.lerpVectors(this.cameraFrom.position, this.cameraTo.position, t);
      this.controls.target.lerpVectors(this.cameraFrom.target, this.cameraTo.target, t);
      if (t >= 1) this.cameraTween = null;
    }
    if (!this.reduced) {
      for (const layer of this.layers) {
        const material = layer.line.material as LineMaterial;
        if (material.dashed) material.dashOffset -= 0.0009;
      }
    }
    this.controls.update();
    this.composer.render();
    this.onFrame?.();
  };

  private applyMorph(t: number) {
    if (!this.from || !this.target) return;
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = position.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = this.from[i] + (this.target[i] - this.from[i]) * t;
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    if (t >= 1 && this.pendingPaths) {
      this.buildLayers(this.pendingPaths);
      this.pendingPaths = null;
    }
  }

  private applyGlow(t: number) {
    if (!this.glowFrom || !this.glowTarget) return;
    const glow = this.geometry.getAttribute("glow") as THREE.BufferAttribute;
    const out = glow.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = this.glowFrom[i] + (this.glowTarget[i] - this.glowFrom[i]) * t;
    glow.needsUpdate = true;
  }

  /** The ghost stands to the current height; the glow marks parameters whose recorded value changed. */
  private updateChange() {
    const change = this.geometry.getAttribute("change") as THREE.BufferAttribute | undefined;
    if (!change) return;
    const out = change.array as Float32Array;
    out.fill(0);
    if (this.target && this.ghostTarget && this.ghost) {
      const position = this.ghostGeometry.getAttribute("position") as THREE.BufferAttribute;
      (position.array as Float32Array).set(standTo(this.ghostTarget, this.target));
      position.needsUpdate = true;
      this.ghostGeometry.computeVertexNormals();
      for (const [pid, weight] of Object.entries(this.changed)) {
        const mask = this.masks[pid];
        if (!mask || weight <= 0) continue;
        for (let i = 0; i < mask.length; i++) out[i] = Math.max(out[i], (mask[i] / 255) * weight);
      }
    }
    change.needsUpdate = true;
  }

  private buildLayers(paths: Record<string, BodyPath[]>) {
    this.clearLayers();
    for (const [pid, items] of Object.entries(paths)) {
      const reference = ["D11", "D12", "H18", "H15", "F13"].includes(pid);
      for (const path of items) {
        const pts = path.points.slice();
        if (path.closed && pts.length) pts.push(pts[0]);
        if (pts.length < 2) continue;
        const geometry = new LineGeometry();
        geometry.setPositions(pts.flat());
        const material = new LineMaterial({
          color: (path.below_floor ? CHANGED : reference ? BASE : HOT).getHex(),
          linewidth: reference ? 1.6 : 2.6,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          dashed: !reference,
          dashSize: 0.014,
          gapSize: 0.006,
          worldUnits: false,
        });
        material.resolution.copy(this.resolution);
        const line = new Line2(geometry, material);
        line.computeLineDistances();
        line.renderOrder = 3;
        this.paths.add(line);
        this.layers.push({ pid, line, reference });
      }
    }
    this.styleLayers();
  }

  private styleLayers() {
    for (const layer of this.layers) {
      const material = layer.line.material as LineMaterial;
      const active = layer.pid === this.focus;
      layer.line.visible = active || layer.reference;
      material.opacity = active ? 1 : 0.4;
      material.linewidth = active ? (layer.reference ? 2.4 : 2.8) : 1.4;
    }
  }

  private clearLayers() {
    for (const layer of this.layers) {
      layer.line.geometry.dispose();
      (layer.line.material as LineMaterial).dispose();
      this.paths.remove(layer.line);
    }
    this.layers = [];
  }

  private anchorPoints(pid: string): THREE.Vector3[] {
    const fromLines = this.layers.filter(l => l.pid === pid);
    const out: THREE.Vector3[] = [];
    for (const layer of fromLines) {
      const start = layer.line.geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
      const step = Math.max(1, Math.floor(start.count / 24));
      for (let i = 0; i < start.count; i += step) out.push(new THREE.Vector3(start.getX(i), start.getY(i), start.getZ(i)));
    }
    if (out.length) return out;
    const mask = this.masks[pid];
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!mask || !position) return out;
    const strong: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i] > 200) strong.push(i);
    const pool = strong.length ? strong : Array.from(mask.keys()).filter(i => mask[i] > 0);
    const step = Math.max(1, Math.floor(pool.length / 48));
    for (let k = 0; k < pool.length; k += step) {
      const i = pool[k];
      out.push(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
    }
    return out;
  }

  private bounds() {
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const box = new THREE.Box3().setFromBufferAttribute(position);
    return box;
  }

  private frameBody(instant = false) {
    const box = this.bounds();
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    this.span.set(box.min.y, box.max.y);
    const vertical = size.y * 1.26 / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    const horizontal = vertical * Math.max(1, 0.62 / this.camera.aspect);
    const distance = Math.max(vertical, horizontal);
    this.home = {
      position: new THREE.Vector3(0, centre.y + size.y * 0.03, distance),
      target: new THREE.Vector3(0, centre.y - size.y * 0.01, 0),
    };
    this.ensureStage(box);
    if (instant || !this.cameraTo) {
      this.camera.position.copy(this.home.position);
      this.controls.target.copy(this.home.target);
      this.cameraTween = null;
    }
  }

  private ensureStage(box: THREE.Box3) {
    if (this.floor) return;
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z) * 0.6 + 0.15;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(radius * 2, radius * 2),
      new THREE.ShaderMaterial({
        vertexShader: floorVertex,
        fragmentShader: floorFragment,
        uniforms: { base: { value: BASE.clone() } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = box.min.y - 0.002;
    this.floor = floor;
    this.scene.add(floor);

    const count = 900;
    const positions = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.18 + Math.pow(Math.random(), 0.6) * radius * 0.8;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = Math.sin(a) * r;
      phase[i] = Math.random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
    this.particles = new THREE.Points(geometry, this.particleMaterial);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  private viewFor(pid: string, view: BodyView) {
    if (!this.home) return null;
    const points = this.maskPoints(pid, view === "arm" || view === "hand");
    if (!points.length) return this.home;
    const box = new THREE.Box3().setFromPoints(points);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.12);
    const close = view === "head" || view === "hand";
    const homeDistance = this.home.position.distanceTo(this.home.target);
    const distance = close
      ? Math.max(0.75, extent * 4.6)
      : Math.min(homeDistance, Math.max(homeDistance * 0.62, extent * 2.6));
    const target = close ? centre : new THREE.Vector3(centre.x * 0.5, THREE.MathUtils.lerp(this.home.target.y, centre.y, 0.6), 0);
    const position = target.clone().add(VIEW_DIRECTION[view].clone().normalize().multiplyScalar(distance));
    return { position, target };
  }

  private maskPoints(pid: string, leftSide: boolean) {
    const mask = this.masks[pid];
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const out: THREE.Vector3[] = [];
    if (!mask || !position) return out;
    let peak = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > peak) peak = mask[i];
    const floor = Math.max(1, peak * 0.55);
    for (let i = 0; i < mask.length; i += 3) {
      if (mask[i] < floor) continue;
      const x = position.getX(i);
      if (leftSide && x < 0) continue;
      out.push(new THREE.Vector3(x, position.getY(i), position.getZ(i)));
    }
    return out;
  }

  private turnTo(goal: { position: THREE.Vector3; target: THREE.Vector3 } | null) {
    if (!goal) return;
    this.cameraFrom = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    this.cameraTo = { position: goal.position.clone(), target: goal.target.clone() };
    if (this.reduced) {
      this.camera.position.copy(goal.position);
      this.controls.target.copy(goal.target);
      this.cameraTween = null;
      return;
    }
    this.cameraTween = { start: performance.now(), duration: CAMERA_MS };
  }
}
