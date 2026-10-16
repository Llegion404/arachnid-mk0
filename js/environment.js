import * as THREE from 'three';

/** procedural mottled noise texture — used for the floor roughness so the
 *  polished concrete catches the light unevenly */
function noiseTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = 150 + Math.random() * 60;
    img.data[i * 4 + 0] = n;
    img.data[i * 4 + 1] = n;
    img.data[i * 4 + 2] = n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // blotches
  for (let i = 0; i < 90; i++) {
    const r = 4 + Math.random() * 40;
    const grd = g.createRadialGradient(Math.random() * size, Math.random() * size, 0, 0, 0, r);
    void grd;
    g.globalAlpha = 0.05 + Math.random() * 0.12;
    g.fillStyle = Math.random() < 0.5 ? '#000' : '#fff';
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  return tex;
}

/** A tiny hand-built "room": one big cool strip light overhead, a red panel
 *  behind and a cold panel to the side. Feeding this through PMREM gives the
 *  metal something to reflect — without it, metalness=1 surfaces read as black. */
function buildEnvMap(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x04050a);

  const panel = (w, h, color, pos, look = [0, 1, 0]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color }));
    m.position.set(pos[0], pos[1], pos[2]);
    m.lookAt(look[0], look[1], look[2]);
    s.add(m);
  };

  panel(9, 9, 0x8294b2, [0, 7, 0], [0, 0, 0]);            // ceiling bounce
  panel(7, 4, 0xff2008, [-6, 2.4, -4], [0, 1, 0]);        // red containment glow
  panel(6, 3.4, 0x2440ff, [6, 2.0, -3], [0, 1, 0]);       // cold surgical fill
  panel(20, 20, 0x0b0d13, [0, -1.4, 0], [0, 6, 0]);       // dark floor

  const env = pmrem.fromScene(s, 0.03).texture;
  pmrem.dispose();
  s.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });
  return env;
}

export function buildEnvironment(scene, renderer) {
  const group = new THREE.Group();
  scene.add(group);

  if (renderer) {
    const env = buildEnvMap(renderer);
    scene.environment = env;
    scene.environmentIntensity = 0.38;
  }

  /* ------------------------------------------------------------ floor */
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x08090d,
    metalness: 0.5,
    roughness: 0.72,
    roughnessMap: noiseTexture(256),
    envMapIntensity: 0.5,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(11, 96), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // fine machining grid
  const grid = new THREE.GridHelper(22, 88, 0x4a0a0c, 0x1a0507);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  grid.position.y = 0.003;
  group.add(grid);

  // containment ring markers
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x7a1010, transparent: true, opacity: 0.75 });
  for (const r of [2.6, 5.2]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.014, 6, 160), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.006;
    group.add(ring);
  }

  // expanding scan pulse that sweeps out from the centre
  const scan = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1, 128),
    new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, opacity: 0, side: THREE.DoubleSide })
  );
  scan.rotation.x = -Math.PI / 2;
  scan.position.y = 0.008;
  group.add(scan);

  /* ----------------------------------------------------------- lights */
  const hemi = new THREE.HemisphereLight(0x26334d, 0x040409, 0.6);
  group.add(hemi);

  // hard overhead key light
  const key = new THREE.SpotLight(0xdfe8ff, 430, 26, 0.72, 0.94, 2);
  key.position.set(3.4, 6.2, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.6;
  key.shadow.camera.far = 22;
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.022;
  key.shadow.radius = 2.2;
  group.add(key, key.target);

  // red rim from behind — the "thing in the dark" light
  const rim = new THREE.PointLight(0xff1a0c, 46, 16, 2);
  rim.position.set(-3.4, 1.5, -3.2);
  group.add(rim);

  // cold fill from the right for shape separation
  const fill = new THREE.PointLight(0x3f66ff, 20, 16, 2);
  fill.position.set(3.8, 1.1, -2.6);
  group.add(fill);

  // weak bounce from the floor
  const bounce = new THREE.PointLight(0x202a3a, 8, 10, 2);
  bounce.position.set(0, 0.35, 0);
  group.add(bounce);

  /* ------------------------------------------------------------- dust */
  const dustCount = 420;
  const pos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const r = Math.random() * 8;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3 + 0] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 4.2;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      color: 0x8fa2c0,
      size: 0.017,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  group.add(dust);

  /* ------------------------------------------------------------ state */
  let t = 0;
  let flicker = 0;
  let nextFlicker = 2 + Math.random() * 5;
  let scanT = 0.9 + Math.random() * 3;

  const api = {
    group,
    floor,
    key,
    rim,
    fill,
    params: { bloom: 1 },

    setDramatic(v) {
      api.params.dramatic = v;
    },

    update(dt, time, spider) {
      t = time;

      // overhead lamp instability
      nextFlicker -= dt;
      if (nextFlicker <= 0) {
        nextFlicker = 3 + Math.random() * 9;
        flicker = 0.16 + Math.random() * 0.3;
      }
      flicker = Math.max(0, flicker - dt * 1.6);
      const stab = 0.93 + Math.sin(t * 11.3) * 0.02 + Math.sin(t * 3.1) * 0.03;
      key.intensity = 430 * stab * (1 - flicker);

      rim.intensity = 46 * (0.82 + Math.sin(t * 1.7) * 0.18) * (1 - flicker * 0.6);
      dust.rotation.y = t * 0.013;
      dust.position.y = Math.sin(t * 0.21) * 0.09;

      // scan sweep
      scanT += dt;
      const period = 7.5;
      if (scanT > period) {
        scanT = 0;
        api.params.scan = 1;
      }
      const p = scanT / period;
      if (scanT < 2.6 && spider) {
        const r = 0.5 + p * 8 * 2;
        scan.scale.setScalar(Math.max(0.001, r));
        scan.position.set(spider.root.position.x, 0.008, spider.root.position.z);
        const mat = scan.material;
        mat.opacity = (1 - scanT / 2.6) * 0.22 * (1 - flicker);
      } else {
        scan.material.opacity = 0;
      }

      if (spider) {
        // soft floor bounce that follows the unit (kept high so it can't blow
        // out the polished floor right underneath)
        bounce.position.set(spider.root.position.x, 1.05, spider.root.position.z);
        bounce.intensity = 3 + spider.energy * 3 + spider.eyeFlare * 8;
      }

      hemi.intensity = 0.55 + Math.sin(t * 0.7) * 0.05;
      fill.intensity = 20 * (1 - flicker * 0.4);
    },
  };

  return api;
}
