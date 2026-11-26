import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

export function measurementLine(depth: THREE.DepthTexture, viewport: THREE.Vector2, camera: THREE.PerspectiveCamera) {
  const material = new LineMaterial({ transparent: true, depthTest: false, depthWrite: false });
  material.uniforms.bodyDepth = { value: depth };
  material.uniforms.depthViewport = { value: viewport };
  material.uniforms.cameraClip = { value: new THREE.Vector2(camera.near, camera.far) };
  // The unclothed geometry contributes depth only, in an offscreen framebuffer.
  // That lets the front part of the tape stay solid even when it is under a shirt.
  material.vertexShader = "varying float tapeDistance;\nattribute float instanceDistanceStart;\nattribute float instanceDistanceEnd;\n" +
    material.vertexShader.replace("void main() {", `void main() {
      tapeDistance = position.y < 0.5 ? instanceDistanceStart : instanceDistanceEnd;
    `);
  material.fragmentShader = `
    uniform sampler2D bodyDepth;
    uniform vec2 depthViewport;
    uniform vec2 cameraClip;
    varying float tapeDistance;
    #include <packing>
  ` + material.fragmentShader.replace("gl_FragColor = vec4( diffuseColor.rgb, alpha );", `
    float surface = texture2D(bodyDepth, gl_FragCoord.xy / depthViewport).r;
    float surfaceZ = perspectiveDepthToViewZ(surface, cameraClip.x, cameraClip.y);
    float tapeZ = perspectiveDepthToViewZ(gl_FragCoord.z, cameraClip.x, cameraClip.y);
    if (surfaceZ - tapeZ > 0.018) {
      if (mod(tapeDistance, 0.033) > 0.019) discard;
      alpha *= 0.30;
    }
    gl_FragColor = vec4(diffuseColor.rgb, alpha);
  `);
  return material;
}


export function measurementLandmarks(points: [number, number, number][], color: THREE.Color) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
  const material = new THREE.ShaderMaterial({
    uniforms: { color: { value: color } },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 6.0;
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      void main() {
        float distance = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(mix(color, vec3(1.0), smoothstep(0.23, 0.37, distance)),
                            1.0 - smoothstep(0.38, 0.49, distance));
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const markers = new THREE.Points(geometry, material);
  markers.renderOrder = 4;
  return markers;
}
