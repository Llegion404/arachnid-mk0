// Copies the three.js files this project needs into ./vendor/three
// so the app runs fully offline with no CDN dependency.
import { mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = resolve(root, 'node_modules/three');
const out = resolve(root, 'vendor/three');

const ENTRIES = [
  'build/three.module.js',
  'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/postprocessing/EffectComposer.js',
  'examples/jsm/postprocessing/RenderPass.js',
  'examples/jsm/postprocessing/ShaderPass.js',
  'examples/jsm/postprocessing/UnrealBloomPass.js',
  'examples/jsm/postprocessing/OutputPass.js',
  'examples/jsm/shaders/CopyShader.js',
  'examples/jsm/shaders/LuminosityHighPassShader.js',
];

const seen = new Set();
const queue = [...ENTRIES];

const targetPath = (rel) =>
  rel.startsWith('examples/jsm/')
    ? resolve(out, 'jsm', rel.slice('examples/jsm/'.length))
    : resolve(out, rel.replace(/^build\//, ''));

const inTarget = (abs) =>
  abs.startsWith('examples/jsm/') ? resolve(out, 'jsm', abs.slice(13)) : targetPath(abs);

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);

  const src = resolve(pkg, rel);
  if (!existsSync(src)) throw new Error('missing: ' + src);

  const dest = targetPath(rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);

  // walk relative imports so the copied tree is self-contained
  const code = readFileSync(src, 'utf8');
  for (const m of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    queue.push(relative(pkg, resolve(dirname(src), m[1])));
  }
}

console.log(`vendored ${seen.size} files -> vendor/three`);
