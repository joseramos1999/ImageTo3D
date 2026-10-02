// Renderer, scene, lighting, floors, background, bloom, particles and camera moves.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const TAU = Math.PI * 2;

export const LIGHTING = [
  { id: 'studio', label: 'Estudio' },
  { id: 'soft', label: 'Suave' },
  { id: 'dramatic', label: 'Dramática' },
  { id: 'neon', label: 'Neón' },
  { id: 'sunset', label: 'Atardecer' },
  { id: 'flat', label: 'Plana' },
];

export const FLOORS = [
  { id: 'none', label: 'Ninguno' },
  { id: 'shadow', label: 'Sombra' },
  { id: 'mirror', label: 'Espejo' },
  { id: 'grid', label: 'Rejilla' },
  { id: 'spot', label: 'Foco' },
];

export const CAMERA_MOVES = [
  { id: 'none', label: 'Fija' },
  { id: 'sway', label: 'Balanceo' },
  { id: 'orbit', label: 'Órbita 360°' },
  { id: 'push', label: 'Acercar/alejar' },
  { id: 'crane', label: 'Grúa' },
];

export const BACKGROUNDS = [
  { id: 'vignette', css: 'radial-gradient(#23242e,#07070a)', spec: { type: 'radial', a: '#23242e', b: '#060609' } },
  { id: 'black', css: '#050507', spec: { type: 'solid', a: '#050507' } },
  { id: 'white', css: '#f4f4f6', spec: { type: 'radial', a: '#ffffff', b: '#d9dae0' } },
  { id: 'graphite', css: '#2a2b30', spec: { type: 'solid', a: '#2a2b30' } },
  { id: 'indigo', css: 'radial-gradient(#5a3ff0,#1a0f5c)', spec: { type: 'radial', a: '#5a3ff0', b: '#140b47' } },
  { id: 'blue', css: 'linear-gradient(160deg,#2b6cff,#0a1a4a)', spec: { type: 'linear', a: '#2b6cff', b: '#0a1a4a' } },
  { id: 'teal', css: 'linear-gradient(160deg,#2dd4bf,#0b3b4a)', spec: { type: 'linear', a: '#2dd4bf', b: '#0b3b4a' } },
  { id: 'sunset', css: 'linear-gradient(160deg,#ff9a5a,#7a1f5c)', spec: { type: 'linear', a: '#ff9a5a', b: '#5a1546' } },
  { id: 'pink', css: 'radial-gradient(#ff7aa8,#7a1238)', spec: { type: 'radial', a: '#ff7aa8', b: '#5e0d2b' } },
  { id: 'lime', css: '#c8f55a', spec: { type: 'radial', a: '#d8ff7a', b: '#8fb52a' } },
  { id: 'cream', css: '#f5ead6', spec: { type: 'radial', a: '#fff8ea', b: '#e2d2b4' } },
  { id: 'green', css: '#00b140', spec: { type: 'solid', a: '#00b140' } },   // chroma key
];

function gradientCanvas(spec, w = 1024, h = 1024) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  let g;
  if (spec.type === 'radial') g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h / 2, Math.hypot(w, h) * 0.55);
  else g = ctx.createLinearGradient(0, 0, w * 0.35, h);
  g.addColorStop(0, spec.a); g.addColorStop(1, spec.b || spec.a);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // A touch of noise stops 8-bit banding in smooth gradients (very visible in video).
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
  return c;
}

function radialTexture(stops, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Reflector variant whose reflection fades out radially into the background
// (the stock shader paints an opaque mirror with a hard horizon).
const FadingReflectorShader = {
  name: 'FadingReflectorShader',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    fadeNear: { value: 1.5 }, fadeFar: { value: 9 }, strength: { value: 0.55 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec2 vLocal;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vLocal = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float fadeNear, fadeFar, strength;
    varying vec4 vUv;
    varying vec2 vLocal;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 base = texture2DProj(tDiffuse, vUv);
      float fade = 1.0 - smoothstep(fadeNear, fadeFar, length(vLocal));
      gl_FragColor = vec4(base.rgb * color, strength * fade);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

function gridTexture() {
  const size = 1024, cells = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  for (let i = 0; i <= cells; i++) {
    ctx.lineWidth = i % 4 === 0 ? 2.2 : 1;
    ctx.globalAlpha = i % 4 === 0 ? 0.55 : 0.25;
    const p = i * size / cells;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  // Fade to nothing towards the edges.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.55, 'rgba(0,0,0,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // r18x: PCF is soft, `radius` controls the blur

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 200);
    this.camera.position.set(0, 1, 12);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 60;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // root (user scale) → motion (animated) → logo pieces
    this.root = new THREE.Group();
    this.motion = new THREE.Group();
    this.root.add(this.motion);
    this.scene.add(this.root);

    this.lights = new THREE.Group();
    this.scene.add(this.lights);
    this.floorGroup = new THREE.Group();
    this.scene.add(this.floorGroup);

    this.composer = this.makeComposer();

    this.logo = null;
    this.logoSize = new THREE.Vector3(4, 2, 0.4);
    this.floorY = -1.5;
    this.floorId = 'none';
    this.cameraMove = 'none';
    this.lightingId = 'studio';
    this.lightGain = 1;
    this.bgSpec = BACKGROUNDS[0].spec;
    this.particles = null;
    this.setLighting('studio', 1);
    this.setBackground(this.bgSpec);
  }

  makeComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x || 1, size.y || 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x || 1, size.y || 1), 0, 0.45, 0.85);
    this.bloom.enabled = false;
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    return composer;
  }

  setSize(w, h) {
    this.viewW = w; this.viewH = h;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Temporarily renders at an exact pixel size (exports). Returns a restore fn. */
  beginFixedSize(w, h) {
    const prevRatio = this.renderer.getPixelRatio(), pw = this.viewW, ph = this.viewH;
    // Above ~4 MP the 4x multisampled half-float targets cost ~265 MB each of GPU memory;
    // at that resolution 2x antialiasing looks the same and halves it.
    const samples = w * h > 4e6 ? 2 : 4;
    this.setSamples(samples);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    return () => {
      this.setSamples(4);
      this.renderer.setPixelRatio(prevRatio);
      this.setSize(pw, ph);
    };
  }

  setSamples(n) {
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === n) continue;
      rt.samples = n;
      rt.dispose();   // reallocated with the new sample count on next use
    }
  }

  setLogo(group) {
    if (this.logo) this.motion.remove(this.logo);
    this.logo = group;
    if (group) {
      this.motion.add(group);
      this.logoSize.copy(group.userData.size);
    }
    this.updateFloorHeight();
  }

  setUserScale(s) {
    this.root.scale.setScalar(s);
    this.updateFloorHeight();
  }

  /** Floor sits under the logo; animations that rotate it end-over-end need more room. */
  updateFloorHeight(tall = this.tallAnim) {
    this.tallAnim = tall;
    const s = this.root.scale.x, sz = this.logoSize;
    const reach = tall ? Math.hypot(sz.x, sz.y, sz.z) / 2 : sz.y / 2 + 0.15;
    this.floorY = -(reach * s) - 0.35;
    this.floorGroup.position.y = this.floorY;
    if (this.keyLight) this.fitShadow();
  }

  /** Places the camera so the logo fills the frame comfortably. */
  frame(round = false) {
    const s = this.root.scale.x, sz = this.logoSize;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const margin = 1.3;
    const d0 = Math.hypot(sz.x, sz.y), fw = round ? d0 : sz.x, fh = round ? d0 : sz.y;   // round: frame the swept circle
    const dv = (fh * s / 2 * margin) / Math.tan(vfov / 2);
    const dh = (fw * s / 2 * margin) / Math.tan(hfov / 2);
    const d = Math.max(dv, dh, 4) + sz.z * s / 2;
    this.camera.position.set(0, d * 0.1, d);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  // ── Lighting ──
  setLighting(id, gain = this.lightGain) {
    this.lightingId = id; this.lightGain = gain;
    this.lights.clear();
    const dir = (color, intensity, x, y, z) => {
      const l = new THREE.DirectionalLight(color, intensity * gain);
      l.position.set(x, y, z);
      this.lights.add(l);
      return l;
    };
    const point = (color, intensity, x, y, z) => {
      const l = new THREE.PointLight(color, intensity * gain, 0, 2);
      l.position.set(x, y, z);
      this.lights.add(l);
      return l;
    };
    let env = 1, key;
    switch (id) {
      case 'soft':
        env = 1.25;
        this.lights.add(new THREE.HemisphereLight(0xffffff, 0x404050, 0.9 * gain));
        key = dir(0xffffff, 1.1, 2, 6, 5);
        break;
      case 'dramatic':
        env = 0.45;
        key = dir(0xfff1dc, 3.4, 5, 6, 4);
        dir(0x7fa7ff, 3.2, -5, 2, -5);
        dir(0xffffff, 0.25, -4, 0, 6);
        break;
      case 'neon':
        env = 0.3;
        key = dir(0xffffff, 0.5, 0, 6, 5);
        point(0xff2fa8, 60, -4.5, 1.2, 3);
        point(0x23e6ff, 60, 4.5, 1.2, 3);
        point(0x8a5cff, 30, 0, 3, -4);
        break;
      case 'sunset':
        env = 0.6;
        key = dir(0xffb070, 3, -6, 3, 4);
        dir(0x6a7dff, 1.4, 6, 2, -3);
        this.lights.add(new THREE.HemisphereLight(0xffcfa0, 0x2a2040, 0.4 * gain));
        break;
      case 'flat':
        env = 1;
        this.lights.add(new THREE.AmbientLight(0xffffff, 1.6 * gain));
        key = dir(0xffffff, 0.6, 0, 3, 8);
        break;
      default: // studio — kept moderate so "logo colors" stay true to the artwork
        env = 0.85;
        key = dir(0xffffff, 1.6, 3, 5, 6);
        dir(0xdfe8ff, 0.5, -5, 2, 4);
        dir(0xffffff, 1.6, 0, 4, -6);
    }
    this.scene.environmentIntensity = env * gain;
    this.keyLight = key;
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 6;
    this.lights.add(key.target);
    this.fitShadow();
  }

  fitShadow() {
    const cam = this.keyLight.shadow.camera;
    const r = Math.max(this.logoSize.x, this.logoSize.y) * this.root.scale.x * 0.9 + 1;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.1; cam.far = 40;
    cam.updateProjectionMatrix();
  }

  // ── Background ──
  setBackground(spec) {
    if (spec === this.bgSpec && this.scene.background) return;
    this.bgSpec = spec;
    if (this.bgTexture) { this.bgTexture.dispose(); this.bgTexture = null; }
    if (spec.type === 'solid') {
      this.scene.background = new THREE.Color(spec.a);
    } else {
      this.bgTexture = new THREE.CanvasTexture(gradientCanvas(spec));
      this.bgTexture.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = this.bgTexture;
    }
  }

  // ── Floors ──
  setFloor(id) {
    if (id === this.floorId && (this.floorGroup.children.length || id === 'none')) return;
    this.floorId = id;
    this.floorGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      if (o.getRenderTarget) o.getRenderTarget().dispose();
    });
    this.floorGroup.clear();
    const plane = (size = 40) => new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const shadow = (opacity = 0.42) => {
      const m = new THREE.Mesh(plane(), new THREE.ShadowMaterial({ opacity }));
      m.receiveShadow = true;
      m.position.y = 0.002;
      this.floorGroup.add(m);
    };

    switch (id) {
      case 'shadow': shadow(); break;
      case 'mirror': {
        const mirror = new Reflector(new THREE.PlaneGeometry(40, 40), {
          textureWidth: 1536, textureHeight: 1536, color: 0xffffff, clipBias: 0.003, shader: FadingReflectorShader,
        });
        mirror.material.transparent = true;
        mirror.material.depthWrite = false;
        mirror.rotateX(-Math.PI / 2);
        this.floorGroup.add(mirror);
        shadow(0.3);
        break;
      }
      case 'grid': {
        const grid = new THREE.Mesh(plane(26), new THREE.MeshBasicMaterial({
          map: gridTexture(), transparent: true, depthWrite: false, color: 0x9aa0b4, opacity: 0.45,
        }));
        this.floorGroup.add(grid);
        shadow(0.5);
        break;
      }
      case 'spot': {
        const spot = new THREE.Mesh(plane(16), new THREE.MeshBasicMaterial({
          map: radialTexture([[0, 'rgba(255,255,255,0.28)'], [0.35, 'rgba(255,255,255,0.09)'], [1, 'rgba(255,255,255,0)']]),
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.floorGroup.add(spot);
        shadow(0.55);
        break;
      }
    }
  }

  // ── Bloom ──
  setBloom(strength, threshold = 0.85) {
    this.bloom.strength = strength;
    this.bloom.threshold = threshold;
    this.bloom.radius = 0.35;
    this.bloom.enabled = strength > 0.001;
  }

  // ── Particles (seamless: positions are periodic in the camera cycle) ──
  setParticles(on, density = 1, color = '#ffffff') {
    if (on === !!this.particles && (!on || density === this.particleDensity)) return;
    this.particleDensity = density;
    if (this.particles) {
      this.scene.remove(this.particles);
      this.particles.geometry.dispose();
      this.particles.material.map.dispose();
      this.particles.material.dispose();
      this.particles = null;
    }
    if (!on) return;
    const n = Math.round(260 * density);
    const pos = new Float32Array(n * 3);
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      seeds[i * 4] = (Math.random() - 0.5) * 18;
      seeds[i * 4 + 1] = (Math.random() - 0.4) * 10;
      seeds[i * 4 + 2] = (Math.random() - 0.7) * 12;
      seeds[i * 4 + 3] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.09, map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']], 64),
      color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.particles = new THREE.Points(geo, mat);
    this.particles.userData.seeds = seeds;
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  updateParticles(cycle) {
    if (!this.particles) return;
    const s = this.particles.userData.seeds, p = this.particles.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const ph = s[i * 4 + 3] * TAU, k = 1 + (i % 2);
      p.array[i * 3] = s[i * 4] + Math.sin(TAU * cycle * k + ph) * 0.35;
      p.array[i * 3 + 1] = s[i * 4 + 1] + Math.sin(TAU * cycle + ph * 1.7) * 0.6;
      p.array[i * 3 + 2] = s[i * 4 + 2] + Math.cos(TAU * cycle * k + ph) * 0.35;
    }
    p.needsUpdate = true;
  }

  /**
   * Renders one frame. `cycle` (0..1) is the camera-move / particle phase.
   * The camera move is applied on top of the user's orbit and undone afterwards.
   */
  render(cycle = 0, { transparent = false } = {}) {
    this.updateParticles(cycle);
    const cam = this.camera, target = this.controls.target;
    const savedPos = cam.position.clone(), savedQuat = cam.quaternion.clone();

    if (this.cameraMove !== 'none') {
      const off = cam.position.clone().sub(target);
      const sph = new THREE.Spherical().setFromVector3(off);
      const w = TAU * cycle;
      switch (this.cameraMove) {
        case 'sway': sph.theta += Math.sin(w) * 0.4; break;
        case 'orbit': sph.theta += w; break;
        case 'push': sph.radius *= 1 - 0.22 * (0.5 - 0.5 * Math.cos(w)); break;
        case 'crane': sph.phi = THREE.MathUtils.clamp(sph.phi - Math.sin(w) * 0.35, 0.2, Math.PI - 0.2); break;
      }
      cam.position.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
      cam.lookAt(target);
    }

    if (transparent) {
      const bg = this.scene.background, floorVisible = this.floorGroup.visible;
      this.scene.background = null;
      this.floorGroup.visible = this.floorId === 'shadow';
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.render(this.scene, cam);
      this.scene.background = bg;
      this.floorGroup.visible = floorVisible;
    } else {
      this.composer.render();
    }

    cam.position.copy(savedPos);
    cam.quaternion.copy(savedQuat);
  }
}
