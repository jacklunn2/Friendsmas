// All game rules live here as plain functions over ServerState, so they can be
// tested without a Worker. The Durable Object (room.ts) calls runAction().

import {
  AVATARS,
  EXTRA_BADGES,
  FINAL_REVEAL_MS,
  MOTTO_MAX,
  NAME_MAX,
  NAMING_MS,
  SPIN_MS,
  TEAM_BADGES,
  TEAM_COLOURS,
  type Role,
} from "../shared/types";
import { pick, randomDigits, randomToken, shuffle } from "./random";
import { freshDraw, newId, type RevealEvent, type ServerPlayer, type ServerState, type ServerTeam } from "./state";
import { TEAM_NAMES } from "./teamNames";

export class UserError extends Error {}

export interface Actor {
  role: Role;
  playerId: string | null;
}

export interface ActionResult {
  data?: unknown;
  welcome?: { token: string; playerId: string };
  audit?: [action: string, detail: string];
  /** Set to schedule the Durable Object alarm; null clears it. */
  alarmAt?: number | null;
  /** True when the request was valid but changed nothing (e.g. a duplicate spin). */
  noChange?: boolean;
  /** Guests whose stored photos should be deleted. */
  deletePhotos?: string[];
}

type Payload = Record<string, unknown>;
type Handler = (s: ServerState, actor: Actor, p: Payload, now: number) => ActionResult;

const REJOIN_MS = 10 * 60_000;
const ALL_BADGES: readonly string[] = [...TEAM_BADGES, ...EXTRA_BADGES];

// ---------------------------------------------------------------------------
// Payload helpers

function str(p: Payload, key: string, opts: { max?: number; optional?: boolean; allowEmpty?: boolean } = {}): string {
  const v = p[key];
  if (v === undefined || v === null) {
    if (opts.optional) return "";
    throw new UserError(`Missing ${key}.`);
  }
  if (typeof v !== "string") throw new UserError(`${key} must be text.`);
  const t = v.trim().replace(/\s+/g, " ");
  if (!t && !opts.allowEmpty && !opts.optional) throw new UserError(`${key} can't be empty.`);
  if (opts.max && t.length > opts.max) throw new UserError(`${key} must be ${opts.max} characters or fewer.`);
  return t;
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new UserError("Enter a name.");
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) throw new UserError("Enter a name.");
  if (t.length > NAME_MAX) throw new UserError(`Names must be ${NAME_MAX} characters or fewer.`);
  return t;
}

function avatar(raw: unknown): string {
  if (typeof raw === "string" && (AVATARS as readonly string[]).includes(raw)) return raw;
  throw new UserError("Choose an avatar.");
}

// ---------------------------------------------------------------------------
// Lookups

export function findPlayer(s: ServerState, id: unknown): ServerPlayer {
  const p = s.players.find((x) => x.id === id);
  if (!p) throw new UserError("That guest no longer exists.");
  return p;
}

export function findTeam(s: ServerState, id: unknown): ServerTeam {
  const t = s.teams.find((x) => x.id === id);
  if (!t) throw new UserError("That team no longer exists.");
  return t;
}

function nameTaken(s: ServerState, name: string, exceptId?: string): boolean {
  const n = name.toLocaleLowerCase();
  return s.players.some((p) => p.id !== exceptId && p.name.toLocaleLowerCase() === n);
}

export function eligibleForDraw(s: ServerState): ServerPlayer[] {
  return s.players.filter((p) => p.status === "joined");
}

/** Who has been revealed so far, from the stage's point of view. */
export function revealedIds(s: ServerState): Set<string> {
  const { phase, events, step } = s.draw;
  if (phase === "draft") return new Set();
  if (phase === "complete") return new Set(s.players.filter((p) => p.teamId).map((p) => p.id));
  return new Set(events.slice(0, step).flatMap((e) => e.playerIds));
}

export function spinCooldownUntil(s: ServerState): number | null {
  const { lastStepAt, events, step } = s.draw;
  if (lastStepAt === null || step === 0) return null;
  const prev = events[step - 1];
  return lastStepAt + (prev?.final ? FINAL_REVEAL_MS : SPIN_MS) - 300;
}

function requireDraft(s: ServerState, what: string) {
  if (s.draw.phase !== "draft") throw new UserError(`${what} isn't possible once the draw is locked.`);
}

function requireComplete(s: ServerState) {
  if (s.draw.phase !== "complete") throw new UserError("Finish the team draw first.");
}

// ---------------------------------------------------------------------------
// Team names

function freshSuggestions(s: ServerState, count: number): string[] {
  const used = new Set(s.offeredNames);
  for (const t of s.teams) if (t.name) used.add(t.name);
  let pool = TEAM_NAMES.filter((n) => !used.has(n));
  if (pool.length < count) pool = TEAM_NAMES.filter((n) => !s.teams.some((t) => t.name === n));
  const chosen = shuffle(pool).slice(0, count);
  s.offeredNames.push(...chosen);
  return chosen;
}

// ---------------------------------------------------------------------------
// The draw

/** Team sizes for n players. Returns null if n is odd and no fallback is chosen. */
export function teamSizes(n: number, fallback: ServerState["draw"]["oddFallback"]): number[] | null {
  if (n < 2) return null;
  if (n % 2 === 0) return Array(n / 2).fill(2);
  if (fallback === "trio") return n >= 3 ? [...Array((n - 3) / 2).fill(2), 3] : null;
  if (fallback === "solo") return [...Array((n - 1) / 2).fill(2), 1];
  return null;
}

/** Builds the reveal script: one event per player, except the last team, which completes together. */
export function buildEvents(teams: ServerTeam[]): RevealEvent[] {
  const events: RevealEvent[] = [];
  teams.forEach((t, i) => {
    if (i === teams.length - 1) {
      events.push({ teamId: t.id, playerIds: t.memberIds.slice(), final: true });
    } else {
      for (const id of t.memberIds) events.push({ teamId: t.id, playerIds: [id], final: false });
    }
  });
  return events;
}

function lockDraw(s: ServerState, now: number): ActionResult {
  requireDraft(s, "Locking");
  const eligible = eligibleForDraw(s);
  const sizes = teamSizes(eligible.length, s.draw.oddFallback);
  if (eligible.length < 2) throw new UserError("At least two guests need to have joined.");
  if (!sizes) throw new UserError(`There are ${eligible.length} guests. Choose how to handle the odd number first.`);

  const order = shuffle(eligible.map((p) => p.id));
  const shuffledSizes = shuffle(sizes);
  const teams: ServerTeam[] = [];
  let cursor = 0;
  shuffledSizes.forEach((size, i) => {
    teams.push({
      id: newId(s, "t"),
      order: i,
      colour: TEAM_COLOURS[i % TEAM_COLOURS.length],
      badge: TEAM_BADGES[i % TEAM_BADGES.length],
      name: null,
      motto: "",
      memberIds: order.slice(cursor, cursor + size),
      suggestions: [],
      rerollUsed: false,
    });
    cursor += size;
  });
  s.teams = teams;
  for (const t of teams) {
    t.suggestions = freshSuggestions(s, 3);
    for (const id of t.memberIds) findPlayer(s, id).teamId = t.id;
  }
  s.draw.events = buildEvents(teams);
  s.draw.step = 0;
  s.draw.phase = "locked";
  s.draw.lockedAt = now;
  s.draw.lastStepAt = null;
  const shape = sizes.length === eligible.length / 2 ? `${teams.length} pairs` : `${teams.length} teams (${s.draw.oddFallback})`;
  return { audit: ["draw.lock", `Locked ${eligible.length} guests into ${shape}`] };
}

function spin(s: ServerState, p: Payload, now: number): ActionResult {
  const { phase, events, step } = s.draw;
  if (phase !== "locked" && phase !== "revealing") throw new UserError("The draw isn't ready to spin.");
  const expected = p.expectedStep;
  // Two clicks, two tabs or a stale page all send the same expected step.
  // Only the first one counts; the rest are ignored without error.
  if (expected !== step) return { data: { ignored: true, step }, noChange: true };
  const cooldown = spinCooldownUntil(s);
  if (cooldown && now < cooldown) return { data: { ignored: true, step, waitUntil: cooldown }, noChange: true };
  s.draw.step = step + 1;
  s.draw.lastStepAt = now;
  s.draw.phase = s.draw.step >= events.length ? "complete" : "revealing";
  const ev = events[step];
  const names = ev.playerIds.map((id) => findPlayer(s, id).name).join(", ");
  return { audit: ["draw.reveal", `Step ${step + 1}: ${names}`] };
}

function skipDraw(s: ServerState, now: number): ActionResult {
  if (s.draw.phase !== "locked" && s.draw.phase !== "revealing") throw new UserError("There's no draw in progress.");
  s.draw.step = s.draw.events.length;
  s.draw.phase = "complete";
  s.draw.lastStepAt = now;
  return { audit: ["draw.skip", "Skipped to results"] };
}

function resetDraw(s: ServerState, p: Payload): ActionResult {
  if (p.confirm !== "RESET") throw new UserError('Type RESET to confirm.');
  if (s.draw.phase === "draft") throw new UserError("The draw hasn't been locked yet.");
  // Later blocks: refuse once any points exist.
  for (const pl of s.players) pl.teamId = null;
  s.teams = [];
  s.offeredNames = [];
  s.draw = freshDraw(s.draw.revealMode, s.draw.oddFallback);
  s.naming = { phase: "idle", deadline: null };
  return { audit: ["draw.reset", "Draw reset to draft"], alarmAt: null };
}

// ---------------------------------------------------------------------------
// Naming

function closeNamingNow(s: ServerState): void {
  for (const t of s.teams) if (!t.name) t.name = t.suggestions[0] ?? `Team ${t.order + 1}`;
  s.naming = { phase: "closed", deadline: null };
}

/** Called by the Durable Object alarm. Returns true if anything changed. */
export function onAlarm(s: ServerState, now: number): boolean {
  if (s.naming.phase === "open" && s.naming.deadline !== null && now >= s.naming.deadline - 250) {
    closeNamingNow(s);
    return true;
  }
  return false;
}

function playerTeam(s: ServerState, actor: Actor): ServerTeam {
  if (!actor.playerId) throw new UserError("Join the event first.");
  const me = findPlayer(s, actor.playerId);
  if (!me.teamId || s.draw.phase !== "complete") throw new UserError("You're not on a team yet.");
  return findTeam(s, me.teamId);
}

// ---------------------------------------------------------------------------
// Action table

const host: Record<string, Handler> = {
  "guest.add": (s, _a, p, now) => {
    if (typeof p.names !== "string" || p.names.length > 2000) throw new UserError("Enter one name per line.");
    const names = p.names.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean);
    if (!names.length) throw new UserError("Enter at least one name.");
    const added: string[] = [];
    for (const n of names) {
      const name = cleanName(n);
      if (nameTaken(s, name)) continue;
      s.players.push({
        id: newId(s, "p"), name, emoji: "🎄", status: "expected", teamId: null, isTest: false,
        token: null, joinedAt: null, rejoinCode: null, rejoinExpires: null, createdAt: now,
      });
      added.push(name);
    }
    if (!added.length) throw new UserError("Those names are already on the list.");
    return { data: { added: added.length }, audit: ["guest.add", added.join(", ")] };
  },

  "guest.addTest": (s, _a, p, now) => {
    requireDraft(s, "Adding test guests");
    const count = Math.min(14, Math.max(1, Number(p.count) || 0));
    const existing = s.players.filter((x) => x.isTest).length;
    for (let i = 1; i <= count; i++) {
      s.players.push({
        id: newId(s, "p"), name: `Test guest ${existing + i}`, emoji: pick(AVATARS), status: "joined",
        teamId: null, isTest: true, token: null, joinedAt: now, rejoinCode: null, rejoinExpires: null, createdAt: now,
      });
    }
    return { audit: ["guest.addTest", `Added ${count} test guests`] };
  },

  "guest.removeTests": (s) => {
    requireDraft(s, "Removing test guests");
    const before = s.players.length;
    s.players = s.players.filter((x) => !x.isTest);
    return { audit: ["guest.removeTests", `Removed ${before - s.players.length} test guests`] };
  },

  "guest.rename": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    const name = cleanName(p.name);
    if (nameTaken(s, name, pl.id)) throw new UserError(`${name} is already on the list.`);
    const old = pl.name;
    pl.name = name;
    return { audit: ["guest.rename", `${old} → ${name}`] };
  },

  "guest.remove": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (pl.teamId) throw new UserError(`${pl.name} is on a team. Mark them as gone instead.`);
    s.players = s.players.filter((x) => x.id !== pl.id);
    return { audit: ["guest.remove", pl.name], deletePhotos: [pl.id] };
  },

  "guest.exclude": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (pl.teamId) throw new UserError(`${pl.name} is already on a team.`);
    if (pl.status !== "expected" && pl.status !== "joined") throw new UserError(`${pl.name} can't be excluded right now.`);
    pl.status = "excluded";
    return { audit: ["guest.exclude", pl.name] };
  },

  "guest.include": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (pl.status !== "excluded" && pl.status !== "left") throw new UserError(`${pl.name} is already included.`);
    pl.status = pl.token || pl.isTest ? "joined" : "expected";
    return { audit: ["guest.include", pl.name] };
  },

  "guest.leave": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (!pl.teamId) throw new UserError(`${pl.name} isn't on a team. Exclude them instead.`);
    pl.status = "left";
    return { audit: ["guest.leave", `${pl.name} left early`] };
  },

  "guest.approve": (s, _a, p, now) => {
    const pl = findPlayer(s, p.id);
    if (pl.status !== "pending") throw new UserError(`${pl.name} isn't waiting for approval.`);
    pl.status = "joined";
    pl.joinedAt = now;
    return { audit: ["guest.approve", pl.name] };
  },

  "guest.reject": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (pl.status !== "pending") throw new UserError(`${pl.name} isn't waiting for approval.`);
    s.players = s.players.filter((x) => x.id !== pl.id);
    return { audit: ["guest.reject", pl.name], deletePhotos: [pl.id] };
  },

  "guest.release": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (pl.isTest || !pl.token) throw new UserError(`${pl.name} isn't linked to a phone.`);
    pl.token = null;
    if (pl.status === "joined" && !pl.teamId) pl.status = "expected";
    return { audit: ["guest.release", `${pl.name}'s phone unlinked`] };
  },

  "guest.removePhoto": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if (!pl.photo) throw new UserError(`${pl.name} doesn't have a photo.`);
    pl.photo = null;
    return { audit: ["guest.removePhoto", `Removed ${pl.name}'s photo`], deletePhotos: [pl.id] };
  },

  "guest.rejoinCode": (s, _a, p, now) => {
    const pl = findPlayer(s, p.id);
    if (pl.isTest) throw new UserError("Test guests don't have phones.");
    let code = randomDigits(4);
    while (s.players.some((x) => x.rejoinCode === code)) code = randomDigits(4);
    pl.rejoinCode = code;
    pl.rejoinExpires = now + REJOIN_MS;
    return { data: { code }, audit: ["guest.rejoinCode", `Rejoin code for ${pl.name}`] };
  },

  "draw.options": (s, _a, p) => {
    if (s.draw.phase !== "draft" && !(s.draw.phase === "locked" && s.draw.step === 0)) {
      throw new UserError("Draw options can't change once the reveal has started.");
    }
    if (p.revealMode === "live" || p.revealMode === "finale") s.draw.revealMode = p.revealMode;
    if (p.oddFallback === "trio" || p.oddFallback === "solo" || p.oddFallback === null) {
      requireDraft(s, "Changing the odd-number option");
      s.draw.oddFallback = p.oddFallback;
    }
    return { audit: ["draw.options", `Reveal ${s.draw.revealMode}, odd: ${s.draw.oddFallback ?? "unset"}`] };
  },

  "draw.lock": (s, _a, _p, now) => lockDraw(s, now),
  "draw.spin": (s, _a, p, now) => spin(s, p, now),
  "draw.skip": (s, _a, _p, now) => skipDraw(s, now),
  "draw.reset": (s, _a, p) => resetDraw(s, p),

  "team.add": (s, _a, p) => {
    requireComplete(s);
    const pl = findPlayer(s, p.playerId);
    if (pl.teamId) throw new UserError(`${pl.name} is already on a team.`);
    if (pl.status !== "joined") throw new UserError(`${pl.name} hasn't joined yet.`);
    let team: ServerTeam;
    if (p.teamId === "random") {
      const smallest = Math.min(...s.teams.map((t) => t.memberIds.length));
      team = pick(s.teams.filter((t) => t.memberIds.length === smallest));
    } else {
      team = findTeam(s, p.teamId);
    }
    team.memberIds.push(pl.id);
    pl.teamId = team.id;
    return { data: { teamId: team.id }, audit: ["team.add", `${pl.name} added to ${team.name ?? `Team ${team.order + 1}`}`] };
  },

  "team.move": (s, _a, p) => {
    requireComplete(s);
    const pl = findPlayer(s, p.playerId);
    const to = findTeam(s, p.teamId);
    if (!pl.teamId) throw new UserError(`${pl.name} isn't on a team yet.`);
    if (pl.teamId === to.id) throw new UserError(`${pl.name} is already on that team.`);
    const from = findTeam(s, pl.teamId);
    from.memberIds = from.memberIds.filter((id) => id !== pl.id);
    to.memberIds.push(pl.id);
    pl.teamId = to.id;
    return { audit: ["team.move", `${pl.name} moved to ${to.name ?? `Team ${to.order + 1}`}`] };
  },

  "team.update": (s, _a, p) => {
    const t = findTeam(s, p.teamId);
    const changes: string[] = [];
    if (p.name !== undefined) {
      const name = str(p, "name", { max: 40 });
      if (s.teams.some((x) => x.id !== t.id && x.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new UserError("Another team already has that name.");
      }
      t.name = name;
      changes.push(`name "${name}"`);
    }
    if (p.motto !== undefined) {
      t.motto = str(p, "motto", { max: MOTTO_MAX, optional: true });
      changes.push("motto");
    }
    if (p.colour !== undefined) {
      if (!(TEAM_COLOURS as readonly string[]).includes(p.colour as string)) throw new UserError("Pick one of the team colours.");
      t.colour = p.colour as string;
      changes.push("colour");
    }
    if (p.badge !== undefined) {
      if (!ALL_BADGES.includes(p.badge as string)) throw new UserError("Pick one of the badges.");
      t.badge = p.badge as string;
      changes.push("badge");
    }
    return { audit: ["team.update", `Team ${t.order + 1}: ${changes.join(", ")}`] };
  },

  "naming.start": (s, _a, _p, now) => {
    requireComplete(s);
    if (s.naming.phase === "open") throw new UserError("Team naming is already open.");
    for (const t of s.teams) {
      if (!t.name && t.suggestions.length === 0) t.suggestions = freshSuggestions(s, 3);
    }
    const deadline = now + NAMING_MS;
    s.naming = { phase: "open", deadline };
    return { alarmAt: deadline, audit: ["naming.start", "Team naming opened for 2 minutes"] };
  },

  "naming.close": (s) => {
    if (s.naming.phase !== "open") throw new UserError("Team naming isn't open.");
    closeNamingNow(s);
    return { alarmAt: null, audit: ["naming.close", "Team naming closed"] };
  },

  "stage.intermission": (s, _a, p) => {
    s.intermission = p.on === true;
    return { audit: ["stage.intermission", s.intermission ? "On" : "Off"] };
  },
};

const player: Record<string, Handler> = {
  "player.claim": (s, actor, p, now) => {
    if (actor.playerId) throw new UserError("This phone has already joined.");
    const pl = findPlayer(s, p.playerId);
    if (pl.status !== "expected" || pl.token || pl.isTest) {
      throw new UserError(`${pl.name} has already joined on another phone. Ask the host for a rejoin code.`);
    }
    pl.emoji = avatar(p.emoji);
    pl.token = randomToken();
    pl.status = "joined";
    pl.joinedAt = now;
    return { welcome: { token: pl.token, playerId: pl.id }, audit: ["player.claim", `${pl.name} joined`] };
  },

  "player.joinNew": (s, actor, p, now) => {
    if (actor.playerId) throw new UserError("This phone has already joined.");
    const name = cleanName(p.name);
    if (nameTaken(s, name)) throw new UserError(`${name} is already on the guest list. Tap your name instead.`);
    const pl: ServerPlayer = {
      id: newId(s, "p"), name, emoji: avatar(p.emoji), status: "pending", teamId: null, isTest: false,
      token: randomToken(), joinedAt: null, rejoinCode: null, rejoinExpires: null, createdAt: now,
    };
    s.players.push(pl);
    return { welcome: { token: pl.token!, playerId: pl.id }, audit: ["player.joinNew", `${name} asked to join`] };
  },

  "player.rejoin": (s, actor, p, now) => {
    if (actor.playerId) throw new UserError("This phone has already joined.");
    const code = str(p, "code", { max: 8 });
    const pl = s.players.find((x) => x.rejoinCode === code && (x.rejoinExpires ?? 0) > now);
    if (!pl) throw new UserError("That code isn't valid. Ask the host for a new one.");
    pl.token = randomToken();
    pl.rejoinCode = null;
    pl.rejoinExpires = null;
    if (pl.status === "expected") {
      pl.status = "joined";
      pl.joinedAt = now;
    }
    return { welcome: { token: pl.token, playerId: pl.id }, audit: ["player.rejoin", `${pl.name} rejoined on a new phone`] };
  },

  "player.removePhoto": (s, actor) => {
    if (!actor.playerId) throw new UserError("Join the event first.");
    const me = findPlayer(s, actor.playerId);
    me.photo = null;
    return { deletePhotos: [me.id] };
  },

  "player.emoji": (s, actor, p) => {
    if (!actor.playerId) throw new UserError("Join the event first.");
    findPlayer(s, actor.playerId).emoji = avatar(p.emoji);
    return {};
  },

  "team.pick": (s, actor, p) => {
    if (s.naming.phase !== "open") throw new UserError("Team naming isn't open.");
    const t = playerTeam(s, actor);
    if (t.name) throw new UserError(`Your team is already ${t.name}.`);
    const name = str(p, "name");
    if (!t.suggestions.includes(name)) throw new UserError("Pick one of your team's suggestions.");
    t.name = name;
    const allNamed = s.teams.every((x) => x.name);
    if (allNamed) {
      closeNamingNow(s);
      return { alarmAt: null, audit: ["team.pick", `${name} (all teams named)`] };
    }
    return { audit: ["team.pick", name] };
  },

  "team.reroll": (s, actor) => {
    if (s.naming.phase !== "open") throw new UserError("Team naming isn't open.");
    const t = playerTeam(s, actor);
    if (t.name) throw new UserError("Your team has already chosen a name.");
    if (t.rerollUsed) throw new UserError("Your team has already used its reroll.");
    t.suggestions = freshSuggestions(s, 3);
    t.rerollUsed = true;
    return { audit: ["team.reroll", `Team ${t.order + 1}`] };
  },

  "team.motto": (s, actor, p) => {
    const t = playerTeam(s, actor);
    t.motto = str(p, "motto", { max: MOTTO_MAX, optional: true });
    return {};
  },
};

/** Runs one client request against the state. Mutates `s` in place. */
export function runAction(s: ServerState, actor: Actor, action: string, payload: Payload, now: number): ActionResult {
  if (actor.role === "host" && host[action]) return host[action](s, actor, payload, now);
  if (actor.role === "player" && player[action]) {
    if (actor.playerId) {
      const me = s.players.find((x) => x.id === actor.playerId);
      if (!me) throw new UserError("You're no longer on the guest list. Reload to join again.");
    }
    return player[action](s, actor, payload, now);
  }
  throw new UserError("That action isn't available here.");
}
