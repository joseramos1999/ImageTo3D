// Effects that animations can drive through the fx hooks (animations.js), beyond moving and
// scaling pieces. All are set fresh every frame (resetPose turns them off first), so they are
// as deterministic as the poses:
//   deform(type, amount, phase)  — bends the whole logo in the vertex shader: wave, jelly,
//                                  twist, bend, slices (a glitch). Normals follow (Jacobian).
//   dissolve(amount, style)      — the surface burns away along a noise front with a glowing
//                                  edge, shedding particles ('particles') or smoke ('smoke').
//   outline(progress, opacity)   — glowing ribbons draw each piece's outline.
//   portal(progress)             — a glowing ring the logo comes through (with a depth clip).
//   shine(position, strength)    — drives the shine band (the «Destello» sweep) directly.
//   opacity(value) / glow(value) — fades the logo / makes it glow in its own colours.
//   camera({ zoom, orbit, height }) / light({ az, el, gain }) — on top of the user's framing
//                                  and lighting (keyframes, keys.js).
import * as THREE from 'three';
import { PORTAL_Z } from './animations.js';

export const DEFORM = { wave: 1, jelly: 2, twist: 3, bend: 4, slices: 5 };

// The same noise in JS (particles) and GLSL (surface), so each particle leaves exactly where
// the burning front passes it. A left-to-right sweep with some smooth wobble; ~0..1.
const NOISE_GLSL = `
float fxNoise(vec3 p) {
  float n = 0.5 + 0.3 * (p.x / 2.2) - 0.08 * (p.y / 1.5)
    + 0.09 * sin(p.x * 2.3 + p.y * 1.7 + 0.5)
    + 0.06 * sin(p.y * 4.1 - p.z * 2.3 + p.x * 0.9)
    + 0.04 * sin(p.x * 9.1 + p.y * 7.3 + p.z * 5.7);
  return clamp(n, 0.0, 1.0);
}`;
export function fxNoise(x, y, z) {
  const n = 0.5 + 0.3 * (x / 2.2) - 0.08 * (y / 1.5)
    + 0.09 * Math.sin(x * 2.3 + y * 1.7 + 0.5)
    + 0.06 * Math.sin(y * 4.1 - z * 2.3 + x * 0.9)
    + 0.04 * Math.sin(x * 9.1 + y * 7.3 + z * 5.7);
  return Math.max(0, Math.min(1, n));
}

const DEFORM_GLSL = `
uniform float uFxType, uFxAmt, uFxPhase, uFxScale;
uniform mat4 uFxLogo, uFxLogoInv;
float fxHash(float n) { return fract(sin(n * 91.345 + 47.853) * 43758.5453); }
// Displacement of a point given in logo space (the animated group), also in logo space.
vec3 fxOffset(vec3 p) {
  vec3 q = p * uFxScale;                      // the logo spans about -1..1 across
  float A = uFxAmt, ph = uFxPhase * 6.2831853;
  if (uFxType < 1.5) {                        // wave: ripples run across the logo (up/down and in depth)
    float w = sin(q.x * 7.5 - ph) * (0.6 + 0.4 * cos(q.y * 2.0));
    return vec3(0.0, A * 0.55 * w / uFxScale * 0.5, A * w);
  } else if (uFxType < 2.5) {                 // jelly: wobbles, anchored at the bottom
    float f = clamp((q.y + 1.0) * 0.5, 0.0, 1.0);
    float s = A * sin(ph) * f;
    return vec3(p.x * s, -p.y * s * 0.5 * f, p.z * s * 0.6) + vec3(A * 0.35 * sin(ph * 2.0 + q.y * 3.0) * f / uFxScale, 0.0, 0.0);
  } else if (uFxType < 3.5) {                 // twist about the vertical axis, growing upwards
    float a = A * q.y * sin(ph);
    float c = cos(a), sn = sin(a);
    return vec3(p.x * c + p.z * sn - p.x, 0.0, -p.x * sn + p.z * c - p.z);
  } else if (uFxType < 4.5) {                 // bend: the ends curl toward the camera
    return vec3(0.0, 0.0, A * q.x * q.x / uFxScale * sin(ph));
  }
  // slices: horizontal bands jump sideways (a glitch), new pattern every 1/24 of a cycle
  float band = floor(q.y * 9.0), frame = floor(uFxPhase * 24.0);
  float on = step(0.55, fxHash(band * 7.13 + frame * 3.71));
  return vec3(A * (fxHash(band + frame * 13.1) - 0.5) * on / uFxScale, 0.0, 0.0);
}
mat3 fxJacobian(vec3 p) {
  float e = 0.01 / uFxScale;
  vec3 o = fxOffset(p);
  return mat3((fxOffset(p + vec3(e, 0.0, 0.0)) - o) / e, (fxOffset(p + vec3(0.0, e, 0.0)) - o) / e, (fxOffset(p + vec3(0.0, 0.0, e)) - o) / e);
}`;

export class Effects {
  constructor(stage) {
    this.stage = stage;
    this.uniforms = {
      uFxType: { value: 0 }, uFxAmt: { value: 0 }, uFxPhase: { value: 0 }, uFxScale: { value: 0.5 },
      uFxLogo: { value: new THREE.Matrix4() }, uFxLogoInv: { value: new THREE.Matrix4() },
      uFxDissolve: { value: -1 }, uFxEdge: { value: new THREE.Color('#ffb347') },
      uFxGlow: { value: 0 },
    };
    this.opacityWanted = null;
    this.cameraWanted = null;
    this.lightWanted = null;
    this.lightApplied = false;
    this.dissolveState = null;
    this.outlineState = null;
    this.portalState = null;
    this.shineOverride = null;
  }

  // ── shader injection (called from Stage.decorateMaterial) ──
  inject(shader) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + DEFORM_GLSL + '\nvarying vec3 vFxLogo;')
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
        if (uFxType > 0.5 && uFxType < 4.5) {
          vec3 fxP = (uFxLogoInv * modelMatrix * vec4(position, 1.0)).xyz;
          mat3 fxJ = fxJacobian(fxP);
          // Normal in logo space → transformed by the deformation (inverse transpose) → back.
          mat3 toLogo = mat3(uFxLogoInv) * mat3(modelMatrix);
          vec3 nL = normalize(inverse(transpose(toLogo)) * objectNormal);
          nL = normalize(transpose(inverse(mat3(1.0) + fxJ)) * nL);
          transformedNormal = normalize(normalMatrix * (transpose(toLogo) * nL));
          #ifdef FLIP_SIDED
            transformedNormal = - transformedNormal;
          #endif
        }`)
      .replace('#include <project_vertex>', `
        vec3 fxPL = (uFxLogoInv * modelMatrix * vec4(transformed, 1.0)).xyz;
        if (uFxType > 0.5) {
          vec3 fxOff = fxOffset(fxPL);
          transformed += inverse(mat3(uFxLogoInv * modelMatrix)) * fxOff;
          fxPL += fxOff;
        }
        vFxLogo = fxPL;
        #include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxLogo;\nuniform float uFxDissolve, uFxGlow;\nuniform vec3 uFxEdge;\n' + NOISE_GLSL)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float fxEdge = 0.0;
        if (uFxDissolve > -0.5) {
          float fxN = fxNoise(vFxLogo);
          if (fxN < uFxDissolve) discard;
          fxEdge = 1.0 - smoothstep(0.0, 0.018, fxN - uFxDissolve);
        }`)
      .replace('#include <opaque_fragment>', 'outgoingLight += uFxEdge * fxEdge * 3.0 + diffuseColor.rgb * uFxGlow * 1.6;\n#include <opaque_fragment>');
  }

  /** Per frame, before rendering: logo-space matrices and the particle / ribbon systems. */
  update() {
    const motion = this.stage.motion;
    motion.updateMatrixWorld(true);
    this.uniforms.uFxLogo.value.copy(motion.matrixWorld);
    this.uniforms.uFxLogoInv.value.copy(motion.matrixWorld).invert();
    const size = this.stage.logoSize;
    this.uniforms.uFxScale.value = 2 / Math.max(0.5, Math.max(size.x, size.y));
    this.updateDissolve();
    this.updateOutline();
    this.updatePortal();
    this.updateOpacity();
    this.updateLight();
  }

  // ── opacity, glow ──
  opacity(value) { this.opacityWanted = value; }
  glow(value) { this.uniforms.uFxGlow.value = value ?? 0; }

  /** Logo materials fade by their opacity (made transparent the first time it is needed). */
  updateOpacity() {
    const logo = this.stage.logo;
    if (!logo) return;
    const v = this.opacityWanted;
    if (v == null && !this.opacityApplied) return;
    const seen = new Set();
    for (const piece of logo.children) {
      for (const m of Array.isArray(piece.material) ? piece.material : [piece.material]) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        m.userData.baseOpacity ??= m.opacity;
        if (v != null && v < 1 && !m.transparent) { m.transparent = true; m.needsUpdate = true; }
        m.opacity = m.userData.baseOpacity * (v ?? 1);
      }
    }
    this.opacityApplied = v != null;
  }

  // ── camera, light ──
  camera(value) { this.cameraWanted = value; }
  light(value) { this.lightWanted = value; }

  /** Turns the lights / scales their strength on top of the user's choice; undone when off. */
  updateLight() {
    const st = this.stage, want = this.lightWanted;
    if (!want && !this.lightApplied) return;
    const az = (st.lightAzDeg ?? 0) + (want?.az ?? 0), el = (st.lightElDeg ?? 0) + (want?.el ?? 0);
    const rad = THREE.MathUtils.degToRad;
    st.lights.rotation.set(rad(-el), rad(az), 0, 'YXZ');
    st.lights.updateMatrixWorld(true);
    st.scene.environmentRotation.set(rad(-el), rad(az), 0, 'YXZ');
    const gain = want?.gain ?? 1;
    st.lights.traverse(l => { if (l.isLight) { l.userData.base ??= l.intensity; l.intensity = l.userData.base * gain; } });
    st.scene.environmentIntensity = (st.envBase ?? st.scene.environmentIntensity) * gain;
    this.lightApplied = !!want;
  }

  /** A new logo: drop everything built from the old one. */
  reset() {
    for (const s of [this.dissolveState, this.outlineState]) {
      if (!s) continue;
      s.object.parent?.remove(s.object);
      s.object.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    this.dissolveState = this.outlineState = null;
    this.dissolveWanted = this.outlineWanted = null;
  }

  // ── deform ──
  deform(type, amount = 0, phase = 0) {
    const u = this.uniforms;
    u.uFxType.value = type ? (DEFORM[type] || 0) : 0;
    u.uFxAmt.value = amount;
    u.uFxPhase.value = phase;
  }

  // ── dissolve ──
  dissolve(amount, style = 'particles') {
    this.dissolveWanted = amount == null ? null : { amount, style };
    this.uniforms.uFxDissolve.value = amount == null ? -1 : amount;
    this.uniforms.uFxEdge.value.set(style === 'smoke' ? '#9aa0aa' : '#ffb347');
  }

  /** Points sampled over the logo's surface at rest (logo space), with colours and a release threshold. */
  buildDissolve() {
    const logo = this.stage.logo;
    if (!logo) return null;
    const N = 5200;
    const tris = [];
    let total = 0;
    logo.updateMatrix();
    for (const piece of logo.children) {
      const pos = piece.geometry.attributes.position, uv = piece.geometry.attributes.uv;
      const m = new THREE.Matrix4().compose(piece.userData.home, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
      const groups = piece.geometry.groups.length ? piece.geometry.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
      for (const g of groups) {
        for (let i = g.start; i + 2 < g.start + g.count; i += 3) {
          const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m);
          const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(m);
          const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2).applyMatrix4(m);
          const area = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).length() / 2;
          if (area <= 0) continue;
          total += area;
          tris.push({ a, b, c, area, cum: total, piece, mat: g.materialIndex, uv: uv ? [i, i + 1, i + 2].map(k => new THREE.Vector2().fromBufferAttribute(uv, k)) : null });
        }
      }
    }
    if (!tris.length) return null;
    // Colours: the artwork texture where the face material uses it, else the material's colour.
    const texPixels = this.texturePixels(logo);
    const positions = new Float32Array(N * 3), base = new Float32Array(N * 3), drift = new Float32Array(N * 3);
    const colors = new Float32Array(N * 4), thresh = new Float32Array(N), color = new THREE.Color();
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < N; k++) {
      const r = rnd() * total;
      let lo = 0, hi = tris.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tris[mid].cum < r) lo = mid + 1; else hi = mid; }
      const t = tris[lo];
      let u = rnd(), v = rnd();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const p = t.a.clone().multiplyScalar(1 - u - v).addScaledVector(t.b, u).addScaledVector(t.c, v);
      base.set([p.x, p.y, p.z], k * 3);
      thresh[k] = fxNoise(p.x, p.y, p.z);
      const dir = new THREE.Vector3(rnd() - 0.5, rnd() * 0.8 + 0.2, rnd() - 0.3).normalize();
      drift.set([dir.x, dir.y, dir.z], k * 3);
      const mat = Array.isArray(t.piece.material) ? t.piece.material[t.mat] : t.piece.material;
      if (mat?.map && texPixels && t.uv) {
        const uvp = t.uv[0].clone().multiplyScalar(1 - u - v).addScaledVector(t.uv[1], u).addScaledVector(t.uv[2], v);
        const x = Math.max(0, Math.min(texPixels.w - 1, Math.floor(uvp.x * texPixels.w)));
        const y = Math.max(0, Math.min(texPixels.h - 1, Math.floor(uvp.y * texPixels.h)));
        const i = (y * texPixels.w + x) * 4;
        color.setRGB(texPixels.d[i] / 255, texPixels.d[i + 1] / 255, texPixels.d[i + 2] / 255, THREE.SRGBColorSpace);
      } else color.copy(mat?.color || new THREE.Color(1, 1, 1));
      colors.set([color.r, color.g, color.b, 0], k * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const tex = dotTexture();
    const material = new THREE.PointsMaterial({ size: 0.05, map: tex, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
    const object = new THREE.Points(geo, material);
    object.frustumCulled = false;
    object.renderOrder = 2;
    return { object, base, drift, thresh, colors: colors.slice(), tex };
  }

  texturePixels(logo) {
    const mat = logo.children.map(p => (Array.isArray(p.material) ? p.material[0] : p.material)).find(m => m?.map?.image);
    const img = mat?.map?.image;
    if (!img) return null;
    try {
      const k = Math.min(1, 512 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, h);
      return { w, h, d: g.getImageData(0, 0, w, h).data };
    } catch { return null; }
  }

  updateDissolve() {
    const want = this.dissolveWanted;
    if (!want) { if (this.dissolveState) this.dissolveState.object.visible = false; return; }
    if (!this.dissolveState) {
      this.dissolveState = this.buildDissolve();
      if (!this.dissolveState) return;
      this.stage.motion.add(this.dissolveState.object);
    }
    const s = this.dissolveState, smoke = want.style === 'smoke';
    const pos = s.object.geometry.attributes.position, col = s.object.geometry.attributes.color;
    s.object.visible = true;
    s.object.material.size = smoke ? 0.16 : 0.05;
    s.object.material.blending = smoke ? THREE.NormalBlending : THREE.AdditiveBlending;
    const span = smoke ? 0.5 : 0.35;
    for (let k = 0; k < pos.count; k++) {
      // Released when the front passes (amount > threshold), then drifts off and fades.
      const t = (want.amount - s.thresh[k]) / span;
      const i = k * 3;
      if (t <= 0 || t >= 1) { col.array[k * 4 + 3] = 0; pos.array[i] = s.base[i]; pos.array[i + 1] = s.base[i + 1]; pos.array[i + 2] = s.base[i + 2]; continue; }
      const d = smoke ? 1.2 : 2.2;
      pos.array[i] = s.base[i] + s.drift[i] * t * d + (smoke ? Math.sin(t * 6 + k) * 0.08 * t : 0);
      pos.array[i + 1] = s.base[i + 1] + s.drift[i + 1] * t * d + t * t * (smoke ? 1.6 : 0.6);
      pos.array[i + 2] = s.base[i + 2] + s.drift[i + 2] * t * d;
      const fade = (1 - t) * Math.min(1, t * 8);
      if (smoke) { const g = 0.55 + 0.25 * s.thresh[k]; col.array[k * 4] = g; col.array[k * 4 + 1] = g; col.array[k * 4 + 2] = g + 0.04; col.array[k * 4 + 3] = fade * 0.45; }
      else { col.array[k * 4] = s.colors[k * 4]; col.array[k * 4 + 1] = s.colors[k * 4 + 1]; col.array[k * 4 + 2] = s.colors[k * 4 + 2]; col.array[k * 4 + 3] = fade; }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // ── outline ribbons ──
  outline(progress, opacity = 1) {
    this.outlineWanted = progress == null ? null : { progress, opacity };
  }

  buildOutline() {
    const logo = this.stage.logo;
    if (!logo) return null;
    const object = new THREE.Group();
    const width = 0.022 * Math.max(this.stage.logoSize.x, this.stage.logoSize.y) / 4;
    const material = new THREE.ShaderMaterial({
      uniforms: { uProgress: { value: 0 }, uOpacity: { value: 1 }, uColor: { value: new THREE.Color('#e9fbff') } },
      vertexShader: 'attribute float aArc; varying float vArc; void main() { vArc = aArc; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uProgress, uOpacity; uniform vec3 uColor; varying float vArc;
        void main() {
          if (vArc > uProgress) discard;
          float head = smoothstep(0.06, 0.0, uProgress - vArc) * step(uProgress, 0.999);
          gl_FragColor = vec4(uColor * (1.4 + head * 2.5), uOpacity);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const piece of logo.children) {
      const loops = piece.userData.outline;
      if (!loops?.length) continue;
      const pos = [], arc = [], idx = [];
      for (const loop of loops) {
        const n = loop.length / 2;
        if (n < 3) continue;
        const lens = [0];
        for (let i = 1; i <= n; i++) {
          const a = i - 1, b = i % n;
          lens.push(lens[i - 1] + Math.hypot(loop[b * 2] - loop[a * 2], loop[b * 2 + 1] - loop[a * 2 + 1]));
        }
        const L = lens[n] || 1, start = pos.length / 3;
        for (let i = 0; i <= n; i++) {
          const c = i % n, p = (c - 1 + n) % n, q = (c + 1) % n;
          // Miter direction from the two neighbouring edges (clamped at sharp corners).
          let nx1 = -(loop[c * 2 + 1] - loop[p * 2 + 1]), ny1 = loop[c * 2] - loop[p * 2];
          let nx2 = -(loop[q * 2 + 1] - loop[c * 2 + 1]), ny2 = loop[q * 2] - loop[c * 2];
          const l1 = Math.hypot(nx1, ny1) || 1, l2 = Math.hypot(nx2, ny2) || 1;
          nx1 /= l1; ny1 /= l1; nx2 /= l2; ny2 /= l2;
          let mx = nx1 + nx2, my = ny1 + ny2;
          const ml = Math.hypot(mx, my) || 1;
          mx /= ml; my /= ml;
          const s = Math.min(2.5, 1 / Math.max(0.2, mx * nx1 + my * ny1)) * width / 2;
          const x = loop[c * 2], y = loop[c * 2 + 1], z = piece.userData.frontZ + 0.012;
          pos.push(x + mx * s, y + my * s, z, x - mx * s, y - my * s, z);
          arc.push(lens[i] / L, lens[i] / L);
        }
        for (let i = 0; i < n; i++) {
          const a = start + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      if (!idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('aArc', new THREE.Float32BufferAttribute(arc, 1));
      geo.setIndex(idx);
      const ribbon = new THREE.Mesh(geo, material);
      ribbon.matrixAutoUpdate = false;
      ribbon.userData.piece = piece;
      ribbon.renderOrder = 3;
      object.add(ribbon);
    }
    return { object, material };
  }

  updateOutline() {
    const want = this.outlineWanted;
    if (!want) { if (this.outlineState) this.outlineState.object.visible = false; return; }
    if (!this.outlineState) {
      this.outlineState = this.buildOutline();
      if (!this.outlineState) return;
      this.stage.motion.add(this.outlineState.object);
    }
    const s = this.outlineState;
    s.object.visible = true;
    s.material.uniforms.uProgress.value = want.progress;
    s.material.uniforms.uOpacity.value = want.opacity;
    // Each ribbon follows its piece (both live in the motion group, the logo group is identity).
    const logo = this.stage.logo;
    if (logo) logo.updateMatrix();
    for (const r of s.object.children) {
      const p = r.userData.piece;
      p.updateMatrix();
      r.matrix.multiplyMatrices(logo.matrix, p.matrix);
      r.visible = p.parent === logo;
    }
  }

  // ── portal ──
  portal(progress) { this.portalWanted = progress; }

  updatePortal() {
    const p = this.portalWanted;
    if (p == null) { if (this.portalState) this.portalState.visible = false; return; }
    if (!this.portalState) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.035, 16, 128),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('#7fe3ff').multiplyScalar(2.2), transparent: true, toneMapped: false }),
      );
      // The inside glows (added light, never a dark disc in front of the scene).
      const glow = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({ color: '#3fb6ff', transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      const portal = new THREE.Group();
      portal.add(ring, glow);
      portal.userData = { ring, glow };
      this.stage.root.add(portal);
      this.portalState = portal;
    }
    const portal = this.portalState, size = this.stage.logoSize;
    const radius = Math.max(size.x, size.y) * 0.62;
    // Opens (0..0.2), holds while the logo comes through, closes (0.8..1).
    const open = Math.min(1, p / 0.2) * Math.min(1, (1 - p) / 0.2);
    const e = open * open * (3 - 2 * open);
    portal.visible = e > 0.001;
    portal.scale.set(radius * e, radius * e * 0.62, 1);
    portal.position.set(0, 0, PORTAL_Z);
    portal.rotation.z = p * 0.8;
    portal.userData.ring.material.opacity = e;
    portal.userData.glow.material.opacity = 0.1 * e;
  }

  // ── shine ──
  shine(position, strength = 1.6) {
    this.shineOverride = position == null ? null : { position, strength };
  }
}


let dot = null;
function dotTexture() {
  if (dot) return dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  dot = new THREE.CanvasTexture(c);
  return dot;
}
