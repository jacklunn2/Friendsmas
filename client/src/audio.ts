// All sound is synthesised with Web Audio, so there are no audio files to
// host. Sound only ever plays on the stage (the TV).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

export async function enableAudio(): Promise<boolean> {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    await ctx.resume();
    return ctx.state === "running";
  } catch {
    return false;
  }
}

export function audioOn(): boolean {
  return ctx?.state === "running";
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = "triangle", level = 0.25) {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(level, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(master);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** A small bell: a fundamental plus inharmonic partials. */
function bell(freq: number, at: number, dur = 1.2, level = 0.18) {
  tone(freq, at, dur, "sine", level);
  tone(freq * 2.76, at, dur * 0.5, "sine", level * 0.35);
  tone(freq * 5.4, at, dur * 0.25, "sine", level * 0.15);
}

function noise(at: number, dur: number, level: number) {
  if (!ctx || !master) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const g = ctx.createGain();
  filter.type = "bandpass";
  filter.frequency.value = 900;
  g.gain.value = level;
  src.buffer = buf;
  src.connect(filter).connect(g).connect(master);
  src.start(at);
}

export const sfx = {
  /** The peg hitting the pointer as the wheel turns. */
  tick() {
    if (!ctx) return;
    tone(1900, ctx.currentTime, 0.04, "square", 0.05);
  },
  /** Someone joined. */
  chime() {
    if (!ctx) return;
    const t = ctx.currentTime;
    bell(1318.5, t, 0.9, 0.12);
    bell(1975.5, t + 0.09, 0.9, 0.1);
  },
  /** A name is revealed. */
  fanfare() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.09, 0.5, "sawtooth", 0.07));
    [523.25, 659.25, 783.99].forEach((f) => tone(f, t + 0.42, 1.1, "triangle", 0.12));
    bell(2093, t + 0.42, 1.4, 0.12);
  },
  /** Before the final team is revealed. */
  drumroll(seconds: number) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const hits = Math.floor(seconds * 18);
    for (let i = 0; i < hits; i++) noise(t + i / 18, 0.06, 0.15 + (i / hits) * 0.35);
  },
  /** Everyone is on a team. */
  finale() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = [783.99, 783.99, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => tone(f, t + i * 0.14, 0.4, "sawtooth", 0.06));
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone(f, t + 0.75, 1.6, "triangle", 0.1));
    [1568, 2093, 2637].forEach((f, i) => bell(f, t + 0.75 + i * 0.12, 1.6, 0.08));
  },
};
