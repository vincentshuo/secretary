import * as THREE from "three";

const asset = (file: string) => new URL("./body-appearance/" + file, document.baseURI).href;

function texture(file: string, color = true) {
  const image = new THREE.TextureLoader().load(asset(file));
  if (color) image.colorSpace = THREE.SRGBColorSpace;
  image.anisotropy = 4;
  return image;
}

export type SurfaceTopology = {
  uv?: Float32Array;
  faceUV?: Uint32Array;
  baseVertices?: Uint32Array;
};

export function skinGeometry(faces: ArrayLike<number>, uv: Float32Array, faceUV: ArrayLike<number>) {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [], coordinates: number[] = [];
  const indices = new Uint32Array(faces.length);
  const corners = new Map<number, number>();
  for (let i = 0; i < faces.length; i++) {
    const textureIndex = faceUV[i];
    const key = faces[i] * (uv.length / 2) + textureIndex;
    let index = corners.get(key);
    if (index === undefined) {
      index = vertices.length;
      corners.set(key, index);
      vertices.push(faces[i]);
      coordinates.push(uv[textureIndex * 2], uv[textureIndex * 2 + 1]);
    }
    indices[i] = index;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(coordinates, 2));
  for (const attribute of ["position", "normal", "color"]) {
    geometry.setAttribute(attribute, new THREE.BufferAttribute(new Float32Array(vertices.length * 3), 3));
  }
  return { geometry, vertices };
}

export function applySkinTextures(material: THREE.MeshStandardMaterial) {
  material.color.set(0xffffff);
  material.map = texture("skin.png");
  material.bumpMap = texture("skin-detail.png", false);
  material.bumpMap.wrapS = material.bumpMap.wrapT = THREE.RepeatWrapping;
  material.bumpMap.repeat.set(12, 12);
  material.bumpScale = 0.00013;
  material.needsUpdate = true;
}

const dither = "fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))";

function headMaterial(detail: HeadPart, tape: { value: number }) {
  const eyes = detail === "eyes";
  const material = new THREE.MeshStandardMaterial({
    map: texture(detail + ".png"),
    roughness: eyes ? 0.59 : detail === "hair" ? 0.73 : 0.85,
    alphaTest: eyes ? 0.5 : 0.36,
    side: eyes ? THREE.FrontSide : THREE.DoubleSide,
  });
  if (detail === "hair") {
    material.onBeforeCompile = shader => {
      shader.uniforms.tapeHeight = tape;
      shader.vertexShader = "varying float hairHeight;\n" + shader.vertexShader.replace(
        "#include <begin_vertex>", "#include <begin_vertex>\nhairHeight = position.y;",
      );
      shader.fragmentShader = "varying float hairHeight;\nuniform float tapeHeight;\n" +
        shader.fragmentShader.replace("#include <alphatest_fragment>", `
          #include <alphatest_fragment>
          float coverage = mix(0.18, 1.0, smoothstep(0.006, 0.026, abs(hairHeight - tapeHeight)));
          if (${dither} >= coverage) discard;
        `);
    };
  }
  return material;
}

export type BodyAnchorMap = Map<number, number>;

export function bodyAnchors(baseVertices: Uint32Array): BodyAnchorMap {
  return new Map(Array.from(baseVertices, (id, index) => [id, index]));
}

function resolveAnchor(indices: BodyAnchorMap, id: number) {
  const index = indices.get(id);
  if (index === undefined) throw Error("Missing MakeHuman vertex " + id);
  return index * 3;
}

type HeadPart = "eyes" | "hair" | "brows";
type Axis = [number, number, number];
type Binding = {
  uv: number[];
  indices: number[];
  vertices: number[];
  anchors: number[];
  weights: number[];
  offsets: number[];
  scales: [Axis, Axis, Axis];
};

export class HeadMesh {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private anchors: number[];
  private scales: [Axis, Axis, Axis];
  private positions: Float32Array;
  private tape = { value: -100 };

  constructor(name: HeadPart, private binding: Binding, indices: Map<number, number>) {
    const resolve = (id: number) => resolveAnchor(indices, id);
    this.anchors = binding.anchors.map(resolve);
    this.scales = binding.scales.map(([a, b, length]) => [resolve(a), resolve(b), length]) as [Axis, Axis, Axis];
    this.positions = new Float32Array(binding.anchors.length);
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(binding.indices);
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(binding.uv, 2));
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(binding.vertices.length * 3), 3));

    const material = headMaterial(name, this.tape);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  focusTape(height?: number) { this.tape.value = height ?? -100; }

  /** Refit the upstream hm08 attachment weights and axis-scaled offsets in Three coordinates. */
  update(body: Float32Array) {
    const { weights, offsets, vertices } = this.binding;
    const scale = this.scales.map(([a, b, length], axis) => Math.abs(body[a + axis] - body[b + axis]) / length);
    for (let i = 0; i < this.anchors.length; i += 3) {
      const a = this.anchors[i], b = this.anchors[i + 1], c = this.anchors[i + 2];
      for (let axis = 0; axis < 3; axis++) {
        this.positions[i + axis] = body[a + axis] * weights[i] + body[b + axis] * weights[i + 1] +
          body[c + axis] * weights[i + 2] + scale[axis] * offsets[i + axis];
      }
    }
    const position = this.mesh.geometry.getAttribute("position");
    for (let i = 0; i < vertices.length; i++) {
      const p = vertices[i] * 3;
      position.setXYZ(i, this.positions[p], this.positions[p + 1], this.positions[p + 2]);
    }
    position.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.visible = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
  }
}

export async function loadHead(indices: BodyAnchorMap, signal: AbortSignal) {
  const response = await fetch(asset("bindings.json"), { signal });
  if (!response.ok) throw Error("MakeHuman appearance assets could not load");
  const bindings: Record<HeadPart, Binding> = await response.json();
  return (["eyes", "hair", "brows"] as const).map(name => new HeadMesh(name, bindings[name], indices));
}


type GarmentBinding = {
  indices: number[];
  surface_faces: number[];
  vertices: number[];
  uv: number[];
  anchors: number[];
  weights: number[];
  clearance: number[];
  covered: number[];
};

export class Outfit {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private anchors: Uint32Array;
  private surface = new THREE.BufferGeometry();
  readonly covered: ReadonlySet<number>;

  constructor(private binding: GarmentBinding, indices: BodyAnchorMap, material: THREE.MeshStandardMaterial) {
    this.covered = new Set(binding.covered.map(id => resolveAnchor(indices, id) / 3));
    if (!this.covered.size || !binding.surface_faces.length || !binding.indices.length) {
      throw Error("Incomplete outfit coverage");
    }
    this.anchors = Uint32Array.from(binding.anchors, id => resolveAnchor(indices, id));
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(binding.indices);
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(binding.uv, 2));
    for (const name of ["position", "normal"]) {
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(binding.vertices.length * 3), 3));
    }
    this.surface.setIndex(binding.surface_faces);
    this.surface.setAttribute("position", new THREE.BufferAttribute(new Float32Array(binding.anchors.length), 3));
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  update(body: Float32Array, normals: Float32Array) {
    const position = this.surface.getAttribute("position");
    const { weights, clearance } = this.binding;
    for (let vertex = 0; vertex < clearance.length; vertex++) {
      const i = vertex * 3;
      const a = this.anchors[i], b = this.anchors[i + 1], c = this.anchors[i + 2];
      const wa = weights[i], wb = weights[i + 1], wc = weights[i + 2];
      const x = normals[a] * wa + normals[b] * wb + normals[c] * wc;
      const y = normals[a + 1] * wa + normals[b + 1] * wb + normals[c + 1] * wc;
      const z = normals[a + 2] * wa + normals[b + 2] * wb + normals[c + 2] * wc;
      const gap = clearance[vertex] / Math.max(Math.hypot(x, y, z), 0.35);
      position.setXYZ(vertex,
        body[a] * wa + body[b] * wb + body[c] * wc + x * gap,
        body[a + 1] * wa + body[b + 1] * wb + body[c + 1] * wc + y * gap,
        body[a + 2] * wa + body[b + 2] * wb + body[c + 2] * wc + z * gap);
    }
    // The normals must be shared across the UV seams of the shirt and jeans.
    this.surface.computeVertexNormals();
    const surfaceNormal = this.surface.getAttribute("normal");
    const drawPosition = this.mesh.geometry.getAttribute("position");
    const drawNormal = this.mesh.geometry.getAttribute("normal");
    this.binding.vertices.forEach((source, vertex) => {
      drawPosition.setXYZ(vertex, position.getX(source), position.getY(source), position.getZ(source));
      drawNormal.setXYZ(vertex, surfaceNormal.getX(source), surfaceNormal.getY(source), surfaceNormal.getZ(source));
    });
    drawPosition.needsUpdate = true;
    drawNormal.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.visible = true;
  }

  /** Check the interior of the upstream clothing mask for exposed skin. */
  covers(body: Float32Array, normals: Float32Array, interior: number[]) {
    const raycaster = new THREE.Raycaster();
    const normal = new THREE.Vector3();
    const origin = new THREE.Vector3();
    raycaster.near = 0;
    raycaster.far = 0.192;
    // The protected body faces are already omitted. A small tolerance allows
    // the fabric to sit close to the fitted skin without failing the preview.
    for (const vertex of interior) {
      const i = vertex * 3;
      normal.fromArray(normals, i);
      origin.fromArray(body, i).addScaledVector(normal, 0.18);
      if (!Number.isFinite(origin.lengthSq()) || normal.lengthSq() < 0.5) return false;
      raycaster.set(origin, normal.negate());
      if (raycaster.intersectObject(this.mesh, false).length) continue;
      // At the underarm and crotch the averaged skin normal can point along the garment opening.
      const point = new THREE.Vector3().fromArray(body, i);
      const reachable = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)]
        .some(direction => {
          raycaster.set(origin.copy(point).addScaledVector(direction, 0.18), direction.negate());
          return raycaster.intersectObject(this.mesh, false).length > 0;
        });
      if (!reachable) return false;
    }
    return true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.surface.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.normalMap?.dispose();
    this.mesh.material.aoMap?.dispose();
    this.mesh.material.dispose();
  }
}

export async function loadOutfit(indices: BodyAnchorMap, signal: AbortSignal) {
  const response = await fetch(asset("outfit.json"), { signal });
  if (!response.ok) throw Error("MakeHuman outfit could not load");
  const binding: GarmentBinding = await response.json();
  const loader = new THREE.TextureLoader();
  const channels = ["diffuse", "normal", "ao"] as const;
  const maps = await Promise.allSettled(channels.map(channel => loader.loadAsync(asset(`outfit-${channel}.png`))));
  const textures = maps.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  try {
    if (signal.aborted) throw signal.reason;
    if (textures.length !== channels.length) throw Error("MakeHuman outfit textures could not load");
    const [map, normalMap, aoMap] = textures;
    map.colorSpace = THREE.SRGBColorSpace;
    for (const image of textures) image.anisotropy = 4;
    const material = new THREE.MeshStandardMaterial({ map, normalMap, aoMap, roughness: 0.89 });
    try {
      return new Outfit(binding, indices, material);
    } catch (error) {
      material.dispose();
      throw error;
    }
  } catch (error) {
    textures.forEach(image => image.dispose());
    throw error;
  }
}
