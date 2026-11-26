import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { measurementLandmarks, measurementLine } from "./measurementLine";
import type { BodyPath, BodyView } from "../../api";
import { applySkinTextures, bodyAnchors, loadHead, loadOutfit, skinGeometry, type HeadMesh, type Outfit, type SurfaceTopology } from "./appearance";

const BASE = new THREE.Color("#7b9fa7");
const HOT = new THREE.Color("#c25c35");
const CHANGED = new THREE.Color("#be5875");
const GHOST = new THREE.Color("#9c83c8");
const FOV = 28;
const PREVIEW_ZOOM = 0.88;
const GLOW_MS = 260;
const CAMERA_MS = 900;

const bodyVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-view.xyz);
    gl_Position = projectionMatrix * view;
  }
`;

const ghostFragment = /* glsl */ `
  uniform vec3 base;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - clamp(abs(dot(normalize(vNormal + 1e-6), normalize(vView))), 0.0, 1.0), 1.8);
    gl_FragColor = vec4(base, rim * 0.75);
  }
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
type PathLayer = { pid: string; line: Line2; reference: boolean; marks?: ReturnType<typeof measurementLandmarks> };
type CameraFrame = { position: THREE.Vector3; target: THREE.Vector3 };
export type BodyPreview = "loading" | "ready" | "fallback";

export function orbitFrame(from: CameraFrame, to: CameraFrame, t: number, minimumRadius: number) {
  const start = new THREE.Spherical().setFromVector3(from.position.clone().sub(from.target));
  const end = new THREE.Spherical().setFromVector3(to.position.clone().sub(to.target));
  const turn = Math.atan2(Math.sin(end.theta - start.theta), Math.cos(end.theta - start.theta));
  const radius = Math.max(minimumRadius, THREE.MathUtils.lerp(start.radius, end.radius, t));
  const target = from.target.clone().lerp(to.target, t);
  const position = new THREE.Vector3().setFromSphericalCoords(
    radius, THREE.MathUtils.lerp(start.phi, end.phi, t), start.theta + turn * t,
  ).add(target);
  return { target, position };
}

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
  onPreview: ((state: BodyPreview) => void) | null = null;
  private preview: BodyPreview = "loading";
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 30);
  private controls: OrbitControls;
  private geometry = new THREE.BufferGeometry();
  private ghostGeometry = new THREE.BufferGeometry();
  private bodyMaterial: THREE.MeshStandardMaterial;
  private skin: ReturnType<typeof skinGeometry> | null = null;
  private head: HeadMesh[] = [];
  private outfit: Outfit | null = null;
  private surface?: SurfaceTopology;
  private faces = new Uint32Array();
  private coverage: number[] = [];
  private depthScene = new THREE.Scene();
  private depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });
  private depthTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture: new THREE.DepthTexture(1, 1),
  });
  private depthViewport = new THREE.Vector2();
  private appearanceRequest = new AbortController();
  private contact = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.2), new THREE.ShaderMaterial({
    uniforms: { feet: { value: [new THREE.Vector2(), new THREE.Vector2()] } },
    vertexShader: `
      varying vec2 ground;
      void main() {
        ground = (modelMatrix * vec4(position, 1.0)).xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec2 feet[2];
      varying vec2 ground;
      void main() {
        vec2 a = (ground - feet[0]) / vec2(0.07, 0.15);
        vec2 b = (ground - feet[1]) / vec2(0.07, 0.15);
        float shadow = exp(-dot(a,a) * 2.0) + exp(-dot(b,b) * 2.0);
        float radius = length(ground);
        float thickness = max(fwidth(radius), 0.001);
        float inner = 1.0 - smoothstep(thickness, thickness * 2.0, abs(radius - 0.25));
        float outer = 1.0 - smoothstep(thickness, thickness * 2.0, abs(radius - 0.32));
        float sweep = sin(atan(ground.y, ground.x) * 24.0);
        float projection = (inner * 0.34 + outer * step(0.45, sweep) * 0.24);
        gl_FragColor = vec4(0.16, 0.55, 0.65, clamp(shadow * 0.34 + projection, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
  }));
  private ghostMaterial: THREE.ShaderMaterial;
  private body: THREE.Mesh | null = null;
  private ghost: THREE.Mesh | null = null;
  private change = new Float32Array();
  private highlight = new Float32Array();
  private paths = new THREE.Group();
  private layers: PathLayer[] = [];
  private masks: Record<string, Uint8Array> = {};
  private target: Float32Array | null = null;
  private glowFrom: Float32Array | null = null;
  private glowTarget: Float32Array | null = null;
  private glowTween: Tween | null = null;
  private displayPaths: Record<string, BodyPath[]> = {};
  private ghostTarget: Float32Array | null = null;
  private changed: Record<string, number> = {};
  private cameraFrom: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private cameraTo: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private cameraTween: Tween | null = null;
  private home: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private focus: string | null = null;
  private selection: string | null = null;
  private selectionView: BodyView | null = null;
  private bodyRadius = 0;
  private dragging = false;
  private reduced: boolean;
  private resolution = new THREE.Vector2(1, 1);
  private resizeObserver: ResizeObserver;
  private motionQuery: MediaQueryList;

  constructor(private host: HTMLElement) {
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced = this.motionQuery.matches;
    this.motionQuery.addEventListener("change", this.onMotionPreference);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = "body-hologram-canvas";
    this.canvas.style.visibility = "hidden";
    this.canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      this.setPreview("fallback");
    });
    this.canvas.addEventListener("webglcontextrestored", () => this.showFittedBody());
    host.appendChild(this.canvas);

    this.bodyMaterial = new THREE.MeshStandardMaterial({ color: BASE, roughness: 0.58, vertexColors: true });
    this.ghostMaterial = new THREE.ShaderMaterial({
      vertexShader: bodyVertex,
      fragmentShader: ghostFragment,
      uniforms: { base: { value: GHOST } },
      transparent: true,
      depthWrite: false,
    });

    // Studio light is fixed in the scene, so orbiting reveals the side and back contours.
    const hemisphere = new THREE.HemisphereLight("#fff8f0", "#9e8f88", 1.42);
    const key = new THREE.DirectionalLight("#fff4eb", 2.35);
    key.position.set(-2.5, 3.4, 2.2);
    const fill = new THREE.DirectionalLight("#edf2ff", 0.70);
    fill.position.set(2.8, 1.5, 1.4);
    const rim = new THREE.DirectionalLight("#d7ebf6", 1.42);
    rim.position.set(0.2, 2.9, -2.8);
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.visible = false;
    this.scene.add(hemisphere, key, fill, rim, this.contact);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera.position.set(0, 1, 4);
    this.camera.zoom = PREVIEW_ZOOM;
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

    this.scene.add(this.paths);
    const depthMesh = new THREE.Mesh(this.geometry, this.depthMaterial);
    depthMesh.frustumCulled = false;
    this.depthScene.add(depthMesh);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  get interacting() {
    return this.dragging;
  }

  setTopology(faces: Uint32Array, vertexCount: number, masks: Record<string, Uint8Array>, surface?: SurfaceTopology) {
    this.masks = masks;
    this.highlight = new Float32Array(vertexCount);
    this.change = new Float32Array(vertexCount);
    const index = new THREE.BufferAttribute(faces, 1);
    for (const geometry of [this.geometry, this.ghostGeometry]) {
      geometry.setIndex(index);
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    }
    this.surface = surface;
    this.faces = new Uint32Array(faces);
    this.ghost = new THREE.Mesh(this.ghostGeometry, this.ghostMaterial);
    this.ghost.frustumCulled = false;
    this.ghost.renderOrder = 2;
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    if (surface?.baseVertices) {
      const signal = this.appearanceRequest.signal;
      const indices = bodyAnchors(surface.baseVertices);
      void loadHead(indices, signal).then(head => {
        if (signal.aborted) {
          head.forEach(part => part.dispose());
          return;
        }
        this.head = head;
        for (const part of head) {
          part.mesh.visible = false;
          this.scene.add(part.mesh);
        }
        if (this.target) this.updateHead(this.geometry.getAttribute("position").array as Float32Array);
      }).catch(error => { if (!signal.aborted) console.error("Body Profile appearance", error); });
      void loadOutfit(indices, signal).then(outfit => {
        if (signal.aborted) { outfit.dispose(); return; }
        this.outfit = outfit;
        this.scene.add(outfit.mesh);
        this.buildDressedBody();
        this.showFittedBody();
      }).catch(error => {
        if (!signal.aborted) {
          console.error("Body Profile outfit", error);
          this.setPreview("fallback");
        }
      });
    } else {
      this.setPreview("fallback");
    }
  }

  /** A fitted body and its validated clothing are presented in the same frame. */
  setBody(vertices: Float32Array, paths: Record<string, BodyPath[]>) {
    if (!this.geometry.getAttribute("position")) return;
    this.target = vertices;
    this.displayPaths = paths;
    this.showFittedBody();
  }

  private setPreview(state: BodyPreview) {
    this.canvas.style.visibility = state === "ready" ? "visible" : "hidden";
    if (state === this.preview) return;
    this.preview = state;
    this.onPreview?.(state);
  }

  private buildDressedBody() {
    if (!this.outfit) return;
    const exposed: number[] = [], faceUV: number[] = [];
    const covered = this.outfit.covered;
    const atEdge = new Set<number>();
    const uv = this.surface?.uv;
    const sourceUV = this.surface?.faceUV;
    for (let i = 0; i < this.faces.length; i += 3) {
      const a = this.faces[i], b = this.faces[i + 1], c = this.faces[i + 2];
      if (covered.has(a) && covered.has(b) && covered.has(c)) continue;
      for (const vertex of [a, b, c]) if (covered.has(vertex)) atEdge.add(vertex);
      exposed.push(a, b, c);
      if (sourceUV) faceUV.push(sourceUV[i], sourceUV[i + 1], sourceUV[i + 2]);
    }
    // The asset's mask covers the chest, back and pelvis. Contact with hems is expected.
    this.coverage = [...covered].filter(vertex => !atEdge.has(vertex)).filter((_, index) => index % 16 === 0);
    if (uv && sourceUV) {
      this.skin = skinGeometry(exposed, uv, faceUV);
      applySkinTextures(this.bodyMaterial);
    }
    const visibleGeometry = this.skin?.geometry ?? new THREE.BufferGeometry();
    if (!this.skin) {
      visibleGeometry.setIndex(exposed);
      visibleGeometry.setAttribute("position", this.geometry.getAttribute("position"));
      visibleGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.highlight.length * 3), 3));
    }
    this.body = new THREE.Mesh(visibleGeometry, this.bodyMaterial);
    this.body.frustumCulled = false;
    this.scene.add(this.body);
    this.updatePaint();
  }

  setGhost(vertices: Float32Array | null, changed: Record<string, number> = {}) {
    this.ghostTarget = vertices;
    this.changed = changed;
    if (!this.ghost) return;
    this.ghost.visible = !!vertices;
    this.updateChange();
  }

  /** Highlight one parameter's region and measuring line. */
  setFocus(pid: string | null) {
    if (pid === this.focus) return;
    this.focus = pid;
    if (this.highlight.length) {
      this.glowFrom = this.highlight.slice();
      const mask = pid ? this.masks[pid] : null;
      this.glowTarget = new Float32Array(this.highlight.length);
      if (mask) for (let i = 0; i < mask.length; i++) this.glowTarget[i] = mask[i] / 255;
      this.glowTween = this.reduced ? null : { start: performance.now(), duration: GLOW_MS };
      if (!this.glowTween) this.applyGlow(1);
    }
    this.styleLayers();
    this.updateHairTape();
  }

  setSelection(pid: string | null, view: BodyView | null) {
    if (pid === this.selection && view === this.selectionView) return;
    this.selection = pid;
    this.selectionView = view;
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
      if (v.z < -1 || v.z > 1) continue;
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
    this.appearanceRequest.abort();
    this.head.forEach(part => part.dispose());
    this.outfit?.dispose();
    this.body?.geometry.dispose();
    this.depthTarget.dispose();
    this.depthMaterial.dispose();
    this.bodyMaterial.map?.dispose();
    this.bodyMaterial.bumpMap?.dispose();
    this.contact.geometry.dispose();
    this.contact.material.dispose();
    for (const m of [this.bodyMaterial, this.ghostMaterial]) m.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private onMotionPreference = () => {
    this.reduced = this.motionQuery.matches;
  };

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(this.depthViewport);
    this.depthTarget.setSize(this.depthViewport.x, this.depthViewport.y);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.resolution.set(w, h);
    for (const layer of this.layers) (layer.line.material as LineMaterial).resolution.copy(this.resolution);
    if (this.home && !this.selection && !this.dragging) this.frameBody(true);
  }

  private tick = () => {
    const now = performance.now();
    if (this.glowTween) {
      const t = Math.min(1, (now - this.glowTween.start) / this.glowTween.duration);
      this.applyGlow(ease(t));
      if (t >= 1) this.glowTween = null;
    }
    if (this.cameraTween && this.cameraFrom && this.cameraTo) {
      const t = ease(Math.min(1, (now - this.cameraTween.start) / this.cameraTween.duration));
      const frame = orbitFrame(this.cameraFrom, this.cameraTo, t, this.minimumCameraRadius());
      this.camera.position.copy(frame.position);
      this.controls.target.copy(frame.target);
      if (t >= 1) this.cameraTween = null;
    }
    this.controls.update();
    if (this.preview !== "ready") return;
    if (this.focus || this.layers.some(layer => layer.reference)) {
      this.renderer.setRenderTarget(this.depthTarget);
      this.renderer.render(this.depthScene, this.camera);
      this.renderer.setRenderTarget(null);
    }
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  };

  private showFittedBody() {
    const out = this.target;
    if (!out || !this.body || !this.outfit || this.renderer.getContext().isContextLost()) return;
    // Never paint the new vertices until the matching opaque outfit passes coverage.
    const position = this.geometry.getAttribute("position");
    if (out.length !== position.count * 3 || !out.every(Number.isFinite)) {
      this.setPreview("fallback");
      return;
    }
    (position.array as Float32Array).set(out);
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    const normal = this.geometry.getAttribute("normal").array as Float32Array;
    this.outfit.update(out, normal);
    if (!this.outfit.covers(out, normal, this.coverage)) {
      this.setPreview("fallback");
      return;
    }
    if (this.skin) {
      const skinPosition = this.skin.geometry.getAttribute("position");
      const skinNormal = this.skin.geometry.getAttribute("normal");
      this.skin.vertices.forEach((vertex, i) => {
        const j = vertex * 3;
        skinPosition.setXYZ(i, out[j], out[j + 1], out[j + 2]);
        skinNormal.setXYZ(i, normal[j], normal[j + 1], normal[j + 2]);
      });
      skinPosition.needsUpdate = true;
      skinNormal.needsUpdate = true;
    }
    if (!this.skin) this.body.geometry.setAttribute("normal", this.geometry.getAttribute("normal"));
    this.updateContact(out);
    this.buildLayers(this.displayPaths);
    this.updateHead(out);
    this.updateChange();
    const first = !this.home;
    this.frameBody(first);
    if (first && this.selection && this.selectionView) this.turnTo(this.viewFor(this.selection, this.selectionView));
    this.setPreview("ready");
  }

  private applyGlow(t: number) {
    if (!this.glowFrom || !this.glowTarget) return;
    for (let i = 0; i < this.highlight.length; i++) {
      this.highlight[i] = THREE.MathUtils.lerp(this.glowFrom[i], this.glowTarget[i], t);
    }
    this.updatePaint();
  }

  private updatePaint() {
    const attribute = (this.skin?.geometry ?? this.geometry).getAttribute("color");
    if (!attribute) return;
    const neutral = new THREE.Color(0xffffff);
    const changed = new THREE.Color("#b79aff");
    const color = new THREE.Color();
    for (let i = 0; i < attribute.count; i++) {
      const vertex = this.skin?.vertices[i] ?? i;
      color.copy(neutral).lerp(changed, this.change[vertex] * 0.58)
        .multiplyScalar(1 + this.highlight[vertex] * 0.30);
      attribute.setXYZ(i, color.r, color.g, color.b);
    }
    attribute.needsUpdate = true;
  }

  /** Match the saved comparison mesh to the current floor and height. */
  private updateChange() {
    this.change.fill(0);
    if (this.target && this.ghostTarget && this.ghost) {
      const position = this.ghostGeometry.getAttribute("position") as THREE.BufferAttribute;
      (position.array as Float32Array).set(standTo(this.ghostTarget, this.target));
      position.needsUpdate = true;
      this.ghostGeometry.computeVertexNormals();
      for (const [pid, weight] of Object.entries(this.changed)) {
        const mask = this.masks[pid];
        if (!mask || weight <= 0) continue;
        for (let i = 0; i < mask.length; i++) this.change[i] = Math.max(this.change[i], (mask[i] / 255) * weight);
      }
    }
    this.updatePaint();
  }

  private updateHead(body: Float32Array) {
    this.head.forEach(part => part.update(body));
    this.updateHairTape();
  }

  private updateHairTape() {
    const ring = this.layers.find(layer => layer.pid === "B01");
    const line = ring?.line.geometry.getAttribute("instanceStart");
    const height = this.focus === "B01" && line?.count ? line.getY(0) : undefined;
    this.head.forEach(part => part.focusTape(height));
  }

  private updateContact(body: Float32Array) {
    const floor = heightRange(body).min;
    const feet: THREE.Vector2[] = this.contact.material.uniforms.feet.value;
    const samples = [0, 0];
    feet.forEach(foot => foot.set(0, 0));
    for (let i = 0; i < body.length; i += 3) {
      if (body[i + 1] > floor + 0.04) continue;
      const side = body[i] < 0 ? 0 : 1;
      feet[side].x += body[i];
      feet[side].y += body[i + 2];
      samples[side]++;
    }
    feet.forEach((foot, side) => foot.divideScalar(samples[side] || 1));
    this.contact.position.y = floor - 0.003;
    this.contact.visible = true;
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
        const material = measurementLine(this.depthTarget.depthTexture!, this.depthViewport, this.camera);
        material.color.copy(path.below_floor ? CHANGED : reference ? BASE : HOT);
        material.linewidth = reference ? 1.6 : 2.6;
        material.resolution.copy(this.resolution);
        const line = new Line2(geometry, material);
        line.computeLineDistances();
        line.renderOrder = 3;
        this.paths.add(line);
        const marks = path.landmarks?.length ? measurementLandmarks(path.landmarks, material.color) : undefined;
        if (marks) this.paths.add(marks);
        this.layers.push({ pid, line, reference, marks });
      }
    }
    this.styleLayers();
  }

  private styleLayers() {
    for (const layer of this.layers) {
      const material = layer.line.material as LineMaterial;
      const active = layer.pid === this.focus;
      layer.line.visible = active || layer.reference || (this.focus === "E05" && layer.pid === "E01");
      if (layer.marks) layer.marks.visible = active;
      material.opacity = active ? 1 : 0.4;
      material.linewidth = active ? (layer.reference ? 2.4 : 2.8) : 1.4;
    }
  }

  private clearLayers() {
    for (const layer of this.layers) {
      layer.line.geometry.dispose();
      (layer.line.material as LineMaterial).dispose();
      this.paths.remove(layer.line);
      if (layer.marks) {
        layer.marks.geometry.dispose();
        layer.marks.material.dispose();
        this.paths.remove(layer.marks);
      }
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
    this.bodyRadius = Math.hypot(size.x * 0.5, size.z * 0.5);
    const vertical = size.y * 1.26 / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    const horizontal = vertical * Math.max(1, 0.62 / this.camera.aspect);
    const distance = Math.max(vertical, horizontal);
    this.home = {
      position: new THREE.Vector3(0, centre.y + size.y * 0.03, distance),
      target: new THREE.Vector3(0, centre.y - size.y * 0.01, 0),
    };
    if (instant || !this.cameraTo) {
      this.camera.position.copy(this.home.position);
      this.controls.target.copy(this.home.target);
      this.cameraTween = null;
    }
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
      ? Math.max(view === "head" ? 0.75 : 0.38, extent * 4.3)
      : Math.min(homeDistance, Math.max(homeDistance * 0.62, extent * 2.6));
    const target = close ? centre : new THREE.Vector3(centre.x * 0.5, THREE.MathUtils.lerp(this.home.target.y, centre.y, 0.6), 0);
    const position = target.clone().add(VIEW_DIRECTION[view].clone().normalize()
      .multiplyScalar(Math.max(distance, this.minimumCameraRadius())));
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

  private minimumCameraRadius() {
    return Math.max(this.controls.minDistance, this.bodyRadius + this.camera.near + 0.08);
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
