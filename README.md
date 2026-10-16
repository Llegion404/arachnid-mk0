# ARACHNID MK-0

A procedural, browser-native 3D model of a hostile prototype robot spider: eight
stepper-driven legs on analytic IK, an alternating-tetrapod gait engine, a
behaviour state machine, post-processed visuals and fully synthesised audio.

There are **no external assets** — every vertex, texture, sound and animation
curve is generated in code at load time. three.js is vendored locally, so the
page needs no network access at runtime.

```
npm start          # serves the folder on http://127.0.0.1:8137/
```

Open the URL, click **INITIALIZE**, and it drops out of the ceiling onto the
containment pad.

---

## Controls

| input | action |
| --- | --- |
| `1` `2` `3` `4` `5` `6` `7` `8` | idle · walk · stalk · threat · attack · jump scare · power · glitch |
| `A` / `C` / `S` / `B` | autopilot · camera track · sound · bloom |
| `RATE` slider | global gait/tempo multiplier (0.4×–2.2×) |
| drag / scroll | orbit / zoom |

The on-screen lizard-brain (**AUTOPILOT**) keeps deciding on its own — stalking
the camera, closing to attack range, glitching, patrolling — and hands control
back to you whenever you press a state button.

**JUMP SCARE** teleports the unit 1.15 m in front of the current camera, attacks
the lens, then walks itself back to the pad.

## What makes it read as a machine

- **Stepper-quantised servo bus.** The coxa/femur of every leg is snapped to
  discrete detents (0.028 rad) with a deadband so a joint holding position never
  chatters, and a wrap-aware azimuth so it survives the ±π seam. The tibia is a
  telescopic actuator that stretches to the true ground point, so the foot lands
  exactly where the gait engine put it even though the joint that carries it is
  digital. Every detent is counted (`SERVO BUS` readout) and, throttled, becomes
  an audible tick plus a micro-jolt in the chassis.
- **Visible mechanisms.** Servo drum at each coxa, a nine-tooth sprocket with an
  index mark outboard of each knee driven by the knee angle, and a chrome ram
  sliding through a fixed sleeve on every shin.
- **Scanner pod.** A bolted turret on the thorax deck that slews in discrete
  steps on a fixed grid, sweeping the room on a timer and locking forward when
  the unit goes hostile, with a lens flare on every new target.
- **Status strip + power gauge.** Three deck lamps run coded patterns per state
  (idle heartbeat, POST sequence on boot, marching pattern while rolling, 6 Hz
  strobe in threat, strobe while attacking, strobing chaos when glitching, dark
  when offline). Three gauge cells per cheek track core charge.
- **Bolted hull.** Armour plates are fitted to the *actual* icosahedron facets
  (computed from the geometry, not eyeballed), with hex bolts, recessed rear
  plating, hand-drawn canvas stencils (`MK-0`, `ARACHNID`, hazard band, wear
  scratches) and a machined deck bolt ring.
- **Square-wave drive.** While rolling, the drivetrain advances in small
  square-wave pulses instead of gliding, and the mode changes throw a solenoid
  relay.

## Layout

```
index.html            HUD, import map, boot overlay
css/style.css         HUD / boot / flash styling
js/main.js            renderer, camera, post FX, input, HUD, tick loop, MK0 API
js/spider.js          model, materials, IK, gait, pose, behaviour state machine
js/environment.js     floor, grid, rings, scan pulse, lights, PMREM env map
js/audio.js           WebAudio synthesis (drone, servos, thuds, hiss, screech)
scripts/vendor.mjs    copies three + transitive jsm imports into vendor/three
scripts/verify.mjs    headless motion/behaviour test suite
scripts/shot.mjs      headless screenshot harness -> shots/
vendor/three/         vendored three r186 (build + addons)
```

### Animation

States: `BOOT → DEPLOY → IDLE / WALK / STALK / THREAT / ATTACK / SCARE /
GLITCH / DOWN / WAKE`, plus an autopilot director that picks behaviours, keeps
the unit on its pad and resumes the wheel after a manual command.

Locomotion plants feet in **world** space and drives them with an alternating
tetrapod gait (L1 L3 R2 R4 / L2 L4 R1 R3), with per-leg swing duration, lift
height and a settle tick; planted feet slide less than 4 mm per frame. Attack
and scare share one timeline: rear-up, lunge, fang snap, recover.

## Verification

```
npm run verify     # motion + behaviour suite, ~2 min of simulated time
npm run shot       # 23 deterministic screenshots into shots/
```

`verify` launches the installed Chrome headless (software GL), drives the debug
API and asserts: every leg lifts and plants, planted feet do not slide, feet
rejoin their home position, the state machine reaches each behaviour and returns
to idle, the autopilot keeps cycling and stays on the pad, speed stays bounded
and nothing goes NaN over a minute of autonomy.

`shot` writes the stills used to review the look. `shots/` is disposable — the
PNGs are ~2 MB each and can be regenerated at any time.

### Debug API

The page exposes `window.MK0` for deterministic poking from the console or a
harness:

```js
MK0.step(120)            // run 120 fixed 1/60 s simulation steps, no drawing
MK0.pause() / MK0.resume()
MK0.spider.cmd('stalk')  // drive a state
MK0.spider.legs          // IK/gait state per leg
```

`MK0.pause()` freezes the simulation but keeps drawing — that is how the
screenshot harness captures an exact pose without it drifting while the software
renderer works.

### Notes

- three is pinned to r186 (`Clock` is deprecated, `PCFSoftShadowMap` is gone,
  tone mapping only applies when rendering to the canvas, hence `OutputPass`
  last in the composer chain).
- Post-processing falls back to a direct render if the effect composer modules
  cannot be imported.
- Audio starts muted by design and comes up on the first user gesture.
- Headless software GL renders at 2–3 fps, so anything scripted should step the
  simulation (`MK0.step`) rather than wait in real time.
