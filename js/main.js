import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Spider } from './spider.js';
import { buildEnvironment } from './environment.js';
import { SpiderAudio } from './audio.js';

/* ============================================================== renderer */

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030407);
scene.fog = new THREE.FogExp2(0x04050a, 0.05);

const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.04, 120);
camera.position.set(1.9, 1.05, 2.1);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.42, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.enablePan = false;
controls.minDistance = 0.85;
controls.maxDistance = 9;
controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotateSpeed = 0.32;
controls.update();

/* =========================================================== the world */

const env = buildEnvironment(scene, renderer);
const spider = new Spider(scene);
const audio = new SpiderAudio();

/* ====================================================== post processing */

const PostFX = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.25 },
    uGrain: { value: 0.038 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // cheap chromatic aberration, stronger towards the frame edge
      float ab = 0.0016 * (0.25 + r2 * 3.4);
      vec3 col;
      col.r = texture2D(tDiffuse, uv - d * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + d * ab).b;

      // film grain
      float g = hash(uv * vec2(1024.0, 768.0) + fract(uTime) * 91.7);
      col += (g - 0.5) * uGrain;

      // faint CRT scanlines
      col *= 1.0 - 0.028 * (0.5 + 0.5 * sin(uv.y * 1500.0));

      // vignette
      col *= 1.0 - smoothstep(0.22, 0.95, r2 * uVignette * 1.7);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

let composer = null;
let bloomPass = null;
let fxPass = null;
let useBloom = true;

try {
  const [ec, rp, ub, sp, op] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/ShaderPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
  ]);
  composer = new ec.EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new rp.RenderPass(scene, camera));

  bloomPass = new ub.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.5, 0.62);
  composer.addPass(bloomPass);

  fxPass = new sp.ShaderPass(PostFX);
  composer.addPass(fxPass);
  composer.addPass(new op.OutputPass());
} catch (err) {
  console.warn('[mk0] post-processing unavailable, falling back to direct render', err);
}

/* ================================================================= input */

const pointer = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const aim = new THREE.Vector3(0, 0.45, -2);
let pointerMoved = false;

window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  pointerMoved = true;
});
window.addEventListener('pointerdown', () => {
  if (!audioEnabled) setSound(true);
});

function updateAim() {
  if (!pointerMoved) {
    camera.getWorldDirection(aim);
    aim.multiplyScalar(3.4).add(camera.position);
  } else {
    raycaster.setFromCamera(pointer, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    let t = 3.4;
    if (d.y < -0.06) {
      const tt = (0.4 - o.y) / d.y;
      if (tt > 0.4 && tt < 14) t = tt;
    }
    aim.copy(o).addScaledVector(d, t);
  }
  const r = Math.hypot(aim.x, aim.z);
  if (r > 4.2) {
    aim.x *= 4.2 / r;
    aim.z *= 4.2 / r;
  }
  if (aim.y < 0.05) aim.y = 0.05;
}

/* ================================================================== hud */

const hud = {
  state: document.getElementById('r-state'),
  speed: document.getElementById('r-speed'),
  core: document.getElementById('r-core'),
  servo: document.getElementById('r-servo'),
  dist: document.getElementById('r-dist'),
};

let hudT = 0;
function updateHud(dt) {
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.12;
  const st = spider.state;
  hud.state.textContent = st === 'DOWN' ? 'OFFLINE' : st === 'BOOT' ? 'STANDBY' : st;
  hud.state.className = st === 'ATTACK' || st === 'SCARE' || st === 'THREAT' ? 'warn' : '';
  hud.speed.textContent = spider.actualSpeed.toFixed(2);
  hud.core.textContent = `${Math.round(Math.min(1, spider.energy) * 100)}%`;
  const ticks = spider.detentRate;
  hud.servo.textContent = ticks >= 1000 ? `${(ticks / 1000).toFixed(1)}k/s` : `${ticks.toFixed(0)}/s`;
  hud.dist.textContent = `${spider.root.position.distanceTo(camera.position).toFixed(1)}m`;
}

/* ================================================================ flash */

const flashEl = document.getElementById('flash');
let flashTimer = 0;
function flash(strength, ms) {
  flashEl.style.transition = 'none';
  flashEl.style.opacity = String(Math.min(1, strength));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashEl.style.transition = 'opacity .28s ease';
    flashEl.style.opacity = '0';
  }, ms);
}

/* ============================================================== events */

spider.onEvent = (name, data = {}) => {
  switch (name) {
    case 'impact':
      audio.impact();
      flash(0.5, 80);
      break;
    case 'step':
      audio.step(data.weight ?? 1);
      break;
    case 'click':
      audio.click(data.soft ? 1.35 : 1);
      break;
    case 'hiss':
      audio.hiss(0.7, 0.075);
      break;
    case 'screech':
      audio.screech(1);
      audio.setDrone(1);
      flash(0.22, 70);
      break;
    case 'whoosh':
      audio.whoosh();
      break;
    case 'snap':
      audio.click(1.7);
      audio.impact();
      flash(0.4, 60);
      break;
    case 'glitch':
      audio.glitch();
      break;
    case 'servo':
      audio.detent(data.weight ?? 1);
      break;
    case 'relay':
      audio.relay();
      break;
    case 'scan':
      audio.scan();
      break;
    case 'powerup':
      audio.power(true);
      audio.setDrone(0.15);
      break;
    case 'powerdown':
      audio.power(false);
      audio.setDrone(-0.6);
      break;
    case 'vanish':
      flash(1, 120);
      audio.glitch();
      audio.setDrone(0.2);
      setTimeout(() => flash(0.35, 60), 150);
      break;
    default:
      break;
  }
};

/* ============================================================== toggles */

let audioEnabled = false;
let follow = false;

async function setSound(on) {
  try {
    audioEnabled = await (on ? audio.enable() : audio.disable());
  } catch (err) {
    console.warn('[mk0] audio unavailable', err);
    audioEnabled = false;
  }
  syncToggles();
}

const toggleState = {
  autopilot: false,
  follow: false,
  sound: false,
  bloom: true,
};

function syncToggles() {
  toggleState.autopilot = spider.autopilot;
  toggleState.follow = follow;
  toggleState.sound = audioEnabled;
  toggleState.bloom = useBloom;
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.classList.toggle('on', !!toggleState[btn.dataset.toggle]);
  });
}

document.querySelectorAll('[data-toggle]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    switch (btn.dataset.toggle) {
      case 'autopilot':
        spider.autopilot = !spider.autopilot;
        if (spider.autopilot && spider.state === 'IDLE') spider.idleTimer = 0.4;
        break;
      case 'follow':
        follow = !follow;
        controls.autoRotate = follow;
        break;
      case 'sound':
        await setSound(!audioEnabled);
        break;
      case 'bloom':
        useBloom = !useBloom;
        if (bloomPass) bloomPass.enabled = useBloom;
        break;
      default:
        break;
    }
    syncToggles();
  });
});

document.querySelectorAll('[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const c = btn.dataset.cmd;
    if (c === 'scare') {
      spider.cmd('idle');
      audio.screech(1.15);
      flash(1, 150);
      const home = camera.position.clone();
      const dir = camera.getWorldDirection(new THREE.Vector3());
      dir.y = 0;
      dir.normalize();
      spider.teleportInFrontOfCamera(camera);
      // hard cut so the camera is already framing the thing when the light comes back
      controls.target.copy(spider.headWorld(new THREE.Vector3())).sub(new THREE.Vector3(0, 0.35, 0));
      camera.position.copy(home);
      spider.shake = 0.8;
      return;
    }
    if (c === 'power' && spider.state === 'BOOT') {
      spider.deploy();
      return;
    }
    spider.cmd(c);
    syncToggles();
  });
});

document.getElementById('speed').addEventListener('input', (e) => {
  spider.speedScale = parseFloat(e.target.value);
  spider.maxSpeed = 0.95 * spider.speedScale;
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const map = { '1': 'idle', '2': 'walk', '3': 'stalk', '4': 'threat', '5': 'attack', '6': 'scare', '7': 'power', '8': 'glitch' };
  if (map[k]) {
    const btn = document.querySelector(`[data-cmd="${map[k]}"]`);
    if (btn) btn.click();
  }
  if (k === 'a') document.querySelector('[data-toggle="autopilot"]').click();
  if (k === 'c') document.querySelector('[data-toggle="follow"]').click();
  if (k === 's') document.querySelector('[data-toggle="sound"]').click();
  if (k === 'b') document.querySelector('[data-toggle="bloom"]').click();
});

/* ================================================================= boot */

const bootEl = document.getElementById('boot');
const bootLog = document.getElementById('bootlog');
const bootBtn = document.getElementById('bootbtn');

const BOOT_LINES = [
  ['booting containment rig MK-0', 70],
  ['> chassis ......... OK', 150],
  ['> 8x servo bus .... OK', 190],
  ['> optical array ... 8/8 ONLINE', 230],
  ['> IK solver ....... CALIBRATED', 170],
  ['> power cell ...... UNSTABLE', 300],
  ['> behaviour core .. UNSUPERVISED', 340],
  ['WARNING: subject is not restrained', 520],
  ['WARNING: subject is aware of the operator', 700],
];

(async function bootSequence() {
  for (const [line, delay] of BOOT_LINES) {
    await new Promise((r) => setTimeout(r, delay));
    const span = document.createElement('div');
    span.textContent = line;
    if (line.startsWith('WARNING')) span.className = 'bad';
    bootLog.appendChild(span);
  }
  bootBtn.disabled = false;
  bootBtn.style.opacity = '1';
})();

bootBtn.addEventListener('click', () => {
  bootEl.classList.add('hidden');
  spider.deploy();
  setSound(true).catch(() => {}); // never let a blocked AudioContext stall the demo
  setTimeout(() => {
    bootEl.remove();
  }, 900);
});

/* ================================================================= loop */

const _headPos = new THREE.Vector3();
const _shake = new THREE.Vector3();
let shake = 0;
let simTime = 0;
let lastFrame = performance.now() / 1000;

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  if (bloomPass) bloomPass.setSize(window.innerWidth, window.innerHeight);
});

/** one simulation step — decoupled from drawing so it can be stepped
 *  deterministically (headless testing / slow machines) */
function simulate(dt) {
  simTime += dt;

  updateAim();
  spider.update(dt, { camera, aim, time: simTime });
  env.update(dt, simTime, spider);

  // servo chatter follows real locomotion
  audio.servo(
    spider.state === 'WALK' || spider.state === 'STALK' ? Math.min(0.35 + spider.actualSpeed * 1.4, 1.5) : 0,
    dt
  );

  shake = Math.max(shake * Math.exp(-dt * 3.4), spider.shake);
  spider.shake = 0;

  if (follow) controls.target.lerp(spider.headWorld(_headPos), 1 - Math.exp(-3 * dt));
  controls.update();
}

let paused = false;

function tick() {
  requestAnimationFrame(tick);

  const now = performance.now() / 1000;
  const dt = clampF(now - lastFrame, 1 / 240, 0.05);
  lastFrame = now;

  // `paused` freezes the simulation but keeps drawing: the screenshot harness
  // parks the machine on an exact pose and captures it without any drift
  if (!paused) simulate(dt);

  // camera shake: applied around the draw only, never fed back into the controls
  const s = shake;
  if (s > 0.001) {
    _shake.set(
      (Math.random() - 0.5) * 0.09 * s,
      (Math.random() - 0.5) * 0.07 * s,
      (Math.random() - 0.5) * 0.09 * s
    );
    camera.position.add(_shake);
  }

  if (fxPass) fxPass.uniforms.uTime.value = simTime;

  if (composer) composer.render(dt);
  else renderer.render(scene, camera);

  if (s > 0.001) camera.position.sub(_shake);

  updateHud(dt);
}

function clampF(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

syncToggles();
tick();

// expose for tinkering from the console
window.MK0 = {
  spider,
  env,
  camera,
  scene,
  audio,
  renderer,
  step: (steps = 60, dt = 1 / 60) => {
    for (let i = 0; i < steps; i++) simulate(dt);
  },
  pause: () => {
    paused = true;
    return true;
  },
  resume: () => {
    lastFrame = performance.now() / 1000;
    paused = false;
    return true;
  },
  get paused() {
    return paused;
  },
};
