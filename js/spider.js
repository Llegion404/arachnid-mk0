import * as THREE from 'three';

/* =============================================================== helpers */

const TAU = Math.PI * 2;
const UPV = new THREE.Vector3(0, 1, 0);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

/** grid the scanner pod slews on, in radians */
const POD_STEP = 0.11;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeIn = (t) => Math.pow(clamp(t, 0, 1), 2.2);
const damp = (dt, rate) => 1 - Math.exp(-rate * dt);

function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** place a unit-height, Y-up mesh so it spans from -> to */
function alignSegment(mesh, from, to) {
  _v1.subVectors(to, from);
  const len = _v1.length();
  if (len < 1e-6) return;
  _v1.multiplyScalar(1 / len);
  mesh.position.copy(from).addScaledVector(_v1, len * 0.5);
  _q1.setFromUnitVectors(UPV, _v1);
  mesh.quaternion.copy(_q1);
  mesh.scale.y = len;
}

/** snap a unit direction onto a spherical servo grid, with a deadband so a
 *  joint holding position can never chatter across a detent boundary, and a
 *  continuous (unwrapped) azimuth so it never loses the plot at the ±pi seam.
 *  `hold` is the previous result; returns the new detent state + ticks moved. */
function quantizeDir(dir, step, hold = null) {
  const th = Math.atan2(dir.x, dir.z);
  const ph = Math.acos(clamp(dir.y, -1, 1));
  const thU = hold ? hold.th + angleDelta(hold.th, th) : th;
  let qTh = Math.round(thU / step) * step;
  let qPh = Math.round(ph / step) * step;
  if (hold) {
    if (Math.abs(thU - hold.th) < step * 0.78) qTh = hold.th;
    if (Math.abs(ph - hold.ph) < step * 0.78) qPh = hold.ph;
  }
  const phC = clamp(qPh, 0.004, Math.PI - 0.004);
  const s = Math.sin(phC);
  dir.set(s * Math.sin(qTh), Math.cos(phC), s * Math.cos(qTh));
  return {
    th: qTh,
    ph: phC,
    moved: hold
      ? Math.round(Math.abs(qTh - hold.th) / step) + Math.round(Math.abs(phC - hold.ph) / step)
      : 0,
  };
}

/** place a unit-height, Y-up cone with its base at `base` pointing along `dir` */
function alignCone(mesh, base, dir, len) {
  mesh.position.copy(base).addScaledVector(dir, len * 0.5);
  _q1.setFromUnitVectors(UPV, dir);
  mesh.quaternion.copy(_q1);
  mesh.scale.y = len;
  return len;
}

/* ============================================================ materials */

const MAT = {
  shell: new THREE.MeshStandardMaterial({
    color: 0x0f1217,
    metalness: 0.62,
    roughness: 0.5,
    flatShading: true,
    envMapIntensity: 0.72,
  }),
  plate: new THREE.MeshStandardMaterial({
    color: 0x090b10,
    metalness: 0.66,
    roughness: 0.46,
    flatShading: true,
    envMapIntensity: 0.72,
  }),
  limb: new THREE.MeshStandardMaterial({
    color: 0x0c0f14,
    metalness: 0.62,
    roughness: 0.5,
    flatShading: true,
    envMapIntensity: 0.72,
  }),
  joint: new THREE.MeshStandardMaterial({
    color: 0x2a2f3a,
    metalness: 0.85,
    roughness: 0.42,
    flatShading: true,
    envMapIntensity: 0.6,
  }),
  spike: new THREE.MeshStandardMaterial({
    color: 0x16191f,
    metalness: 0.8,
    roughness: 0.45,
    flatShading: true,
    envMapIntensity: 0.6,
  }),
  edge: new THREE.LineBasicMaterial({ color: 0x8f1608, transparent: true, opacity: 0.55 }),
  edgeDim: new THREE.LineBasicMaterial({ color: 0x5c0f06, transparent: true, opacity: 0.4 }),
  // bare machined metal for the moving parts: actuators, drums, sprockets.
  // Deliberately dark: metals tint their highlight with the base colour, and
  // anything brighter blows out under the internal point lights.
  chrome: new THREE.MeshStandardMaterial({
    color: 0x424a58,
    metalness: 0.8,
    roughness: 0.46,
    flatShading: true,
    envMapIntensity: 0.6,
  }),
  // matte composite for panels, day-plates and the scanner housing
  carbon: new THREE.MeshStandardMaterial({
    color: 0x111419,
    metalness: 0.38,
    roughness: 0.68,
    flatShading: true,
    envMapIntensity: 0.5,
  }),
  // matte armour composite for the big hull plates: rough and non-metallic so
  // broad flat panels read as painted armour instead of flaring under the key
  hull: new THREE.MeshStandardMaterial({
    color: 0x14171d,
    metalness: 0.12,
    roughness: 0.86,
    flatShading: true,
    envMapIntensity: 0.22,
  }),
  // recessed / shadowed panel work
  dark: new THREE.MeshStandardMaterial({
    color: 0x05070a,
    metalness: 0.5,
    roughness: 0.58,
    flatShading: true,
    envMapIntensity: 0.32,
  }),
};

/* --------------------------------------------------------- stencils */

/** procedural 512x256 stencil decal: hazard band + unit markings + scuffs */
function makeDecalTexture(mark, sub) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 256);

  // faded hazard band along the bottom edge
  g.save();
  g.beginPath();
  g.rect(18, 196, 476, 34);
  g.clip();
  g.fillStyle = 'rgba(122,14,6,0.5)';
  g.fillRect(18, 196, 476, 34);
  g.fillStyle = 'rgba(6,7,10,0.95)';
  for (let x = -60; x < 540; x += 34) {
    g.beginPath();
    g.moveTo(x, 230);
    g.lineTo(x + 17, 230);
    g.lineTo(x + 17 + 34, 196);
    g.lineTo(x + 34, 196);
    g.closePath();
    g.fill();
  }
  g.restore();

  // unit marking
  g.fillStyle = 'rgba(150,18,7,0.85)';
  g.font = 'bold 104px "DejaVu Sans Mono", monospace';
  g.fillText(mark, 24, 122);

  // sub label
  g.fillStyle = 'rgba(126,132,146,0.5)';
  g.font = 'bold 30px "DejaVu Sans Mono", monospace';
  g.fillText(sub, 28, 164);

  // warning triangle
  g.strokeStyle = 'rgba(150,18,7,0.7)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(430, 40);
  g.lineTo(468, 108);
  g.lineTo(392, 108);
  g.closePath();
  g.stroke();
  g.fillStyle = 'rgba(150,18,7,0.7)';
  g.fillRect(428, 62, 6, 26);
  g.fillRect(428, 94, 6, 7);

  // wear: a few scratches so the paint is not pristine
  for (let i = 0; i < 14; i++) {
    g.strokeStyle = `rgba(150,160,178,${0.05 + Math.random() * 0.09})`;
    g.lineWidth = 1 + Math.random() * 1.5;
    const y = Math.random() * 256;
    const x = Math.random() * 460;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 20 + Math.random() * 60, y + (Math.random() - 0.5) * 8);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ============================================================ geometry */

const cyl = (rt, rb, seg = 6) => new THREE.CylinderGeometry(rt, rb, 1, seg, 1);
const edgeOf = (geo, angle = 1) => new THREE.EdgesGeometry(geo, angle);

/** every triangle of a non-indexed hull geometry, in its own local space.
 *  Used to bolt real hardware onto the actual facets instead of guessing. */
function facetList(geo) {
  const pos = geo.attributes.position;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const n = b.clone().sub(a).cross(_v3.copy(c).sub(a)).normalize();
    if (n.dot(center) < 0) n.negate(); // these hulls are centred on the origin
    out.push({
      a: a.clone(),
      b: b.clone(),
      c: c.clone(),
      center,
      n,
      r: Math.max(a.distanceTo(center), b.distanceTo(center), c.distanceTo(center)),
    });
  }
  return out;
}

/** a plate laid flush over one facet: same triangle, shrunk and lifted */
function facetPlate(f, shrink, offset, material) {
  const g = new THREE.BufferGeometry();
  const v = [];
  for (const p of [f.a, f.b, f.c]) {
    _v1.copy(p).sub(f.center).multiplyScalar(shrink).add(f.center).addScaledVector(f.n, offset);
    v.push(_v1.x, _v1.y, _v1.z);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true;
  return mesh;
}

const GEO = {
  femur: cyl(0.036, 0.058),
  tibia: cyl(0.014, 0.034),
  foot: new THREE.ConeGeometry(0.026, 1, 4),
  spike: new THREE.ConeGeometry(0.014, 1, 4),
  hipJoint: new THREE.IcosahedronGeometry(0.058, 0),
  kneeJoint: new THREE.IcosahedronGeometry(0.042, 0),
  bead: new THREE.IcosahedronGeometry(0.012, 0),
  shoulder: new THREE.CylinderGeometry(0.082, 0.095, 0.032, 6, 1),
  eye: new THREE.SphereGeometry(1, 12, 9),
  // machinery
  gear: new THREE.CylinderGeometry(0.055, 0.055, 0.028, 9, 1),
  drum: new THREE.CylinderGeometry(0.052, 0.058, 0.046, 6, 1),
  notch: new THREE.BoxGeometry(0.03, 0.011, 0.014),
  tooth: new THREE.BoxGeometry(0.05, 0.022, 0.014),
  rod: cyl(0.011, 0.013, 5),
  sleeve: cyl(0.021, 0.025, 5),
  bolt: new THREE.CylinderGeometry(0.011, 0.011, 0.008, 6, 1),
  led: new THREE.BoxGeometry(0.017, 0.006, 0.01),
  cell: new THREE.BoxGeometry(0.006, 0.011, 0.03),
  deck: new THREE.CylinderGeometry(0.17, 0.18, 0.012, 6, 1),
  podBase: new THREE.CylinderGeometry(0.072, 0.08, 0.032, 8, 1),
  podHead: new THREE.BoxGeometry(0.072, 0.046, 0.064),
  podLens: new THREE.BoxGeometry(0.038, 0.023, 0.007),
};

/* ============================================================= leg spec */

// rows front -> back, x is +right (mirrored by `side`)
const LEG_DEFS = [
  { hip: [0.15, 0.01, 0.19], home: [0.52, 0.0, 0.70], side: 1, phase: 0.0, reach: 1.0 },
  { hip: [0.20, 0.01, 0.07], home: [0.80, 0.0, 0.26], side: 1, phase: 0.5, reach: 0.55 },
  { hip: [0.20, 0.01, -0.06], home: [0.82, 0.0, -0.26], side: 1, phase: 0.0, reach: 0.0 },
  { hip: [0.15, 0.01, -0.18], home: [0.54, 0.0, -0.68], side: 1, phase: 0.5, reach: 0.0 },
  { hip: [0.15, 0.01, 0.19], home: [0.52, 0.0, 0.70], side: -1, phase: 0.5, reach: 1.0 },
  { hip: [0.20, 0.01, 0.07], home: [0.80, 0.0, 0.26], side: -1, phase: 0.0, reach: 0.55 },
  { hip: [0.20, 0.01, -0.06], home: [0.82, 0.0, -0.26], side: -1, phase: 0.5, reach: 0.0 },
  { hip: [0.15, 0.01, -0.18], home: [0.54, 0.0, -0.68], side: -1, phase: 0.0, reach: 0.0 },
];

// raised threat / attack pose per row, in body-local space (x scaled by side)
const REACH_POSE = [
  new THREE.Vector3(0.32, 0.26, 0.86),
  new THREE.Vector3(0.66, 0.15, 0.62),
  new THREE.Vector3(0.90, 0.0, -0.30),
  new THREE.Vector3(0.86, 0.0, -0.70),
];

const FEMUR_LEN = 0.42;
const TIBIA_LEN = 0.66;

/* ==================================================================== */

export class Spider {
  constructor(scene) {
    this.root = new THREE.Group(); // on the floor: position + heading
    this.body = new THREE.Group(); // attitude + ride height
    this.shell = new THREE.Group(); // breathing chassis
    this.root.add(this.body);
    this.body.add(this.shell);
    scene.add(this.root);

    /* animation state -------------------------------------------------- */
    this.time = 0;
    this.state = 'BOOT';
    this.stateT = 0;
    this.fired = new Set();

    this.heading = 0.4;
    this.speed = 0;
    this.actualSpeed = 0;
    this.speedScale = 1;
    this.gaitClock = 0;
    this.gaitEnabled = false;
    this.maxSpeed = 0.95;
    this.maxSpeedSetting = 0.95;
    this.moveTarget = new THREE.Vector3();

    this.energy = 0.02;
    this.energyTarget = 0.02;
    this.eyeFlare = 0;
    this.flicker = 1;
    this.flickTimer = 1.4;
    this.flickDur = 0;

    this.ride = 0.62; // body height above the floor, damped
    this.rideTarget = 0.44;
    this.dropOffset = 0;
    this.dropOffsetTarget = 0;
    this.pitchD = 0;
    this.rollD = 0;
    this.pitchTarget = 0;
    this.rollTarget = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.lookWeight = 1;

    this.mandible = 0;
    this.mandibleTarget = 0;
    this.mandiblePulse = 0;
    this.squint = 1; // vertical gain on the primary slits

    this.autopilot = false;
    this.autoResume = false;
    this.idleTimer = 1.5;
    this.clickTimer = 3;
    this.stalkPause = 0;
    this.shake = 0; // request handed to the camera
    this.glitchT = 0;

    /* --- machine hardware state --------------------------------------- */
    this.servoStep = 0.028; // rad between femur detents — the whole leg bus
    this.detentAcc = 0; //      is driven by steppers, so every joint ticks
    this.detentRate = 0; //     detents per second, exposed for the audio
    this.detentT = 0;
    this.motorPulse = 0; //     square-wave carriage judder while rolling
    this.postT = -1; //         power-on self test timeline (>= 0 while running)
    this.podYaw = 0; //         scanner pod, snapped in discrete steps
    this.podTargetYaw = 0;
    this.podTimer = 0.5;
    this.podFlare = 0;
    this.ledPhase = 0;
    this.ledOn = [0, 0, 0];

    this.dropHeight = 3.6;

    this.onEvent = () => {};
    this.build();

    // standby: parked, legs tucked, core cold
    this.legs.forEach((l) => (l.fold = 1));
    this.energy = 0.02;
    this.energyTarget = 0.02;
    this.setState('BOOT');
  }

  /** drop the unit in from above and boot it up */
  deploy() {
    this.root.position.set(0, this.dropHeight, 0);
    this.heading = (Math.random() - 0.5) * 0.6;
    this.root.rotation.y = this.heading;
    this.speed = 0;
    this.actualSpeed = 0;
    this.moveTarget.set(0, 0, 0);
    this.legs.forEach((leg) => {
      leg.fold = 1;
      leg.reach = 0;
      leg.bind = false;
      leg.wasSwing = false;
      leg.t = leg.phase;
      this.groundHome(leg, leg.plantWorld);
      leg.worldTarget.copy(leg.plantWorld);
    });
    this.energy = 0.02;
    this.energyTarget = 0.02;
    this.ride = 0.62;
    this.rideTarget = 0.44;
    // hardware comes up dark and cold, and runs its self test on landing
    this.postT = 0;
    this.podYaw = 0;
    this.podTargetYaw = 0;
    this.podTimer = 0.5;
    this.podFlare = 0;
    this.detentAcc = 0;
    this.legs.forEach((leg) => {
      leg.detents = 0;
      leg.q = null;
    });
    this.setState('DEPLOY');
  }

  /* ============================================================== build */

  build() {
    this.buildBody();
    this.buildHardware();
    this.buildLegs();
  }

  buildBody() {
    const shell = this.shell;

    /* --- cephalothorax ------------------------------------------------ */
    const thoraxGeo = new THREE.CylinderGeometry(0.26, 0.325, 0.19, 6, 1);
    thoraxGeo.rotateY(Math.PI / 6);
    thoraxGeo.scale(0.96, 1, 1.24);
    const thorax = new THREE.Mesh(thoraxGeo, MAT.shell);
    thorax.castShadow = true;
    thorax.receiveShadow = true;
    thorax.add(new THREE.LineSegments(edgeOf(thoraxGeo), MAT.edge));
    shell.add(thorax);

    /* --- abdomen ------------------------------------------------------ */
    const abdGeo = new THREE.IcosahedronGeometry(0.34, 0);
    abdGeo.scale(1.0, 0.94, 1.24);
    const abdomen = new THREE.Mesh(abdGeo, MAT.plate);
    abdomen.position.set(0, 0.05, -0.47);
    abdomen.rotation.x = -0.12;
    abdomen.castShadow = true;
    abdomen.receiveShadow = true;
    abdomen.add(new THREE.LineSegments(edgeOf(abdGeo, 12), MAT.edge));
    shell.add(abdomen);
    this.abdomen = abdomen;

    // dorsal spines
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Mesh(GEO.spike, MAT.spike);
      sp.castShadow = true;
      const z = -0.28 - i * 0.16;
      const y = 0.31 - i * 0.055 - Math.abs(i - 1) * 0.02;
      sp.position.set(0, y, z);
      sp.userData.base = new THREE.Vector3(0, y - 0.02, z);
      sp.userData.dir = new THREE.Vector3(0, 0.86, -0.5).normalize();
      sp.userData.len = 0.13 - i * 0.016;
      shell.add(sp);
      this[`spine${i}`] = sp;
    }

    /* --- waist collar -------------------------------------------------- */
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.14), MAT.joint);
    collar.position.set(0, 0.015, -0.23);
    collar.castShadow = true;
    shell.add(collar);

    /* --- glowing internals -------------------------------------------- */
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xff2a10, toneMapped: true });
    this.beadMat = new THREE.MeshBasicMaterial({ color: 0x520a04, toneMapped: true });
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.011, 0.3), this.coreMat);
    vent.position.set(0, -0.078, 0.0);
    shell.add(vent);
    this.vent = vent;

    for (const s of [-1, 1]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.014, 0.36), this.coreMat);
      strip.position.set(0.075 * s, 0.086, -0.07);
      strip.rotation.y = -0.12 * s;
      shell.add(strip);
    }
    // core peeking out between the plate seams
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 0), this.coreMat);
    core.position.set(0, 0.0, -0.16);
    core.scale.set(1, 0.8, 1);
    shell.add(core);

    /* --- head ---------------------------------------------------------- */
    const head = new THREE.Group();
    head.position.set(0, 0.005, 0.30);
    shell.add(head);
    this.head = head;

    // wedge skull: the front face of the box is pulled in hard so the mask
    // reads as a pointed prow instead of a friendly brick
    const headGeo = new THREE.BoxGeometry(0.235, 0.145, 0.18);
    {
      const p = headGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (p.getZ(i) > 0.01) {
          p.setX(i, p.getX(i) * 0.6);
          p.setY(i, p.getY(i) * 0.86 - 0.006);
        }
      }
      p.needsUpdate = true;
      headGeo.computeVertexNormals();
    }
    const headMesh = new THREE.Mesh(headGeo, MAT.shell);
    headMesh.castShadow = true;
    headMesh.add(new THREE.LineSegments(edgeOf(headGeo), MAT.edge));
    head.add(headMesh);

    // heavy brow: two plates pitched into a V, deep enough to throw the
    // sensor band below into shadow
    for (const s of [-1, 1]) {
      const browGeo = new THREE.BoxGeometry(0.125, 0.034, 0.168);
      const brow = new THREE.Mesh(browGeo, MAT.plate);
      brow.position.set(0.055 * s, 0.072, 0.014);
      brow.rotation.x = -0.26;
      brow.rotation.z = 0.3 * s;
      brow.castShadow = true;
      brow.add(new THREE.LineSegments(edgeOf(browGeo), MAT.edgeDim));
      head.add(brow);
    }

    // crest blade between the brows, pitched forward over the optics
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.13, 4), MAT.spike);
    crest.position.set(0, 0.052, 0.045);
    crest.rotation.x = Math.PI * 0.62;
    crest.castShadow = true;
    head.add(crest);

    // cheek plates, pushed back to follow the taper; they carry the gauge
    for (const s of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.115, 0.145), MAT.plate);
      cheek.position.set(0.118 * s, -0.008, -0.02);
      cheek.rotation.z = 0.1 * s;
      cheek.castShadow = true;
      head.add(cheek);
    }

    // sensor band: a recessed monolith with the light inside it, not a
    // glowing strip across the face
    const bandGeo = new THREE.BoxGeometry(0.148, 0.055, 0.015);
    const band = new THREE.Mesh(bandGeo, MAT.dark);
    band.position.set(0, 0.022, 0.085);
    band.add(new THREE.LineSegments(edgeOf(bandGeo), MAT.edgeDim));
    head.add(band);

    // primary optics: two slits cut into the band, angled into a scowl
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a0a });
    this.slits = [];
    for (const s of [-1, 1]) {
      const housingGeo = new THREE.BoxGeometry(0.064, 0.018, 0.012);
      const housing = new THREE.Mesh(housingGeo, MAT.dark);
      housing.position.set(0.039 * s, 0.034, 0.094);
      housing.rotation.z = 0.32 * s;
      head.add(housing);

      // blade-shaped slit: thins towards the nose so the glare reads as a
      // scowl rather than a friendly bar
      const slitGeo = new THREE.BoxGeometry(0.058, 0.012, 0.01);
      const sp = slitGeo.attributes.position;
      for (let i = 0; i < sp.count; i++) {
        if (sp.getX(i) * s < 0) sp.setY(i, sp.getY(i) * 0.42);
      }
      sp.needsUpdate = true;
      slitGeo.computeVertexNormals();

      const slit = new THREE.Mesh(slitGeo, this.eyeMat);
      slit.position.set(0, 0, 0.004);
      housing.add(slit);
      this.slits.push(slit);
    }

    // arachnid secondary cluster: eight pinprick optics under the slits.
    // Deliberately tiny and cold — the glare belongs to the slits.
    this.lensMat = new THREE.MeshStandardMaterial({
      color: 0x07030a,
      metalness: 0.95,
      roughness: 0.07,
      envMapIntensity: 1.3,
    });
    this.pupilMat = new THREE.MeshBasicMaterial({ color: 0x3a0602 });
    const pupils = [
      [0.012, 0.008, 0.0058],
      [0.034, 0.011, 0.0066],
      [0.056, 0.006, 0.0054],
      [0.048, -0.003, 0.0046],
    ];
    for (const [x, y, r] of pupils) {
      for (const s of [-1, 1]) {
        const p = new THREE.Vector3(x * s, y, 0.0955);
        const lens = new THREE.Mesh(GEO.eye, this.lensMat);
        lens.position.copy(p);
        lens.scale.setScalar(r * 1.5);
        head.add(lens);

        const pupil = new THREE.Mesh(GEO.eye, this.pupilMat);
        const n = p.clone().sub(new THREE.Vector3(0, 0.02, 0.04)).normalize();
        pupil.position.copy(p).addScaledVector(n, r * 1.05);
        pupil.scale.setScalar(r * 0.5);
        head.add(pupil);
      }
    }

    // mouth: a caged furnace behind the fangs instead of a smile
    this.throatMat = new THREE.MeshBasicMaterial({ color: 0x2a0400 });
    const throat = new THREE.Mesh(new THREE.BoxGeometry(0.128, 0.05, 0.01), this.throatMat);
    throat.position.set(0, -0.04, 0.076);
    head.add(throat);

    const grille = new THREE.BoxGeometry(0.009, 0.05, 0.018);
    for (let i = -3; i <= 3; i++) {
      const bar = new THREE.Mesh(grille, i === 0 ? MAT.joint : MAT.chrome);
      bar.position.set(i * 0.019, -0.04, 0.084);
      bar.rotation.x = -0.14;
      bar.castShadow = true;
      head.add(bar);
    }

    this.eyeLight = new THREE.PointLight(0xff2400, 0.55, 1.8, 1);
    this.eyeLight.position.set(0, -0.052, 0.1);
    head.add(this.eyeLight);

    /* --- chelicerae: barbed fangs plus a second pair of outer claws ----- */
    this.mandibles = [];
    this.claws = [];
    for (const s of [-1, 1]) {
      /* inner arm — the fang */
      const m = new THREE.Group();
      m.position.set(0.062 * s, -0.055, 0.05);
      m.rotation.x = 0.22;
      head.add(m);

      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.044, 0.16), MAT.limb);
      arm.position.set(0, 0, 0.08);
      arm.castShadow = true;
      m.add(arm);

      const fang = new THREE.Mesh(new THREE.ConeGeometry(0.019, 0.15, 4), MAT.spike);
      fang.position.set(0, -0.03, 0.16);
      fang.rotation.x = Math.PI * 0.8;
      fang.castShadow = true;
      m.add(fang);

      // secondary barb off the fang shaft: hooks that catch the light
      const barb = new THREE.Mesh(GEO.spike, MAT.spike);
      alignCone(barb, _v1.set(0.006 * s, -0.042, 0.172), _v2.set(0.3 * s, -0.62, 0.72).normalize(), 0.06);
      barb.castShadow = true;
      m.add(barb);

      const tip = new THREE.Mesh(GEO.bead, this.beadMat);
      tip.position.set(0, -0.096, 0.208);
      m.add(tip);

      this.mandibles.push(m);

      /* outer claw — splays wide and opens the cage */
      const claw = new THREE.Group();
      claw.position.set(0.122 * s, -0.032, 0.014);
      claw.rotation.y = 0.34 * s;
      claw.rotation.x = 0.16;
      claw.userData.side = s;
      head.add(claw);

      const cArm = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.05, 0.115), MAT.limb);
      cArm.position.set(0, 0, 0.05);
      cArm.castShadow = true;
      claw.add(cArm);

      const hook = new THREE.Mesh(new THREE.ConeGeometry(0.017, 0.115, 4), MAT.spike);
      hook.position.set(0, -0.026, 0.115);
      hook.rotation.x = Math.PI * 0.72;
      hook.rotation.z = -0.28 * s;
      hook.castShadow = true;
      claw.add(hook);

      const clawTip = new THREE.Mesh(GEO.bead, this.beadMat);
      clawTip.position.set(0, -0.07, 0.161);
      claw.add(clawTip);

      this.claws.push(claw);
    }

    /* --- pedipalps (the twitchy little feelers) ------------------------ */
    this.palps = [];
    for (const s of [-1, 1]) {
      const p = new THREE.Group();
      p.position.set(0.108 * s, -0.028, 0.055);
      p.rotation.y = 0.45 * s;
      p.rotation.x = -0.15;
      head.add(p);
      const rod = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.015, 0.27), MAT.limb);
      rod.position.set(0, 0, 0.135);
      p.add(rod);
      // needle tips: feelers should read as probes, not antennae balls
      const ll = new THREE.Mesh(GEO.spike, MAT.spike);
      alignCone(ll, _v1.set(0, 0, 0.268), _v2.set(0, 0, 1), 0.035);
      p.add(ll);
      this.palps.push(p);
    }

    /* --- body glow ---------------------------------------------------- */
    // linear falloff: a decay-2 light this close to the hull burned the belly
    // plating white whenever the unit reared up, so it now sits lower and
    // falls off gently instead of falling off a cliff
    this.underGlow = new THREE.PointLight(0xff1c08, 1.55, 3.4, 1);
    this.underGlow.position.set(0, -0.24, -0.05);
    this.body.add(this.underGlow);
  }

  /** bolt heads around a point, in the plane of a facet (local to `parent`) */
  boltRing(parent, center, normal, radius, count, phase = 0) {
    const x = _v1.crossVectors(UPV, normal);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = _v2.crossVectors(normal, x).normalize();
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * TAU;
      const bolt = new THREE.Mesh(GEO.bolt, MAT.chrome);
      bolt.position
        .copy(center)
        .addScaledVector(x, Math.cos(a) * radius)
        .addScaledVector(y, Math.sin(a) * radius)
        .addScaledVector(normal, 0.004);
      bolt.quaternion.setFromUnitVectors(UPV, normal);
      parent.add(bolt);
    }
  }

  /** flat rectangular plate standing off a facet, text baseline kept level */
  facetDecal(parent, center, normal, w, h, material, lift = 0.007) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    plane.position.copy(center).addScaledVector(normal, lift);
    const x = _v1.crossVectors(UPV, normal);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = _v2.crossVectors(normal, x).normalize();
    _m1.makeBasis(x, y, normal);
    plane.quaternion.setFromRotationMatrix(_m1);
    parent.add(plane);
    return plane;
  }

  /** hull panelling, stencils, status strip, power gauge and scanner pod —
   *  the whole "this is a machine" layer, all built procedurally */
  buildHardware() {
    const shell = this.shell;
    const abdomen = this.abdomen;
    const abdGeo = abdomen.geometry;
    const toShell = new THREE.Matrix4().compose(abdomen.position, abdomen.quaternion, abdomen.scale);

    /* --- armour plates flush over the real icosahedron facets ---------- */
    const facets = facetList(abdGeo);
    const dorsal = [];
    for (const f of facets) {
      const n = f.n;
      if (n.y > 0.42) {
        // dorsal panel
        abdomen.add(facetPlate(f, 0.84, 0.004, MAT.hull));
        dorsal.push(f);
        this.boltRing(abdomen, f.center, n, f.r * 0.62, 3, 0.5);
      } else if (n.z < -0.55 && n.y < 0.3) {
        // recessed rear plating
        abdomen.add(facetPlate(f, 0.74, 0.002, MAT.dark));
      }
    }
    // the two plates facing the flanks get stencils
    const decals = [
      ['MK-0', 'UNIT 08 · DO NOT OPEN', new THREE.Vector3(0.92, 0.3, -0.36)],
      ['ARACHNID', 'PROTO · SERVO BUS 8X', new THREE.Vector3(-0.92, 0.3, -0.36)],
    ];
    for (const [mark, sub, dir] of decals) {
      let best = null;
      let bestDot = -2;
      for (const f of facets) {
        const d = f.n.dot(dir);
        if (d > bestDot) {
          bestDot = d;
          best = f;
        }
      }
      if (!best) continue;
      const mat = new THREE.MeshStandardMaterial({
        map: makeDecalTexture(mark, sub),
        transparent: true,
        depthWrite: false,
        metalness: 0.12,
        roughness: 0.8,
        envMapIntensity: 0.3,
      });
      const center = best.center.clone().applyMatrix4(toShell);
      const normal = best.n.clone().transformDirection(toShell);
      this.facetDecal(shell, center, normal, 0.3, 0.15, mat, 0.012);
    }

    /* --- thorax deck: status strip bolted straight onto the hull ------- */
    this.boltRing(shell, _p1.set(0, 0.097, 0.0), UPV, 0.205, 6, Math.PI / 6);

    this.ledMats = [];
    this.leds = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x2a0400 });
      const led = new THREE.Mesh(GEO.led, mat);
      led.position.set((i - 1) * 0.036, 0.104, 0.008);
      shell.add(led);
      // a machined bezel makes the lamp read as a fitted indicator
      const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.007, 0.018), MAT.chrome);
      bezel.position.set(led.position.x, 0.1005, led.position.z);
      shell.add(bezel);
      this.leds.push(led);
      this.ledMats.push(mat);
    }

    /* --- battery gauge on the cheeks ---------------------------------- */
    this.gaugeMats = [];
    for (let i = 0; i < 3; i++) this.gaugeMats.push(new THREE.MeshBasicMaterial({ color: 0x1d0401 }));
    this.gauge = [];
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const cell = new THREE.Mesh(GEO.cell, this.gaugeMats[i]);
        cell.position.set(0.146 * s, 0.036 - i * 0.032, 0.005);
        cell.rotation.y = -0.02 * s;
        this.gauge.push(cell);
        this.head.add(cell);
      }
    }

    /* --- scanner pod: slewing sensor turret on the thorax deck -------- */
    const pod = new THREE.Group();
    pod.position.set(0, 0.095, 0.165);
    shell.add(pod);
    this.pod = pod;

    // fixed gimbal base, bolted to the deck
    const baseMesh = new THREE.Mesh(GEO.podBase, MAT.carbon);
    baseMesh.position.y = 0.014;
    baseMesh.castShadow = true;
    baseMesh.add(new THREE.LineSegments(edgeOf(GEO.podBase), MAT.edgeDim));
    pod.add(baseMesh);
    this.boltRing(pod, _p1.set(0, 0.03, 0), UPV, 0.056, 4, 0.78);

    // the head yaws about the machine's up axis, so the sweep stays level
    const head = new THREE.Group();
    head.position.y = 0.032;
    pod.add(head);
    this.podHead = head;

    const housing = new THREE.Mesh(GEO.podHead, MAT.carbon);
    housing.castShadow = true;
    housing.add(new THREE.LineSegments(edgeOf(GEO.podHead), MAT.edgeDim));
    head.add(housing);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.03, 0.014), MAT.carbon);
    hood.position.set(0, 0.026, 0.026);
    head.add(hood);

    this.podLensMat = new THREE.MeshBasicMaterial({ color: 0x400600 });
    const lens = new THREE.Mesh(GEO.podLens, this.podLensMat);
    lens.position.set(0, -0.002, 0.034);
    head.add(lens);

    // whisker antenna so the turret never reads as a plain box
    const whisker = new THREE.Mesh(GEO.rod, MAT.carbon);
    whisker.position.set(0.036, 0.06, -0.012);
    whisker.scale.y = 0.11;
    head.add(whisker);
  }

  buildLegs() {
    this.legs = [];
    for (let i = 0; i < LEG_DEFS.length; i++) {
      const def = LEG_DEFS[i];
      const hip = new THREE.Vector3(def.hip[0] * def.side, def.hip[1], def.hip[2]);
      const home = new THREE.Vector3(def.home[0] * def.side, 0, def.home[2]);

      const leg = {
        index: i,
        row: i % 4,
        side: def.side,
        hip,
        home,
        phase: def.phase,
        t: def.phase,
        duty: 0.66,
        period: 0.72,
        plantWorld: new THREE.Vector3(),
        homeWorld: new THREE.Vector3(),
        swingFrom: new THREE.Vector3(),
        swingTo: new THREE.Vector3(),
        worldTarget: new THREE.Vector3(),
        localTarget: new THREE.Vector3(),
        peak: new THREE.Vector3(),
        knee: new THREE.Vector3(),
        foot: new THREE.Vector3(),
        footWorld: new THREE.Vector3(),
        reachScale: def.reach,
        reach: 0,
        fold: 0,
        bind: false,
        lastSeed: -1,
        wasSwing: false,
        tap: 0,
        tapT: 0,
        len1: FEMUR_LEN,
        len2: TIBIA_LEN,
        hipJoint: null,
        kneeJoint: null,
        femur: null,
        tibia: null,
        footCone: null,
        spikes: [],
        spikeDir: new THREE.Vector3(),
        firstStep: true,
        // stepper bus
        drum: null,
        drumNotch: null,
        gear: null,
        gearRoll: 0,
        gearLast: 0,
        ram: null,
        ramSleeve: null,
        q: null,
        detents: 0,
      };

      // anchors
      const shoulder = new THREE.Mesh(GEO.shoulder, MAT.plate);
      shoulder.position.copy(hip).add(new THREE.Vector3(hip.x * 0.42, 0.05, 0));
      shoulder.castShadow = true;
      this.shell.add(shoulder);

      leg.hipJoint = new THREE.Mesh(GEO.hipJoint, MAT.joint);
      leg.hipJoint.position.copy(hip);
      leg.hipJoint.castShadow = true;
      this.body.add(leg.hipJoint);

      leg.femur = new THREE.Mesh(GEO.femur, MAT.shell);
      leg.femur.castShadow = true;
      leg.femur.add(new THREE.LineSegments(edgeOf(cyl(0.038, 0.06)), MAT.edgeDim));
      this.body.add(leg.femur);

      leg.kneeJoint = new THREE.Mesh(GEO.kneeJoint, MAT.joint);
      leg.kneeJoint.castShadow = true;
      const bead = new THREE.Mesh(GEO.bead, this.beadMat);
      bead.position.y = 0.024;
      leg.kneeJoint.add(bead);
      this.body.add(leg.kneeJoint);

      leg.tibia = new THREE.Mesh(GEO.tibia, MAT.limb);
      leg.tibia.castShadow = true;
      leg.tibia.add(new THREE.LineSegments(edgeOf(cyl(0.016, 0.036)), MAT.edgeDim));
      this.body.add(leg.tibia);

      leg.footCone = new THREE.Mesh(GEO.foot, MAT.spike);
      leg.footCone.castShadow = true;
      this.body.add(leg.footCone);

      for (let s = 0; s < 2; s++) {
        const sp = new THREE.Mesh(GEO.spike, MAT.spike);
        sp.castShadow = true;
        sp.userData.at = 0.34 + s * 0.34;
        sp.userData.len = s === 0 ? 0.085 : 0.065;
        this.body.add(sp);
        leg.spikes.push(sp);
      }
      // one spike on the tibia sharpens the silhouette
      const shinSpike = new THREE.Mesh(GEO.spike, MAT.spike);
      shinSpike.castShadow = true;
      shinSpike.userData.at = -1;
      shinSpike.userData.len = 0.055;
      this.body.add(shinSpike);
      leg.spikes.push(shinSpike);

      leg.spikeDir
        .set(0.5 * def.side, 0.92, def.home[2] * 0.35)
        .normalize();

      /* --- driven hardware ---------------------------------------------
         Each joint is a visible mechanism: a servo drum at the coxa that
         yaws with the leg, a sprocket outboard of the knee that spins as
         the knee flexes, and a telescoping ram that makes up the length
         the stepper-quantised femur cannot reach. */
      leg.drum = new THREE.Mesh(GEO.drum, MAT.chrome);
      leg.drum.castShadow = true;
      leg.drumNotch = new THREE.Mesh(GEO.notch, MAT.carbon);
      leg.drumNotch.position.set(0.046, 0.014, 0);
      leg.drum.add(leg.drumNotch);
      this.body.add(leg.drum);

      leg.gear = new THREE.Mesh(GEO.gear, MAT.chrome);
      leg.gear.castShadow = true;
      leg.gearMark = new THREE.Mesh(GEO.tooth, MAT.carbon);
      leg.gearMark.position.set(0.026, 0.008, 0);
      leg.gear.add(leg.gearMark);
      this.body.add(leg.gear);

      leg.ramSleeve = new THREE.Mesh(GEO.sleeve, MAT.carbon);
      leg.ramSleeve.castShadow = true;
      this.body.add(leg.ramSleeve);
      leg.ram = new THREE.Mesh(GEO.rod, MAT.chrome);
      leg.ram.castShadow = true;
      this.body.add(leg.ram);

      // tucked pose used during the drop / shutdown
      _v1.copy(home).sub(hip);
      _v1.y = 0;
      _v1.normalize();
      leg.folded = hip.clone().addScaledVector(_v1, 0.34);
      leg.folded.y = -0.07;

      // raised pose used for threat / attack
      const rp = REACH_POSE[leg.row];
      leg.reachLocal = new THREE.Vector3(rp.x * def.side, rp.y, rp.z);

      this.groundHome(leg, leg.plantWorld);
      leg.worldTarget.copy(leg.plantWorld);
      this.legs.push(leg);
    }
  }

  /* ============================================================ helpers */

  /** hand control back after a one-shot behaviour finishes */
  releaseControl() {
    if (this.manualCmd) {
      this.manualCmd = false;
      this.autopilot = this.autoResume;
    }
  }

  setState(name) {
    if (this.state === name) return;
    // every mode change throws a solenoid: the unit is switched, not moody
    this.onEvent('relay', { from: this.state, to: name });
    this.state = name;
    this.stateT = 0;
    this.fired.clear();
    // poses that belong to the threat/attack timelines must not survive
    // a manual state change
    if (name === 'IDLE' || name === 'WALK' || name === 'STALK') {
      this.pitchTarget = 0;
      this.rollTarget = 0;
      this.energyTarget = 1;
      this.mandibleTarget = 0;
      this.legs.forEach((leg) => {
        leg.reach = 0;
        leg.bind = false;
      });
    }
  }

  /** stepper bus feedback: registers a detent and, throttled, turns it into
   *  a tick in the mix plus a micro-jolt through the chassis */
  detentPing(weight = 1) {
    if (this.detentT > 0) return;
    this.detentT = 0.035 + Math.random() * 0.045;
    this.onEvent('servo', { weight });
    this.jolt = Math.max(this.jolt || 0, 0.008 * weight);
  }

  fire(key, cond) {
    if (!cond || this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }

  forward(target) {
    return target.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** world-space ground position of a leg's rest spot — deliberately ignores
   *  the root's height so a drop/teleport can never drag the feet into the air */
  groundHome(leg, target) {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    target.set(leg.home.x * c + leg.home.z * s, 0, -leg.home.x * s + leg.home.z * c);
    target.x += this.root.position.x;
    target.z += this.root.position.z;
    return target;
  }

  headWorld(target) {
    return this.head.getWorldPosition(target);
  }

  /** one-shot autonomous behaviour picker */
  pickBehaviour(ctx) {
    const r = Math.random();
    if (r < 0.42) this.cmd('patrol', { keepAuto: true });
    else if (r < 0.6) this.cmd('stalk', { keepAuto: true });
    else if (r < 0.7) this.cmd('threat', { keepAuto: true });
    else if (r < 0.76) this.cmd('glitch', { keepAuto: true });
    else this.idleTimer = 2.5 + Math.random() * 4.5;
  }

  cmd(name, opts = {}) {
    if (!opts.keepAuto) {
      // remember what the operator had running so one-shot behaviours can
      // hand control back afterwards
      this.autoResume = this.autopilot;
      this.autopilot = false;
      this.manualCmd = true;
    } else {
      // the director issued this one — it keeps the wheel
      this.manualCmd = false;
    }
    switch (name) {
      case 'idle':
        this.moveTarget.copy(this.root.position);
        this.setState('IDLE');
        this.idleTimer = 3 + Math.random() * 3;
        break;
      case 'patrol': {
        const a = Math.random() * TAU;
        const r = 0.9 + Math.random() * 2.2;
        this.moveTarget.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        this.maxSpeedSetting = 0.9 + Math.random() * 0.25;
        this.setState('WALK');
        break;
      }
      case 'walk':
        this.cmd('patrol', opts);
        break;
      case 'stalk':
        this.setState('STALK');
        this.stalkPause = 0;
        break;
      case 'threat':
        this.setState('THREAT');
        break;
      case 'attack':
        this.setState('ATTACK');
        break;
      case 'glitch':
        this.setState('GLITCH');
        break;
      case 'power':
        if (this.state === 'BOOT' || this.state === 'DEPLOY') this.deploy();
        else if (this.state === 'DOWN') this.setState('WAKE');
        else this.setState('DOWN');
        break;
      default:
        break;
    }
  }

  teleportInFrontOfCamera(camera) {
    const dir = camera.getWorldDirection(_v1);
    dir.y = 0;
    dir.normalize();
    _v2.copy(camera.position).addScaledVector(dir, 1.15);
    _v2.y = 0;
    this.root.position.copy(_v2);
    this.heading = Math.atan2(-dir.x, -dir.z);
    this.root.rotation.y = this.heading;
    this.moveTarget.copy(this.root.position);
    this.speed = 0;
    this.legs.forEach((leg) => {
      leg.bind = true;
      this.groundHome(leg, leg.plantWorld);
      leg.worldTarget.copy(leg.plantWorld);
      leg.wasSwing = false;
      leg.t = leg.phase;
    });
    this.setState('SCARE');
  }

  startScare() {
    this.setState('SCARE');
  }

  returnToPad() {
    const a = Math.random() * TAU;
    this.root.position.set(Math.cos(a) * 1.9, 0, Math.sin(a) * 1.9);
    this.moveTarget.copy(this.root.position);
    this.speed = 0;
    this.legs.forEach((leg) => {
      leg.bind = false;
      leg.reach = 0;
      this.groundHome(leg, leg.plantWorld);
      leg.wasSwing = false;
      leg.t = leg.phase;
    });
    this.setState('IDLE');
    this.idleTimer = 2 + Math.random() * 3;
    this.autopilot = true;
  }

  /* =========================================================== thoughts */

  brain(dt, ctx) {
    const T = this.stateT;

    switch (this.state) {
      case 'DEPLOY': {
        const fall = 0.95;
        if (T < fall) {
          const p = T / fall;
          this.root.position.y = this.dropHeight * (1 - p * p);
          this.legs.forEach((l) => (l.fold = 1));
        } else {
          this.root.position.y = 0;
        }
        if (this.fire('land', T >= fall)) {
          this.onEvent('impact');
          this.shake = 0.7;
          this.dropOffsetTarget = -0.13;
          this.rollTarget = 0.05;
        }
        if (T >= fall) {
          this.dropOffsetTarget = 0;
          this.rollTarget *= 0.9;
          this.legs.forEach((leg, i) => {
            const t0 = fall + 0.3 + i * 0.08;
            leg.fold = 1 - smoothstep((T - t0) / 0.32);
          });

          /* power-on self test: the unit ticks every leg, in order, to prove
             the servo bus before it stands up — lamps and pod follow along */
          const post = T - (fall + 0.35);
          if (post >= 0 && this.postT >= 0 && post < 1.5) {
            this.postT = post;
            const i = Math.floor(post / 0.14);
            if (i >= 0 && i < 8 && post - i * 0.14 < dt * 1.6) {
              const leg = this.legs[i];
              leg.tap = 0.045;
              leg.tapT = 0.26;
              this.detentPing(0.9);
              this.postLeg = i;
            }
          }
          if (this.fire('ignite', T >= fall + 1.05)) {
            this.onEvent('powerup');
            this.energyTarget = 1;
          }
          if (this.fire('ready', T >= fall + 1.95)) {
            this.moveTarget.copy(this.root.position);
            this.setState('IDLE');
            this.autopilot = true;
            this.idleTimer = 1.6;
          }
        }
        break;
      }

      case 'DOWN': {
        this.legs.forEach((leg, i) => {
          leg.fold = Math.min(1, leg.fold + dt * 2.2);
          leg.reach = 0;
        });
        this.rideTarget = 0.2;
        this.lookWeight = 0;
        if (this.fire('off', T >= 0.55)) this.onEvent('powerdown');
        this.energyTarget = 0.03 + (Math.sin(T * 1.1) > 0.985 ? 0.14 : 0);
        break;
      }

      case 'WAKE': {
        this.rideTarget = 0.44;
        this.lookWeight = 1;
        if (this.fire('on', T >= 0.1)) this.onEvent('powerup');
        this.legs.forEach((leg, i) => {
          const t0 = 0.25 + i * 0.06;
          leg.fold = 1 - smoothstep((T - t0) / 0.3);
        });
        this.energyTarget = T > 0.5 ? 1 : 0.1;
        if (this.fire('done', T >= 1.55)) {
          this.setState('IDLE');
          this.idleTimer = 2;
          this.releaseControl();
        }
        break;
      }

      case 'IDLE': {
        this.rideTarget = 0.44;
        this.lookWeight = 1;
        this.speed = 0;
        this.idleTimer -= dt;

        // mandible clicks
        this.clickTimer -= dt;
        if (this.clickTimer <= 0) {
          this.clickTimer = 2.5 + Math.random() * 5;
          this.mandiblePulse = 0.24;
          this.onEvent('click');
        }
        // idle leg tap
        this.tapTimer = (this.tapTimer || 2) - dt;
        if (this.tapTimer <= 0) {
          this.tapTimer = 2 + Math.random() * 4;
          const leg = this.legs[(Math.random() * 8) | 0];
          leg.tap = 0.055;
          leg.tapT = 0.34;
          this.onEvent('click', { soft: true });
        }
        if (this.autopilot && this.idleTimer <= 0) this.pickBehaviour(ctx);
        break;
      }

      case 'WALK':
      case 'STALK': {
        this.rideTarget = this.state === 'STALK' ? 0.38 : 0.44;
        this.lookWeight = 1;

        if (this.state === 'STALK') {
          const cam = ctx.camera.position;
          _v1.set(cam.x, 0, cam.z);
          const cd = _v1.length();
          if (cd > 2.55) _v1.multiplyScalar(2.55 / cd);
          this.moveTarget.copy(_v1);
          this.maxSpeedSetting = 0.34;

          // freeze / sniff pauses make the approach feel deliberate
          this.stalkPause -= dt;
          if (this.stalkPause > 0) {
            this.stalled = true;
          } else {
            this.stalled = false;
            if (Math.random() < dt * 0.22) {
              this.stalkPause = 0.5 + Math.random() * 0.9;
              this.mandiblePulse = 0.3;
              this.onEvent('click');
            }
          }

          _v2.subVectors(cam, this.root.position);
          _v2.y = 0;
          const dist = _v2.length();
          const facing = _v2.normalize().dot(this.forward(_v3));
          if (this.autopilot && dist < 2.1 && facing > 0.45) {
            if (this.fire('pounce', true)) this.setState('ATTACK');
          }
        } else {
          this.maxSpeedSetting = this.maxSpeedSetting || 0.95;
          this.stalled = false;
        }

        _v3.set(this.moveTarget.x - this.root.position.x, 0, this.moveTarget.z - this.root.position.z);
        if (_v3.length() < 0.22 || T > 12) {
          this.moveTarget.copy(this.root.position);
          this.setState('IDLE');
          this.idleTimer = 1.2 + Math.random() * 3;
        }
        break;
      }

      case 'THREAT': {
        this.rideTarget = 0.46;
        this.lookWeight = 0;
        const rise = smoothstep(T / 0.45);
        const fall = 1 - smoothstep((T - 1.5) / 0.5);
        const amt = Math.min(rise, fall);
        this.pitchTarget = -0.55 * amt;
        this.rollTarget = 0;
        this.energyTarget = 1 + 0.5 * amt;
        this.eyeFlare = Math.max(this.eyeFlare, 0.5 * amt);
        this.mandibleTarget = 0.35 + 0.65 * amt * (Math.sin(T * 22) > 0 ? 1 : 0.25);
        this.legs.forEach((leg) => {
          leg.reach = leg.reachScale * amt;
          leg.bind = false;
        });
        if (this.fire('hiss', T >= 0.12)) this.onEvent('hiss');
        if (this.fire('clack', T >= 1.0)) {
          this.onEvent('click');
          this.mandiblePulse = 0.4;
        }
        if (this.fire('settle', T >= 2.1)) {
          this.pitchTarget = 0;
          this.energyTarget = 1;
          this.mandibleTarget = 0;
          this.legs.forEach((l) => (l.reach = 0));
          this.setState('IDLE');
          this.idleTimer = 2 + Math.random() * 3;
          this.releaseControl();
        }
        break;
      }

      case 'ATTACK':
        this.attackTimeline(dt, ctx, 1);
        break;

      case 'SCARE':
        this.attackTimeline(dt, ctx, 1.7);
        break;

      case 'GLITCH': {
        this.glitchT = 0.55;
        this.rideTarget = 0.44;
        if (this.fire('g', true)) this.onEvent('glitch');
        if (this.fire('end', T >= 0.6)) {
          this.setState('IDLE');
          this.idleTimer = 1.5 + Math.random() * 3;
          this.releaseControl();
        }
        break;
      }

      default:
        break;
    }
  }

  attackTimeline(dt, ctx, rate) {
    const T = this.stateT * rate;
    const sp = this.state === 'SCARE';

    /* phase A — rear up */
    const a = smoothstep(T / 0.45);
    /* phase B — lunge */
    const b = T < 0.45 ? 0 : easeOut((T - 0.45) / 0.16);
    /* phase C — fang snap */
    const c = T < 0.62 ? 0 : smoothstep((T - 0.62) / 0.07);
    /* phase D — recover / retreat */
    const d = T < 0.82 ? 0 : smoothstep((T - 0.82) / 1.1);

    const rear = a * (1 - smoothstep((T - 0.5) / 0.2)) * (1 - d);
    this.pitchTarget = -0.6 * rear + 0.16 * b * (1 - d);
    this.rideTarget = 0.44 + 0.07 * rear - 0.04 * b * (1 - d);
    this.lookWeight = 0;
    this.energyTarget = 1 + 1.2 * rear + 0.6 * b * (1 - d);
    this.eyeFlare = Math.max(this.eyeFlare, rear * 0.8 + b * 0.5);

    for (const leg of this.legs) {
      leg.reach = leg.reachScale * rear;
      leg.bind = !sp && b > 0 && b < 1;
    }

    // open, then slam shut
    const open = clamp(rear * 1.05, 0, 1) * (1 - c);
    this.mandibleTarget = open * 0.95 - 0.12 * c;

    if (this.fire('screech', T >= 0.05)) this.onEvent('screech');
    if (this.fire('lunge', T >= 0.45)) {
      this.onEvent('whoosh');
      this.shake = Math.max(this.shake, 0.35);
    }
    if (this.fire('snap', T >= 0.62)) {
      this.onEvent('snap');
      this.shake = Math.max(this.shake, sp ? 0.6 : 0.3);
      this.jolt = 0.14;
    }

    // forward drive during the lunge, retreat afterwards
    if (b > 0 && b < 1) {
      const drive = 0.95 / 0.16;
      const step = drive * b * dt * (sp ? 0.35 : 1);
      this.root.position.x += Math.sin(this.heading) * step;
      this.root.position.z += Math.cos(this.heading) * step;
      this.moveTarget.copy(this.root.position);
    }
    if (d > 0 && T > 1.0) {
      this.maxSpeedSetting = 0.55;
      this.moveTarget.set(
        this.root.position.x - Math.sin(this.heading) * 1.1,
        0,
        this.root.position.z - Math.cos(this.heading) * 1.1
      );
      this.stalled = false;
    }

    if (this.fire('done', T >= 2.0)) {
      this.pitchTarget = 0;
      this.energyTarget = 1;
      this.legs.forEach((l) => (l.reach = 0));
      if (sp) {
        this.onEvent('vanish');
      } else {
        this.moveTarget.copy(this.root.position);
        this.setState('IDLE');
        this.idleTimer = 1.6 + Math.random() * 2;
        this.releaseControl();
      }
    }
    // the unit delivers itself back to the pad — no external help needed
    if (sp && this.fire('home', T >= 2.16)) this.returnToPad();
  }

  /* ========================================================== movement */

  locomote(dt) {
    const pos = this.root.position;
    const dx = this.moveTarget.x - pos.x;
    const dz = this.moveTarget.z - pos.z;
    const dist = Math.hypot(dx, dz);

    let desired = 0;
    if (this.gaitEnabled && dist > 0.06 && !this.stalled) {
      desired = Math.min(this.maxSpeedSetting * this.speedScale, dist * 2.4);
    }
    const k = damp(dt, desired > this.speed ? 3.2 : 6.5);
    this.speed += (desired - this.speed) * k;
    if (this.speed < 0.015) this.speed = 0;

    if (this.speed > 0) {
      const dy = angleDelta(this.heading, Math.atan2(dx, dz));
      const turn = clamp(Math.abs(dy) / 1.3, 0, 1);
      // the drivetrain is a stepper carriage: it advances in small square-wave
      // pulses instead of gliding, which reads as motorised rather than alive
      const pulse = Math.sin(this.time * TAU * 7.5) > 0 ? 1 : 0;
      if (pulse !== this.motorPulse) {
        this.motorPulse = pulse;
        this.jolt = Math.max(this.jolt || 0, 0.005);
      }
      const judder = 1 + (pulse - 0.5) * 0.03;
      const v = this.speed * (1 - 0.6 * turn) * judder;
      this.heading += dy * damp(dt, 6);
      pos.x += Math.sin(this.heading) * v * dt;
      pos.z += Math.cos(this.heading) * v * dt;
      this.actualSpeed = v;
    } else {
      this.actualSpeed = 0;
    }

    const r = Math.hypot(pos.x, pos.z);
    if (r > 3.3) {
      pos.x *= 3.3 / r;
      pos.z *= 3.3 / r;
    }
    if (pos.y < 0.0001) pos.y = 0;
    this.root.rotation.y = this.heading;
  }

  /* ============================================================== pose */

  pose(dt, ctx) {
    const idleW = 1 - clamp(this.actualSpeed / 0.6, 0, 1);

    /* breathing chassis */
    const br = Math.sin(this.time * 1.5);
    const amt = 0.35 + 0.65 * idleW;
    this.shell.scale.set(
      1 + 0.012 * br * amt,
      1 + 0.022 * br * amt * (0.5 + this.energy * 0.5),
      1 + 0.012 * Math.sin(this.time * 1.13) * amt
    );
    this.shell.position.y = 0.008 * br * idleW;
    this.shell.rotation.z = Math.sin(this.time * 0.9) * 0.012 * idleW;

    /* power / glow */
    this.energy += (this.energyTarget - this.energy) * damp(dt, 3.5);

    this.flickTimer -= dt;
    if (this.flickTimer <= 0) {
      this.flickTimer = 1.4 + Math.random() * 4.5;
      this.flickDur = 0.04 + Math.random() * 0.1;
    }
    this.flickDur = Math.max(0, this.flickDur - dt);
    const flickGoal = this.flickDur > 0 ? 0.3 + Math.random() * 0.45 : 1;
    this.flicker += (flickGoal - this.flicker) * damp(dt, 22);

    this.eyeFlare = Math.max(0, this.eyeFlare - dt * 1.1);

    /* gait driven body motion */
    const sr = clamp(this.actualSpeed / this.maxSpeed, 0, 1.3);
    const g = this.gaitClock;
    const bob = Math.sin(g * TAU * 2) * 0.021 * sr;
    const gaitPitch = Math.cos(g * TAU * 2) * 0.02 * sr;
    const gaitRoll = Math.sin(g * TAU) * 0.045 * sr;

    /* glitch jitter */
    let jx = 0;
    let jy = 0;
    let jz = 0;
    if (this.glitchT > 0) {
      this.glitchT -= dt;
      const s = this.glitchT / 0.55;
      jx = (Math.random() - 0.5) * 0.05 * s;
      jy = (Math.random() - 0.5) * 0.05 * s;
      jz = (Math.random() - 0.5) * 0.05 * s;
      this.flicker = 0.15 + Math.random() * 1.4;
    }
    this.jolt = Math.max(0, (this.jolt || 0) - dt * 1.2);

    const k = damp(dt, 9);
    this.ride += (this.rideTarget - this.ride) * k;
    this.dropOffset += (this.dropOffsetTarget - this.dropOffset) * damp(dt, 14);
    this.pitchD += (this.pitchTarget + gaitPitch - this.pitchD) * k;
    this.rollD += (this.rollTarget + gaitRoll - this.rollD) * k;

    this.body.position.set(jx, this.ride + this.dropOffset + bob - this.jolt * 0.08, jz);
    this.body.rotation.x = this.pitchD + this.jolt * 0.9;
    this.body.rotation.z = this.rollD + jy * 2;
    this.body.rotation.y = jy * 1.5;

    /* head aim — the unit watches whatever the cursor is near */
    this.lookWeight += ((this.state === 'IDLE' || this.state === 'WALK' || this.state === 'STALK' ? 1 : 0) - this.lookWeight) * damp(dt, 4);
    if (ctx.aim) {
      _v1.copy(ctx.aim);
      this.root.worldToLocal(_v1);
      const dy = _v1.y - this.ride - this.head.position.y - 0.25;
      let yaw = Math.atan2(_v1.x, _v1.z);
      yaw = clamp(yaw, -0.7, 0.7);
      let pit = clamp(Math.atan2(dy, Math.max(0.3, Math.hypot(_v1.x, _v1.z))), -0.35, 0.5);
      const kk = damp(dt, 3.5);
      this.headYaw += (yaw * this.lookWeight + Math.sin(this.time * 0.7) * 0.05 - this.headYaw) * kk;
      this.headPitch += (pit * this.lookWeight - this.headPitch) * kk;
    }
    this.head.rotation.y = this.headYaw;
    this.head.rotation.x = -this.headPitch;

    /* mandibles */
    this.mandiblePulse = Math.max(0, this.mandiblePulse - dt);
    if (this.mandiblePulse > 0) this.mandibleTarget = Math.max(this.mandibleTarget, 0.4);
    this.mandible += (this.mandibleTarget - this.mandible) * damp(dt, this.mandibleTarget > this.mandible ? 16 : 22);
    const mo = this.mandible;
    this.mandibles[0].rotation.y = mo * 0.4;
    this.mandibles[1].rotation.y = -mo * 0.4;
    this.mandibles[0].rotation.x = 0.22 + mo * 0.12;
    this.mandibles[1].rotation.x = 0.22 + mo * 0.12;
    // the outer claws splay wider than the fangs — the whole cage opens
    for (const c of this.claws) {
      const s = c.userData.side;
      c.rotation.y = (0.34 + mo * 0.85) * s;
      c.rotation.x = 0.16 + mo * 0.22;
    }

    /* primary slits: narrow to a killing squint when locked on, snap wide
     * when the unit goes hostile */
    const squint =
      this.state === 'STALK'
        ? 0.32
        : this.state === 'THREAT' || this.state === 'ATTACK' || this.state === 'SCARE'
          ? 1.5
          : 1;
    this.squint += (squint - this.squint) * damp(dt, 6);
    this.slits[0].scale.y = this.squint;
    this.slits[1].scale.y = this.squint;

    /* twitchy pedipalps */
    const tw = Math.sin(this.time * 3.1) * 0.06 + Math.sin(this.time * 11.7) * 0.02 * (1 + this.energy);
    this.palps[0].rotation.x = -0.15 + tw;
    this.palps[1].rotation.x = -0.15 - tw * 0.8;

    /* spinneret / abdomen pulse */
    const pulse = 1 + Math.sin(this.time * 2.3) * 0.02 * this.energy;
    this.abdomen.scale.set(pulse, pulse, 1 + Math.sin(this.time * 1.7) * 0.015);

    /* dorsal spines lengthen slightly with power */
    for (let i = 0; i < 3; i++) {
      const sp = this[`spine${i}`];
      const len = sp.userData.len * (0.85 + this.energy * 0.25);
      alignCone(sp, sp.userData.base, sp.userData.dir, len);
    }

    /* emissive output */
    const f = this.flicker;
    const e = this.energy;
    const flare = this.eyeFlare;
    this.eyeMat.color.setRGB(
      clamp((0.06 + e * 0.95) * f + flare * 0.7, 0, 1.4),
      clamp(0.02 + flare * 0.07, 0, 1),
      0.014
    );
    this.beadMat.color.setRGB(clamp((0.02 + e * 0.2) * f, 0, 1), 0.012, 0.005);
    this.coreMat.color.setRGB(
      clamp((0.025 + e * 0.33) * f + flare * 0.18, 0, 1.2),
      clamp((0.002 + e * 0.035) * f, 0, 1),
      0.008
    );
    this.throatMat.color.setRGB(clamp(0.03 + e * 0.26 * f + flare * 0.42, 0, 1.05), 0.012, 0.006);
    this.pupilMat.color.setRGB(clamp((0.05 + e * 0.3) * f + flare * 0.25, 0, 1), 0.012, 0.006);
    this.underGlow.intensity = Math.min(1.9, (0.16 + e * 1.25) * f + flare * 1.1);
    this.eyeLight.intensity = (0.1 + e * 0.42) * f + flare * 0.9;
  }

  /* ========================================================== machinery */

  /** lamps, power gauge and the scanner pod: all the discrete behaviour
   *  that makes the unit read as hardware rather than an animal */
  machine(dt) {
    const t = this.time;
    const e = clamp(this.energy, 0, 1);
    const f = this.flicker * 0.4 + 0.6;
    const tick = (rate) => Math.floor(t * rate);

    /* --- status strip: coded, never smooth --------------------------- */
    let a = 0;
    let b = 0;
    let c = 0;
    switch (this.state) {
      case 'BOOT':
      case 'DOWN':
        break; // dark
      case 'DEPLOY': {
        const s = tick(9) % 9; // POST: channels come up one at a time
        a = s === 1 || s > 6 ? 1 : 0.06;
        b = s === 3 || s > 6 ? 1 : 0.06;
        c = s === 5 || s > 6 ? 1 : 0.06;
        break;
      }
      case 'WAKE': {
        const s = tick(7) % 7;
        a = s > 0 ? 1 : 0.25;
        b = s > 3 ? 0.85 : 0.12;
        c = s > 5 ? 0.85 : 0.12;
        break;
      }
      case 'ATTACK':
      case 'SCARE':
        a = 1;
        b = 1;
        c = tick(12) % 2 ? 1 : 0.25; // strobe while it is killing
        break;
      case 'THREAT': {
        const s = tick(6) % 2;
        a = 1;
        b = s ? 0.15 : 1;
        c = s ? 1 : 0.15;
        break;
      }
      case 'GLITCH':
        a = tick(23) % 3 ? 0.2 : 1;
        b = tick(19) % 2 ? 1 : 0.1;
        c = tick(29) % 4 ? 0.15 : 1;
        break;
      case 'WALK':
      case 'STALK': {
        const s = tick(2.6) % 4; // marching pattern while rolling
        a = 1;
        b = s < 2 ? 0.9 : 0.1;
        c = s >= 2 ? 0.9 : 0.1;
        break;
      }
      default: {
        const p = t % 2.6; // idle heartbeat: a short double pulse
        a = p < 0.09 || (p > 0.23 && p < 0.31) ? 1 : 0.12;
        b = 0.1;
        c = 0.08;
        break;
      }
    }
    const gate = 0.12 + 0.88 * e;
    const lamps = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const v = clamp(lamps[i] * gate * f, 0, 1.2);
      this.ledMats[i].color.setRGB(v, v * (i === 1 ? 0.05 : 0.12), 0.008);
    }

    /* --- power gauge: three cells per cheek -------------------------- */
    const lit = Math.round(e * 3);
    for (let i = 0; i < 3; i++) {
      const on = e > 0.06 && i < lit;
      const v = on ? (i === lit - 1 ? 0.95 : 0.45) * f : 0.02;
      this.gaugeMats[i].color.setRGB(clamp(v, 0, 1), v * 0.06, 0.005);
    }

    /* --- scanner pod: slews on a fixed grid, never smoothly ---------- */
    const hostile = this.state === 'THREAT' || this.state === 'ATTACK' || this.state === 'SCARE';
    this.podTimer -= dt;
    if (this.podTimer <= 0) {
      this.podTimer = 0.5 + Math.random() * 1.6;
      const want = hostile ? 0 : ((Math.random() * 2 - 1) * 1.25) / POD_STEP;
      this.podTargetYaw = Math.round(want) * POD_STEP;
      this.podFlare = 1;
      this.onEvent('scan', { hostile });
    }
    if (hostile) this.podTargetYaw = 0;
    this.podFlare = Math.max(0, this.podFlare - dt * 2.6);
    this.podStepT = (this.podStepT ?? 0) - dt;
    const detents = Math.round((this.podTargetYaw - this.podYaw) / POD_STEP);
    if (detents !== 0 && this.podStepT <= 0) {
      this.podStepT = 0.055; // stepped slew rate, one detent at a time
      this.podYaw += Math.sign(detents) * POD_STEP;
      this.detentPing(0.5);
    }
    this.podHead.rotation.y = this.podYaw;
    const hot = this.podFlare > 0.55 ? 1 : 0.28;
    this.podLensMat.color.setRGB(
      clamp((0.14 + e * 0.5) * hot * f + this.podFlare * 0.35, 0, 1.2),
      0.012,
      0.005
    );

    /* --- detent bookkeeping for the readout / audio ------------------ */
    const rate = this.detentAcc / Math.max(dt, 1e-4);
    this.detentRate += (rate - this.detentRate) * damp(dt, 5);
    this.detentAcc = 0;
  }

  /* ============================================================== legs */

  stepLeg(leg, dt) {
    const moving = this.gaitEnabled && this.actualSpeed > 0.05 && !this.stalled;
    const spd = Math.max(this.actualSpeed, 0.28);
    leg.period = 0.72 * clamp(0.9 / spd, 0.5, 1.7);
    leg.duty = 0.68 - 0.22 * clamp(this.actualSpeed / this.maxSpeed, 0, 1);
    const period = leg.period;
    const duty = leg.duty;

    let adv = 0;
    const phase = leg.t % 1;
    if (moving) adv = dt / period;
    else if (phase > duty) adv = dt / (period * 0.55); // always finish a swing

    leg.t += adv;
    const p = leg.t % 1;
    const cycle = Math.floor(leg.t);
    const inSwing = p > duty;

    _v1.set(this.root.position.x, 0, this.root.position.z);
    const worldHome = leg.homeWorld;
    this.groundHome(leg, worldHome);

    if (inSwing) {
      if (leg.lastSeed !== cycle) {
        leg.lastSeed = cycle;
        leg.swingFrom.copy(leg.worldTarget);
        const periodDist = this.actualSpeed * period;
        this.forward(_v2);
        leg.swingTo.copy(worldHome).addScaledVector(_v2, periodDist * 0.5);
        leg.swingTo.x += (Math.random() - 0.5) * 0.05;
        leg.swingTo.z += (Math.random() - 0.5) * 0.05;
      }
      const s = (p - duty) / (1 - duty);
      const e = smoothstep(s);
      leg.worldTarget.lerpVectors(leg.swingFrom, leg.swingTo, e);
      leg.worldTarget.y += Math.sin(Math.PI * s) * (0.075 + 0.09 * clamp(this.actualSpeed / this.maxSpeed, 0, 1));
      leg.wasSwing = true;
    } else {
      if (leg.wasSwing) {
        leg.wasSwing = false;
        leg.plantWorld.copy(leg.swingTo);
        // audible footfall scaled by how hard the step is
        if (this.actualSpeed > 0.1 && this.state !== 'DEPLOY') {
          this.stepSound = (this.stepSound || 0) - dt;
          if (this.stepSound <= 0) {
            this.stepSound = 0.045;
            this.onEvent('step', { weight: 0.3 + clamp(this.actualSpeed, 0, 1.4) * 0.7, row: leg.row });
          }
        }
      }
      leg.worldTarget.copy(leg.plantWorld);
    }
    leg.firstStep = false;

    if (leg.bind) leg.worldTarget.copy(worldHome);

    // idle tap
    if (leg.tapT > 0) {
      leg.tapT -= dt;
      const s = Math.sin(Math.PI * (1 - leg.tapT / 0.34));
      leg.worldTarget.y += s * leg.tap;
      leg.worldTarget.x += Math.sin(this.time * 3 + leg.index) * s * 0.02;
    } else {
      leg.tapT = 0;
    }
    leg.worldTarget.y = Math.max(0, leg.worldTarget.y);

    /* -------- to body space + pose overrides -------- */
    leg.localTarget.copy(leg.worldTarget);
    this.body.worldToLocal(leg.localTarget);
    if (leg.fold > 0.001) leg.localTarget.lerp(leg.folded, leg.fold);
    if (leg.reach > 0.001) leg.localTarget.lerp(leg.reachLocal, leg.reach);

    this.solveIK(leg);
    leg.planted = !inSwing;
    leg.footWorld.copy(leg.foot).applyMatrix4(this.body.matrixWorld);
  }

  solveIK(leg) {
    const hip = leg.hip;
    const target = leg.localTarget;
    const l1 = leg.len1;
    const l2 = leg.len2;

    _v1.subVectors(target, hip);
    let d = _v1.length();
    const maxD = l1 + l2 - 0.008;
    const minD = Math.abs(l1 - l2) + 0.02;
    if (d > maxD) {
      _v1.multiplyScalar(maxD / d);
      target.copy(hip).add(_v1);
      d = maxD;
    } else if (d < minD) {
      if (d < 1e-4) _v1.set(0, -1, 0);
      _v1.normalize().multiplyScalar(minD);
      target.copy(hip).add(_v1);
      d = minD;
    }
    _v2.copy(_v1).multiplyScalar(1 / d); // hip -> foot, unit

    // knee pole: up and outboard
    _v3.set(hip.x, 0, hip.z);
    if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, 1);
    _v3.normalize().multiplyScalar(0.55);
    _v3.y += 0.85;
    _v3.addScaledVector(_v2, -_v3.dot(_v2));
    if (_v3.lengthSq() < 1e-6) _v3.set(0, 1, 0).addScaledVector(_v2, -_v2.y);
    _v3.normalize();

    const a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
    const b = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
    leg.knee.copy(hip).addScaledVector(_v2, a).addScaledVector(_v3, b);
    leg.foot.copy(target);

    /* --- stepper bus: the femur only ever sits on discrete detents -----
       The tibia then stretches to the true ground point, so the mechanism
       is visibly digital while the foot still lands exactly where the gait
       engine put it. */
    _v1.subVectors(leg.knee, hip);
    const femurLen = _v1.length();
    let femurDir = null;
    if (femurLen > 1e-5) {
      _v1.multiplyScalar(1 / femurLen);
      const q = quantizeDir(_v1, this.servoStep, leg.q);
      leg.knee.copy(hip).addScaledVector(_v1, femurLen);
      if (q.moved > 0) {
        leg.detents += q.moved;
        this.detentAcc += q.moved;
        this.detentPing(clamp(0.28 + q.moved * 0.22, 0.28, 1.2));
      }
      leg.q = q;
      femurDir = _p1.copy(_v1);
    }

    _v2.subVectors(leg.foot, leg.knee);
    const shinLen = _v2.length();
    if (shinLen > 1e-5) _v2.multiplyScalar(1 / shinLen);

    // the knee sprocket is driven by the change in knee angle
    const bend = femurDir ? Math.acos(clamp(femurDir.dot(_v2), -1, 1)) : leg.gearLast;
    leg.gearRoll += (bend - leg.gearLast) * 2.4;
    leg.gearLast = bend;

    alignSegment(leg.femur, hip, leg.knee);
    leg.hipJoint.position.copy(hip);
    leg.kneeJoint.position.copy(leg.knee);
    alignSegment(leg.tibia, leg.knee, leg.foot);

    /* --- mechanism placement ------------------------------------------ */
    if (femurDir) {
      // coxa servo drum yaws to face the way the leg is working
      leg.drum.position.copy(hip);
      leg.drum.rotation.y = Math.atan2(femurDir.x, femurDir.z);

      // sprocket outboard of the knee, axis normal to the leg plane
      _v3.crossVectors(femurDir, _v2);
      if (_v3.lengthSq() < 1e-8) _v3.set(0, 1, 0);
      _v3.normalize().multiplyScalar(leg.side);
      leg.gear.position.copy(leg.knee).addScaledVector(_v3, 0.036);
      leg.gear.quaternion.setFromUnitVectors(UPV, _v3);
      leg.gear.rotateY(leg.gearRoll);
    }

    // telescoping ram: fixed sleeve on the shin, ram sliding through it
    alignSegment(
      leg.ramSleeve,
      _p2.copy(leg.knee).addScaledVector(_v2, 0.05),
      _p3.copy(leg.knee).addScaledVector(_v2, 0.34)
    );
    alignSegment(
      leg.ram,
      _p2.copy(leg.knee).addScaledVector(_v2, 0.2),
      _p3.copy(leg.foot).addScaledVector(_v2, -0.035)
    );

    _v4.copy(_v2);
    _v1.copy(leg.foot).addScaledVector(_v4, -0.02);
    alignCone(leg.footCone, _v1, _v4, 0.105);

    for (const sp of leg.spikes) {
      if (sp.userData.at < 0) {
        // tibia spike: rides the shin, pointing up and back
        _v1.copy(leg.knee).lerp(leg.foot, 0.34).addScaledVector(leg.spikeDir, 0.018);
        alignCone(sp, _v1, leg.spikeDir, sp.userData.len);
      } else {
        _v1.copy(hip).lerp(leg.knee, sp.userData.at).addScaledVector(leg.spikeDir, 0.02);
        alignCone(sp, _v1, leg.spikeDir, sp.userData.len);
      }
    }
  }

  /* ============================================================== tick */

  update(dt, ctx) {
    this.time += dt;
    this.stateT += dt;

    // gait states
    this.gaitEnabled =
      this.state === 'WALK' || this.state === 'STALK' || (this.state === 'ATTACK' && this.stateT > 1.0) || (this.state === 'SCARE' && this.stateT > 1.4);

    this.brain(dt, ctx);
    this.locomote(dt);
    this.pose(dt, ctx);
    this.machine(dt);

    // the leg IK converts world targets into body space, so matrices must be current
    this.root.updateMatrixWorld(true);

    const gaitRate = this.gaitEnabled && this.actualSpeed > 0.05 ? 1 : 0;
    if (gaitRate) this.gaitClock += dt / (0.72 * clamp(0.9 / Math.max(this.actualSpeed, 0.28), 0.5, 1.7));

    for (const leg of this.legs) this.stepLeg(leg, dt);

    if (this.speed > 0.05) this.onEvent('move', { speed: this.actualSpeed });
  }
}
