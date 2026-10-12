// Cryptographically secure randomness. Everything random in Friendsmas
// (the draw, team names, codes) comes from here and runs on the server.

/** Unbiased random integer in [0, max). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) throw new Error("max must be a positive integer");
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/** Fisher–Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pick<T>(items: readonly T[]): T {
  return items[randomInt(items.length)];
}

export function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Readable random code, e.g. for the private event link. */
export function randomCode(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function randomDigits(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String(randomInt(10));
  return s;
}
