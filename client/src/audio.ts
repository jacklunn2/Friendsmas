// All sound is synthesised with Web Audio, so there are no audio files to
// host. Sound only ever plays on the stage (the TV).
//
// Everything runs through a big-room reverb and a compressor, so the TV
// sounds like a studio: brass stabs, timpani, cymbals and bells rather than
// beeps. The Beat the House announcement uses the browser's own speech voice,
// pitched down, over a low brass hit.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let dry: GainNode | null = null;
let wet: GainNode | null = null;

export async function enableAudio(): Promise<boolean> {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.25;
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(comp).connect(ctx.destination);
      dry = ctx.createGain();
      dry.connect(master);
      const reverb = ctx.createConvolver();
      reverb.buffer = impulse(ctx, 3.2, 2.6);
      wet = ctx.createGain();
      wet.gain.value = 0.5;
      wet.connect(reverb).connect(master);
    }
    await ctx.resume();
    // Wake the speech engine too, so the first announcement isn't delayed.
    window.speechSynthesis?.getVoices();
    return ctx.state === "running";
  } catch {
    return false;
  }
}

export function audioOn(): boolean {
  return ctx?.state === "running";
}

/** A big hall: decaying stereo noise. */
function impulse(c: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/** Sends a node to the dry mix and, by `send`, to the reverb. */
function out(node: AudioNode, send = 0.35) {
  if (!dry || !wet || !ctx) return;
  node.connect(dry);
  const s = ctx.createGain();
  s.gain.value = send;
  node.connect(s).connect(wet);
}

function env(g: GainNode, at: number, attack: number, peak: number, hold: number, release: number) {
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.setValueAtTime(peak, at + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = "triangle", level = 0.25, send = 0.3) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  env(g, at, 0.01, level, 0, dur);
  osc.connect(g);
  out(g, send);
  osc.start(at);
  osc.stop(at + dur + 0.1);
}

/** A brass note: three detuned saws through a filter that opens as it swells. */
function brass(freq: number, at: number, dur: number, level = 0.12, swell = 0.06, send = 0.4) {
  if (!ctx) return;
  const g = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(freq * 1.5, at);
  filter.frequency.linearRampToValueAtTime(freq * 6, at + swell + 0.05);
  filter.frequency.linearRampToValueAtTime(freq * 3, at + dur);
  env(g, at, swell, level, Math.max(0, dur - swell - 0.25), 0.35);
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 5.2;
  lfoGain.gain.value = freq * 0.006;
  lfo.connect(lfoGain);
  for (const detune of [-9, 0, 8]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, at);
    osc.detune.value = detune;
    lfoGain.connect(osc.frequency);
    osc.connect(filter);
    osc.start(at);
    osc.stop(at + dur + 0.5);
  }
  lfo.start(at);
  lfo.stop(at + dur + 0.5);
  filter.connect(g);
  out(g, send);
}

function chord(freqs: number[], at: number, dur: number, level = 0.08, swell = 0.06) {
  freqs.forEach((f) => brass(f, at, dur, level, swell));
}

/** A timpani: a pitch-dropping sine with a soft mallet click. */
function timpani(at: number, freq = 98, level = 0.7, decay = 1.4) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq * 1.6, at);
  osc.frequency.exponentialRampToValueAtTime(freq, at + 0.08);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.92, at + decay);
  env(g, at, 0.005, level, 0.02, decay);
  osc.connect(g);
  out(g, 0.45);
  osc.start(at);
  osc.stop(at + decay + 0.1);
  noise(at, 0.05, level * 0.25, "lowpass", 1200, 0.2);
}

/** A deep cinematic boom. */
function boom(at: number, level = 0.9) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(90, at);
  osc.frequency.exponentialRampToValueAtTime(32, at + 1.6);
  env(g, at, 0.01, level, 0.1, 2.2);
  osc.connect(g);
  out(g, 0.6);
  osc.start(at);
  osc.stop(at + 2.5);
  noise(at, 0.6, level * 0.35, "lowpass", 300, 0.6);
}

function noise(at: number, dur: number, level: number, type: BiquadFilterType = "bandpass", freq = 900, send = 0.3) {
  if (!ctx) return;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const g = ctx.createGain();
  filter.type = type;
  filter.frequency.value = freq;
  g.gain.value = level;
  src.buffer = buf;
  src.connect(filter).connect(g);
  out(g, send);
  src.start(at);
}

function cymbal(at: number, level = 0.35, dur = 2.6) {
  noise(at, dur, level, "highpass", 5500, 0.5);
  noise(at, dur * 0.6, level * 0.5, "bandpass", 3200, 0.4);
}

function bell(freq: number, at: number, dur = 1.8, level = 0.14) {
  tone(freq, at, dur, "sine", level, 0.5);
  tone(freq * 2.76, at, dur * 0.55, "sine", level * 0.35, 0.5);
  tone(freq * 5.4, at, dur * 0.3, "sine", level * 0.15, 0.5);
}

function snareRoll(at: number, seconds: number, from = 0.06, to = 0.32) {
  const rate = 22;
  const hits = Math.floor(seconds * rate);
  for (let i = 0; i < hits; i++) {
    const p = i / hits;
    noise(at + i / rate + (Math.random() - 0.5) * 0.006, 0.07, from + (to - from) * p * p, "bandpass", 1800, 0.25);
  }
}

// Notes (Hz)
const C3 = 130.81, G2 = 98, C4 = 261.63, E4 = 329.63, G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;
const Bb3 = 233.08, F4 = 349.23, D5 = 587.33;

export const sfx = {
  /** The peg hitting the pointer as the wheel turns. */
  tick() {
    if (!ctx) return;
    const t = ctx.currentTime;
    noise(t, 0.025, 0.25, "highpass", 2500, 0.05);
    tone(2200, t, 0.03, "square", 0.03, 0.05);
  },

  /** Someone joined: a short sparkle of sleigh bells. */
  chime() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [C6, E5 * 2, G5 * 2].forEach((f, i) => bell(f, t + i * 0.08, 1.6, 0.08));
    for (let i = 0; i < 6; i++) noise(t + i * 0.05, 0.08, 0.05, "highpass", 7000, 0.3);
  },

  /** A name is revealed, an answer lands: a brass fanfare with a timpani and cymbal. */
  fanfare() {
    if (!ctx) return;
    const t = ctx.currentTime;
    brass(G4, t, 0.16, 0.1, 0.02);
    brass(G4, t + 0.18, 0.16, 0.1, 0.02);
    brass(G4, t + 0.36, 0.16, 0.1, 0.02);
    chord([C4, E4, G4, C5], t + 0.56, 1.9, 0.075, 0.05);
    chord([C3], t + 0.56, 1.9, 0.12, 0.05);
    timpani(t + 0.56, G2, 0.8);
    cymbal(t + 0.56, 0.28, 2.4);
    bell(C6, t + 0.6, 2.2, 0.06);
  },

  /** Before something big: a snare roll that builds, ending on a crash. */
  drumroll(seconds: number) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const s = Math.max(1, seconds);
    snareRoll(t, s);
    // Low timpani rumble underneath, building.
    for (let i = 0; i < s * 6; i++) timpani(t + i / 6, G2 * 0.75, 0.12 + (i / (s * 6)) * 0.35, 0.3);
    cymbal(t + s, 0.4, 3);
    timpani(t + s, G2, 0.9, 1.8);
  },

  /** A row lands on the leaderboard: a deep hit. */
  thud() {
    if (!ctx) return;
    const t = ctx.currentTime;
    timpani(t, G2, 0.85, 1.2);
    brass(C3, t, 0.5, 0.1, 0.02);
    brass(G2 * 2, t, 0.5, 0.06, 0.02);
  },

  /** Time's up or answers close: a long game-show buzzer. */
  buzzer() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [110, 116.5, 220.5].forEach((f, i) => {
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = "square";
      osc.frequency.value = f;
      filter.type = "lowpass";
      filter.frequency.value = 1400;
      env(g, t, 0.01, i === 2 ? 0.05 : 0.11, 1.1, 0.3);
      osc.connect(filter).connect(g);
      out(g, 0.2);
      osc.start(t);
      osc.stop(t + 1.6);
    });
  },

  /** The last seconds counting down: a ticking clock with a heartbeat. */
  pip() {
    if (!ctx) return;
    const t = ctx.currentTime;
    noise(t, 0.04, 0.5, "bandpass", 2400, 0.15);
    tone(880, t, 0.08, "triangle", 0.12, 0.2);
    timpani(t, 60, 0.35, 0.4);
  },

  /** The big ones: everyone's on a team, the winners, the Grand Prize. */
  finale() {
    if (!ctx) return;
    const t = ctx.currentTime;
    // Rising call.
    [G4, C5, E5, G5].forEach((f, i) => brass(f, t + i * 0.16, 0.22, 0.09, 0.02));
    // Hold the big chord, with a second swell.
    chord([C4, E4, G4, C5, E5], t + 0.7, 2.6, 0.06, 0.08);
    chord([C3], t + 0.7, 2.6, 0.12, 0.08);
    timpani(t + 0.7, G2, 0.9, 1.6);
    cymbal(t + 0.7, 0.35, 3.2);
    chord([Bb3, D5, F4], t + 3.1, 0.5, 0.06, 0.04);
    chord([C4, E4, G4, C5, G5], t + 3.6, 3.2, 0.065, 0.1);
    chord([C3], t + 3.6, 3.2, 0.13, 0.1);
    timpani(t + 3.6, G2, 1, 2);
    cymbal(t + 3.6, 0.4, 4);
    [C6, E5 * 2, G5 * 2, C6 * 2].forEach((f, i) => bell(f, t + 3.7 + i * 0.12, 2.4, 0.06));
  },

  /** Under "THE HOUSE": a deep, ominous brass hit. */
  houseHit() {
    if (!ctx) return;
    const t = ctx.currentTime;
    boom(t, 1);
    chord([C3 / 2, C3, 155.56, G2 * 2], t, 2.8, 0.13, 0.05);
    timpani(t, 49, 1, 2.4);
    cymbal(t, 0.3, 3.5);
  },
};

// ---------------------------------------------------------------------------
// Speech: the announcer

function announcerVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const prefer = [
    /Google UK English Male/i,
    /Daniel/i,
    /Microsoft (Ryan|Guy|Christopher|Eric|George|William)/i,
    /Arthur|Gordon|Oliver|Lee|James/i,
    /male/i,
  ];
  for (const p of prefer) {
    const v = english.find((x) => p.test(x.name));
    if (v) return v;
  }
  return english.find((v) => /en-(GB|AU)/i.test(v.lang)) ?? english[0] ?? null;
}

function say(text: string, pitch: number, rate: number): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const v = announcerVoice();
    if (v) u.voice = v;
    u.pitch = pitch;
    u.rate = rate;
    u.volume = 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    // Some browsers never fire onend: don't wait forever.
    setTimeout(finish, 3500 + text.length * 120);
    synth.speak(u);
  });
}

/** "Can you beat… THE HOUSE!" in a deep announcer voice, over a brass hit. */
export async function announceHouse(): Promise<void> {
  if (!audioOn()) return;
  window.speechSynthesis?.cancel();
  if (ctx) snareRoll(ctx.currentTime, 1.6, 0.04, 0.18);
  await say("Can you beat", 0.55, 0.82);
  await new Promise((r) => setTimeout(r, 350));
  sfx.houseHit();
  await say("THE HOUSE!", 0.1, 0.62);
}
