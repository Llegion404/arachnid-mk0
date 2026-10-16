// Motion verification: samples the simulation and asserts the gait, IK and
// state machine behave (no NaNs, feet plant/lift, states cycle, no errors).
import { chromium } from 'playwright-core';

const PAGE_URL = process.env.URL || 'http://127.0.0.1:8137/index.html';

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(PAGE_URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.MK0);

const results = await page.evaluate(async () => {
  const { spider, step, camera } = window.MK0;
  const out = { checks: [], fail: [] };
  const ok = (name, cond, info = '') => {
    out.checks.push(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
    if (!cond) out.fail.push(name);
  };

  const finite = (obj) => [obj.x, obj.y, obj.z].every((v) => Number.isFinite(v));
  const allFinite = () => spider.legs.every((l) => finite(l.knee) && finite(l.foot) && finite(l.localTarget));

  // ---------- boot / deploy ----------
  spider.deploy();
  step(300);
  ok(
    'deploy ends the boot sequence',
    spider.state !== 'BOOT' && spider.state !== 'DEPLOY' && spider.legs.every((l) => l.fold < 0.02),
    spider.state
  );
  ok('deploy leaves unit on the floor', Math.abs(spider.root.position.y) < 0.001);

  // ---------- walking gait ----------
  const resetFeet = (x = 0, z = 0, heading = 0) => {
    spider.root.position.set(x, 0, z);
    spider.moveTarget.set(x, 0, z);
    spider.heading = heading;
    spider.root.rotation.y = heading;
    spider.speed = 0;
    spider.actualSpeed = 0;
    spider.root.updateMatrixWorld(true);
    spider.legs.forEach((l) => {
      spider.groundHome(l, l.plantWorld);
      l.worldTarget.copy(l.plantWorld);
      l.wasSwing = false;
      l.lastSeed = -1;
      l.t = l.phase;
    });
  };

  spider.autopilot = false;
  resetFeet(0, 0, 0);
  spider.moveTarget.set(0, 0, 3.2);
  spider.maxSpeedSetting = 0.95;
  spider.setState('WALK');

  const samples = spider.legs.map(() => []);
  const bodySamples = [];
  for (let i = 0; i < 200; i++) {
    step(1);
    spider.legs.forEach((l, idx) => {
      samples[idx].push({
        x: +l.footWorld.x.toFixed(4),
        y: +l.footWorld.y.toFixed(4),
        z: +l.footWorld.z.toFixed(4),
        planted: l.planted,
      });
    });
    bodySamples.push({ x: spider.root.position.x, z: spider.root.position.z, y: spider.body.position.y });
  }

  ok('walk moves the body', Math.hypot(bodySamples.at(-1).x, bodySamples.at(-1).z) > 0.8, `moved ${Math.hypot(bodySamples.at(-1).x, bodySamples.at(-1).z).toFixed(2)}m`);
  const travel = bodySamples.at(-1).z - bodySamples[0].z;
  ok('walk travels the commanded direction', travel > 0.8, `dz=${travel.toFixed(2)}`);
  ok('body bobs while walking', (() => {
    const ys = bodySamples.map((b) => b.y);
    return Math.max(...ys) - Math.min(...ys) > 0.01;
  })());

  const legReport = [];
  let legsWithStance = 0;
  let legsWithSwing = 0;
  let maxLift = 0;
  let worstSlide = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const lift = Math.max(...s.map((p) => p.y));
    maxLift = Math.max(maxLift, lift);
    // a foot flagged as planted must not slide along the floor in world space
    let plantedFrames = 0;
    let slide = 0;
    for (let k = 1; k < s.length; k++) {
      if (!s[k].planted) continue;
      plantedFrames++;
      slide = Math.max(slide, Math.hypot(s[k].x - s[k - 1].x, s[k].z - s[k - 1].z));
    }
    worstSlide = Math.max(worstSlide, slide);
    if (plantedFrames > 20) legsWithStance++;
    if (lift > 0.05) legsWithSwing++;
    legReport.push(`leg${i} lift=${lift.toFixed(3)} planted=${plantedFrames} maxSlide=${slide.toFixed(4)}`);
  }
  ok('every leg plants on the ground', legsWithStance === 8, `${legsWithStance}/8`);
  ok('every leg lifts during swing', legsWithSwing === 8, `${legsWithSwing}/8`);
  ok('planted feet do not slide', worstSlide < 0.02, `worst slide ${worstSlide.toFixed(4)}m/frame`);
  ok('swing clears the floor', maxLift > 0.04, `${maxLift.toFixed(3)}m`);
  ok('no NaN during walk', allFinite());

  // feet must stay inside the serviceable radius (no torn-off legs)
  const maxReach = Math.max(
    ...spider.legs.map((l) => l.localTarget.distanceTo(l.hip))
  );
  ok('legs stay within link length', maxReach <= spider.legs[0].len1 + spider.legs[0].len2 + 1e-6, `${maxReach.toFixed(3)}`);

  // ---------- attack ----------
  spider.setState('IDLE');
  resetFeet(0, 0, 0);
  step(30);
  const before = { x: spider.root.position.x, z: spider.root.position.z };
  spider.cmd('attack');
  let minPitch = 0;
  let fangOpenMax = 0;
  let peakForward = 0;
  const fwd = Math.atan2(spider.moveTarget.x - before.x, spider.moveTarget.z - before.z);
  for (let i = 0; i < 150; i++) {
    step(1);
    minPitch = Math.min(minPitch, spider.body.rotation.x);
    fangOpenMax = Math.max(fangOpenMax, spider.mandible);
    const dx = spider.root.position.x - before.x;
    const dz = spider.root.position.z - before.z;
    peakForward = Math.max(peakForward, dx * Math.sin(spider.heading) + dz * Math.cos(spider.heading));
    void fwd;
  }
  ok('attack rears the body up', minPitch < -0.3, `pitch=${minPitch.toFixed(2)}`);
  ok('attack opens the fangs', fangOpenMax > 0.5, `open=${fangOpenMax.toFixed(2)}`);
  ok('attack lunges forward', peakForward > 0.45, `peak ${peakForward.toFixed(2)}m`);
  ok('attack recovers to IDLE', spider.state === 'IDLE', spider.state);
  ok('attack leaves the unit standing', spider.legs.every((l) => l.foot.isVector3 && l.reach < 0.05));

  // ---------- threat ----------
  spider.cmd('threat');
  step(140);
  ok('threat settles back to IDLE', spider.state === 'IDLE', spider.state);
  ok('threat clears reach pose', spider.legs.every((l) => l.reach < 0.05));

  // ---------- power ----------
  spider.cmd('power');
  step(120);
  ok('power off folds the legs', spider.state === 'DOWN' && spider.legs.every((l) => l.fold > 0.9));
  ok('power off dims the core', spider.energy < 0.12, spider.energy.toFixed(3));
  spider.cmd('power');
  step(140);
  ok('power on returns to IDLE', spider.state === 'IDLE', spider.state);
  ok('power on unfolds the legs', spider.legs.every((l) => l.fold < 0.02));

  // ---------- jumpscare ----------
  spider.cmd('idle');
  camera.position.set(2, 1, 2);
  spider.teleportInFrontOfCamera(camera);
  const d0 = spider.root.position.distanceTo(camera.position);
  ok('jumpscare spawns next to the camera', d0 < 1.6, `${d0.toFixed(2)}m`);
  let vanished = false;
  const origEvent = spider.onEvent;
  spider.onEvent = (n, d) => {
    if (n === 'vanish') vanished = true;
    origEvent(n, d);
  };
  step(220);
  spider.onEvent = origEvent;
  ok('jumpscare fires vanish', vanished);
  ok('jumpscare returns to the pad', Math.hypot(spider.root.position.x, spider.root.position.z) > 0.5);
  ok('jumpscare ends in IDLE', spider.state === 'IDLE', spider.state);

  // ---------- long autonomous run ----------
  spider.autopilot = true;
  spider.idleTimer = 0;
  const seen = new Set();
  let maxSpeed = 0;
  const states = [];
  const behaviourCounts = {};
  let lastState = spider.state;
  for (let i = 0; i < 6000; i++) {
    step(1);
    seen.add(spider.state);
    if (spider.state !== lastState) {
      behaviourCounts[spider.state] = (behaviourCounts[spider.state] || 0) + 1;
      lastState = spider.state;
    }
    states.push(spider.state);
    maxSpeed = Math.max(maxSpeed, spider.actualSpeed);
    if (!allFinite()) {
      out.fail.push('NaN appeared during autonomous run at step ' + i);
      break;
    }
  }
  ok('autopilot exercises many states', seen.size >= 3, [...seen].join(','));
  ok('autopilot keeps deciding on its own', Object.keys(behaviourCounts).length >= 4, JSON.stringify(behaviourCounts));
  ok('autopilot keeps the unit on the pad', Math.hypot(spider.root.position.x, spider.root.position.z) <= 3.35);
  ok('speed stays bounded', maxSpeed < 3, maxSpeed.toFixed(2));
  ok('no NaN over 70s of autonomy', allFinite());

  out.legReport = legReport;
  out.stateSequence = states.filter((s, i) => s !== states[i - 1]).join(' > ');
  return out;
});

console.log(results.checks.join('\n'));
console.log('\nstate sequence:', results.stateSequence);
console.log(results.legReport?.join('\n'));
console.log('\nFAILURES:', results.fail.length ? results.fail.join(', ') : 'none');
console.log('page errors:', errors.length ? errors.join(' | ') : 'none');

await browser.close();
process.exit(results.fail.length || errors.length ? 1 : 0);
