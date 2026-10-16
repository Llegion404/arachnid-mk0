// Headless visual check: boots the page in the installed Chrome, drives the UI
// and writes screenshots to /shots. Simulation is stepped deterministically so
// shots are identical no matter how slow the software renderer is.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const PAGE_URL = process.env.URL || 'http://127.0.0.1:8137/index.html';
const OUT = new URL('../shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(PAGE_URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.MK0);
await page.waitForTimeout(800);

const shot = async (name, ms = 850) => {
  // freeze the simulation first: the pose and camera must not drift while the
  // software renderer takes its time drawing the frame
  await page.evaluate(() => window.MK0.pause());
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await page.evaluate(() => window.MK0.resume());
  console.log('shot', name);
};
const step = (n) => page.evaluate((k) => window.MK0.step(k), n);

/** park the unit at a known spot/heading with clean planted feet */
const place = (x = 0, z = 0, heading = 0) =>
  page.evaluate(
    ([px, pz, h]) => {
      const s = window.MK0.spider;
      s.autopilot = false;
      s.cmd('idle');
      s.root.position.set(px, 0, pz);
      s.moveTarget.copy(s.root.position);
      s.heading = h;
      s.root.rotation.y = h;
      s.speed = 0;
      s.actualSpeed = 0;
      s.root.updateMatrixWorld(true);
      s.legs.forEach((l) => {
        l.plantWorld.copy(l.home).applyMatrix4(s.root.matrixWorld);
        l.worldTarget.copy(l.plantWorld);
        l.wasSwing = false;
        l.t = l.phase;
      });
    },
    [x, z, heading]
  );

/** place the camera relative to the unit's current pose (survives locomotion) */
const frame = (dist = 2.6, height = 1.2, yaw = 0.9, lookAhead = 0.25) =>
  page.evaluate(
    ([d, h, y, la]) => {
      const s = window.MK0.spider;
      const { camera } = window.MK0;
      const a = s.heading + y;
      camera.position.set(
        s.root.position.x - Math.sin(a) * d,
        h,
        s.root.position.z - Math.cos(a) * d
      );
      camera.lookAt(
        s.root.position.x + Math.sin(s.heading) * la,
        0.45,
        s.root.position.z + Math.cos(s.heading) * la
      );
    },
    [dist, height, yaw, lookAhead]
  );

const view = (pos, target = [0, 0.42, 0]) =>
  page.evaluate(
    ([p, t]) => {
      const { camera } = window.MK0;
      camera.position.set(p[0], p[1], p[2]);
      camera.lookAt(t[0], t[1], t[2]);
    },
    [pos, target]
  );

/* ------------------------------------------------------------------ run */

await shot('00-boot', 250);
await page.click('#bootbtn');

await step(30);
await shot('01-falling', 250);

await step(26);
await shot('02-impact', 250);

await step(160);
await place();
await step(20);
await view([0, 0.55, 2.35]);
await shot('03-front');

await view([2.3, 0.45, 0.15]);
await shot('04-side');

await view([1.55, 1.0, 1.7]);
await shot('05-three-quarter');

await view([0.05, 2.35, 1.45]);
await shot('06-top');

await view([-1.35, 0.75, -1.95]);
await shot('07-rear');

await view([0.34, 0.52, 1.0], [0, 0.46, 0.3]);
await shot('08-head-closeup');

// --- machine hardware: deck turret + status strip, then a hull stencil ---
await view([0.36, 0.88, 0.74], [0, 0.55, 0.08]);
await shot('08b-deck', 400);

await view([0.8, 0.66, -0.3], [0.12, 0.52, -0.5]);
await shot('08c-stencil', 400);

// --- attack (low front angle, fangs towards camera) ---
await view([0.72, 0.3, 2.0], [0, 0.5, 0.25]);
await page.click('[data-cmd="attack"]');
await step(24);
await shot('09-attack-rear-up', 300);
await step(13);
await shot('10-attack-lunge', 300);
await step(20);
await shot('11-attack-snap', 300);

// --- locomotion (the camera is re-framed after the steps: the unit moves) ---
await place(0, 0, 2.6);
await page.click('[data-cmd="walk"]');
await step(58);
await frame(3.1, 1.15, 1.15, 0.35);
await shot('12-walk', 300);

await step(30);
await frame(3.3, 1.7, 2.35, 0.3);
await shot('13-walk-3q', 300);

// --- stalking: slow, low to the ground, servo detents at eye level ---
await place(0, 0, 2.2);
await page.click('[data-cmd="stalk"]');
await step(70);
await frame(2.5, 0.6, 1.85, 0.3);
await shot('12b-stalk', 300);

await place(0, 0, 0);
await view([0.9, 0.42, 1.9], [0, 0.5, 0.1]);
await page.click('[data-cmd="threat"]');
await step(24);
await shot('14-threat', 300);

// --- power off ---
await place();
await view([1.5, 0.9, 1.9]);
await page.click('[data-cmd="power"]');
await step(120);
await shot('15-offline', 500);

// --- jump scare (camera cut + lunge into the lens) ---
await page.click('[data-cmd="power"]');
await step(140);
await place();
await page.click('[data-cmd="glitch"]');
await step(20);
await shot('16-glitch', 300);

await page.evaluate(() => {
  const { camera } = window.MK0;
  camera.position.set(0.4, 0.9, 2.6);
  camera.lookAt(0, 0.45, 0);
});
await page.click('[data-cmd="scare"]');
await step(13);
await shot('17-jumpscare-rear', 300);
await step(16);
await shot('18-jumpscare-snap', 300);
await step(60);
await frame(3.0, 1.55, 0.6, 0.2);
await shot('19-jumpscare-return', 400);

const state = await page.evaluate(() => ({
  state: window.MK0.spider.state,
  energy: +window.MK0.spider.energy.toFixed(2),
  feet: window.MK0.spider.legs.map((l) => +l.localTarget.y.toFixed(3)),
  knees: window.MK0.spider.legs.map((l) => +l.knee.y.toFixed(3)),
  calls: window.MK0.renderer.info.render.calls,
  tris: window.MK0.renderer.info.render.triangles,
}));
console.log(JSON.stringify(state));
console.log('--- console ---');
console.log(logs.join('\n') || '(clean)');

await browser.close();
