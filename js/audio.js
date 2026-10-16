/**
 * Fully procedural audio — no sample files.
 * Everything is synthesized with the WebAudio API: a low containment drone plus
 * servo ticks, chitin thuds, mandible clicks, hydraulic hisses and the attack screech.
 */
export class SpiderAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = false;
    this.tickAcc = 0;
  }

  /* ---------------------------------------------------------------- setup */

  async enable() {
    if (!this.ready) this._build();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = true;
    this.master.gain.setTargetAtTime(0.85, this.ctx.currentTime, 0.4);
    return true;
  }

  disable() {
    if (!this.ready) return false;
    this.enabled = false;
    this.master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25);
    return false;
  }

  async toggle() {
    return this.enabled ? this.disable() : this.enable();
  }

  _build() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new Ctx());

    const master = (this.master = ctx.createGain());
    master.gain.value = 0.0001;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 14;
    comp.ratio.value = 9;
    comp.attack.value = 0.004;
    comp.release.value = 0.28;

    master.connect(comp);
    comp.connect(ctx.destination);

    // shared reverb-ish tail so the room feels big and empty
    const conv = ctx.createConvolver();
    conv.buffer = this._impulse(2.6, 3.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    master.connect(conv);
    conv.connect(wet);
    wet.connect(comp);
    this.reverb = wet;

    this.noiseBuf = this._noise(2.5);
    this.ready = true;
    this._drone();
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noiseSource(loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = loop;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    return src;
  }

  get t() {
    return this.ctx.currentTime;
  }

  _gate() {
    return this.enabled && this.ready;
  }

  /* ------------------------------------------------------------- ambience */

  _drone() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.master);

    // two detuned saws through a heavy lowpass = the containment hum
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 110;
    lp.Q.value = 3;
    lp.connect(out);

    for (const [f, g] of [[41.2, 0.5], [41.7, 0.42], [82.4, 0.16]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const v = ctx.createGain();
      v.gain.value = g;
      o.connect(v);
      v.connect(lp);
      o.start();
    }

    // slow breathing filter sweep
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 34;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start();

    // air / room hiss
    const hiss = this._noiseSource(true);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 620;
    hp.Q.value = 0.6;
    const hg = ctx.createGain();
    hg.gain.value = 0.028;
    hiss.connect(hp);
    hp.connect(hg);
    hg.connect(this.master);
    hiss.start();

    this.droneGain = out;
  }

  setDrone(level) {
    if (!this._gate()) return;
    this.droneGain.gain.setTargetAtTime(0.35 + level * 0.5, this.t, 0.6);
  }

  /* ---------------------------------------------------------------- sfx */

  /** servo whine, one short tick per cycle — call with locomotion activity */
  servo(intensity, dt) {
    if (!this._gate() || intensity <= 0.02) return;
    this.tickAcc -= dt;
    if (this.tickAcc > 0) return;
    this.tickAcc = 0.055 + Math.random() * (0.34 / Math.max(intensity, 0.15));

    const ctx = this.ctx;
    const t = this.t;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500 + Math.random() * 2600;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 + 0.09 * intensity, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + Math.random() * 0.05);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.12);

    // servo motor body
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(120 + Math.random() * 180, t);
    o.frequency.exponentialRampToValueAtTime(70 + Math.random() * 60, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.012 * intensity, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    const olp = ctx.createBiquadFilter();
    olp.type = 'lowpass';
    olp.frequency.value = 900;
    o.connect(olp);
    olp.connect(og);
    og.connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }

  /** stepper detent: the tick of a servo holding position on its grid */
  detent(intensity = 1) {
    if (!this._gate() || intensity <= 0.05) return;
    const ctx = this.ctx;
    const t = this.t;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + Math.random() * 2400;
    bp.Q.value = 11;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.02 + 0.07 * intensity, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.04);

    // a touch of motor body under the tick
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(150 + Math.random() * 220, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.03);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.006 * intensity, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    o.connect(og);
    og.connect(this.master);
    o.start(t);
    o.stop(t + 0.05);
  }

  /** solenoid clack when the machine changes mode */
  relay() {
    if (!this._gate()) return;
    this.click(1.25);
    setTimeout(() => this.click(0.85), 42);
  }

  /** scanner pod slewing onto a new grid position */
  scan() {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(260, t);
    o.frequency.linearRampToValueAtTime(620, t + 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.022, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    o.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.09);
    this.detent(0.7);
  }

  /** heavy footfall / chassis thud */
  step(weight = 1) {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 * (0.8 + Math.random() * 0.4), t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * weight, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.24);

    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 900;
    bp.Q.value = 1.1;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05 * weight, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    src.start(t);
    src.stop(t + 0.12);
  }

  /** dry chitin/metal click — mandibles, joints, relays */
  click(pitch = 1) {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (2200 + Math.random() * 1800) * pitch;
    bp.Q.value = 9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.06);
  }

  /** pneumatic hiss / leg extension */
  hiss(dur = 0.4, vol = 0.05) {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** the scream */
  screech(power = 1) {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;

    const shaper = ctx.createWaveShaper();
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 3.4);
    }
    shaper.curve = curve;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.14 * power, t + 0.03);
    g.gain.setValueAtTime(0.14 * power, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.9);

    shaper.connect(lp);
    lp.connect(g);
    g.connect(this.master);

    for (const [f0, f1, det, lvl] of [[1350, 210, 0, 0.6], [1900, 340, 12, 0.35], [980, 150, -9, 0.4]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.7);
      const og = ctx.createGain();
      og.gain.value = lvl;
      // fast wobble makes it read as an organic shriek rather than a synth sweep
      const trem = ctx.createOscillator();
      trem.type = 'square';
      trem.frequency.setValueAtTime(26 + Math.random() * 14, t);
      trem.frequency.exponentialRampToValueAtTime(9, t + 0.7);
      const tg = ctx.createGain();
      tg.gain.value = 0.5;
      trem.connect(tg);
      tg.connect(og.gain);
      trem.start(t);
      trem.stop(t + 0.95);

      o.connect(og);
      og.connect(shaper);
      o.start(t);
      o.stop(t + 0.95);
    }

    // impact air
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3400, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.5);
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.09 * power, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    src.start(t);
    src.stop(t + 0.7);
  }

  /** fast attack whoosh */
  whoosh() {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    const src = this._noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2800, t + 0.16);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.3);
  }

  /** data corruption burst */
  glitch() {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    for (let i = 0; i < 7; i++) {
      const st = t + i * 0.035 + Math.random() * 0.02;
      const o = ctx.createOscillator();
      o.type = Math.random() < 0.5 ? 'square' : 'sawtooth';
      o.frequency.setValueAtTime(120 + Math.random() * 2400, st);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05, st);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.03);
      o.connect(g);
      g.connect(this.master);
      o.start(st);
      o.stop(st + 0.04);
    }
    this.hiss(0.2, 0.05);
  }

  /** servo-powered boot / shutdown */
  power(up = true) {
    if (!this._gate()) return;
    const ctx = this.ctx;
    const t = this.t;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(up ? 40 : 620, t);
    o.frequency.exponentialRampToValueAtTime(up ? 520 : 38, t + (up ? 1.15 : 1.5));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(up ? 300 : 2400, t);
    lp.frequency.exponentialRampToValueAtTime(up ? 2600 : 200, t + 1.2);
    lp.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (up ? 1.25 : 1.6));
    o.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 1.7);
    this.hiss(up ? 0.9 : 1.3, 0.045);
  }

  /** chassis impact */
  impact() {
    if (!this._gate()) return;
    this.step(2.1);
    const ctx = this.ctx;
    const t = this.t;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.8);
  }
}
