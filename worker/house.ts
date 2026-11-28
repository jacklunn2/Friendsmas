// The House (Block 4): an opponent that can't win. Any activity can be
// "Beat the House": before the round the host locks in the House's score,
// which stays on the server until the face-off. Every team that beats it gets
// the points; if none do, the House takes its points. The House wins ties.
// Teams that don't beat it get nothing (no penalty).

import { HOUSE_ID, MAX_POINTS, type HostHouseView, type HouseRevealView } from "../shared/types";
import { findTeam, requireComplete, UserError, type Handler, type Payload } from "./common";
import { newId, type Activity, type HouseConfig, type ServerState } from "./state";

const MAX_SCORE = 1_000_000;

function findActivity(s: ServerState, id: unknown): Activity {
  const a = s.activities.find((x) => x.id === id);
  if (!a) throw new UserError("That activity no longer exists.");
  return a;
}

function houseOf(s: ServerState, id: unknown): { a: Activity; h: HouseConfig } {
  const a = findActivity(s, id);
  if (!a.house) throw new UserError(`${a.name} isn't a Beat the House round.`);
  return { a, h: a.house };
}

function score(p: Payload, key: string, label: string): number {
  const v = typeof p[key] === "string" ? Number((p[key] as string).replace(/,/g, "")) : p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new UserError(`Enter ${label} as a number.`);
  if (Math.abs(v) > MAX_SCORE) throw new UserError(`${label[0].toUpperCase()}${label.slice(1)} is too big.`);
  return Math.round(v * 100) / 100;
}

function points(p: Payload, key: string, label: string, fallback: number): number {
  const v = p[key] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_POINTS) throw new UserError(`${label} must be a whole number from 0 to ${MAX_POINTS}.`);
  return v;
}

const tag = (activityId: string) => `house:${activityId}`;
const roundTag = (activityId: string) => `houseround:${activityId}`;

/**
 * In each quiz round on the run sheet, the House scores the same as the
 * lowest team. Kept in step after every change; old entries are voided.
 * Returns true if anything changed.
 */
export function syncHouseRounds(s: ServerState, now: number): boolean {
  if (!s.runSheet?.length || !s.teams.length) return false;
  let changed = false;
  for (const id of s.runSheet) {
    const a = s.activities.find((x) => x.id === id);
    if (!a || a.format !== "quiz") continue;
    const live = s.ledger.filter((e) => !e.voided && e.activityId === a.id);
    const lowest = Math.min(...s.teams.map((t) => live.filter((e) => e.teamId === t.id).reduce((n, e) => n + e.points, 0)));
    const target = Math.max(0, lowest);
    const mine = live.filter((e) => e.teamId === HOUSE_ID && e.questionId === roundTag(a.id));
    if (mine.length <= 1 && mine.reduce((n, e) => n + e.points, 0) === target) continue;
    for (const e of mine) {
      e.voided = true;
      e.voidedAt = now;
    }
    if (target > 0) {
      s.ledger.push({
        id: newId(s, "e"),
        at: now,
        teamId: HOUSE_ID,
        playerId: null,
        activityId: a.id,
        points: target,
        reason: "Matches the lowest team in the round",
        kind: "award",
        placement: null,
        questionId: roundTag(a.id),
        voided: false,
        voidedAt: null,
        revealed: false,
      });
    }
    changed = true;
  }
  return changed;
}

/** Each team's score in the round: what the host recorded, or for quizzes and polls, the points they earned. */
function teamScores(s: ServerState, a: Activity): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of s.teams) {
    if (a.format === "live" || !a.format) out[t.id] = a.house!.teamScores[t.id] ?? null;
    else {
      out[t.id] = s.ledger
        .filter((e) => !e.voided && e.activityId === a.id && e.teamId === t.id && e.questionId !== tag(a.id))
        .reduce((n, e) => n + e.points, 0);
    }
  }
  return out;
}

/** Who beat the House: strictly better than its score. Ties go to the House. */
export function faceOff(s: ServerState, a: Activity): HouseRevealView {
  const h = a.house!;
  if (h.houseScore === null) throw new UserError("Set the House's score first.");
  const scores = teamScores(s, a);
  const rows = s.teams.map((t) => {
    const sc = scores[t.id];
    const beat = sc !== null && (h.direction === "high" ? sc > h.houseScore! : sc < h.houseScore!);
    return { teamId: t.id, score: sc, beat };
  });
  rows.sort((x, y) => (x.score === null ? 1 : y.score === null ? -1 : h.direction === "high" ? y.score - x.score : x.score - y.score));
  return {
    activityId: a.id,
    direction: h.direction,
    houseScore: h.houseScore,
    rows,
    teamPoints: h.teamPoints,
    housePoints: h.housePoints,
    houseWins: !rows.some((r) => r.beat),
  };
}

export function houseRevealView(s: ServerState): HouseRevealView | null {
  if (s.stage.screen !== "house" || !s.stage.activityId) return null;
  const a = s.activities.find((x) => x.id === s.stage.activityId);
  if (!a?.house || !a.house.settled || a.house.houseScore === null) return null;
  return faceOff(s, a);
}

export function hostHouseView(s: ServerState): Record<string, HostHouseView> {
  return Object.fromEntries(
    s.activities.filter((a) => a.house).map((a) => [a.id, { houseScore: a.house!.houseScore, teamScores: { ...a.house!.teamScores } }]),
  );
}

export const houseHost: Record<string, Handler> = {
  /** Turns Beat the House on or off for an activity, and sets its points. */
  "house.settings": (s, _a, p) => {
    const a = findActivity(s, p.activityId);
    if (p.enabled !== true && s.runSheet?.includes(a.id)) throw new UserError(`${a.name} is a Beat the House round in the running order, so it always plays against the House.`);
    if (p.enabled !== true) {
      if (a.house && s.ledger.some((e) => !e.voided && e.questionId === tag(a.id))) {
        throw new UserError("The House has already been settled for this activity. Void those points first.");
      }
      a.house = null;
      return { audit: ["house.settings", `${a.name}: not against the House`] };
    }
    const direction = p.direction === "low" ? "low" : "high";
    const prev = a.house;
    if (prev?.houseScore !== null && prev?.houseScore !== undefined && prev.direction !== direction) {
      throw new UserError("The House's score is locked, so which way wins can't change now.");
    }
    a.house = {
      direction,
      teamPoints: points(p, "teamPoints", "Points for beating the House", prev?.teamPoints ?? 5),
      housePoints: points(p, "housePoints", "Points the House takes", prev?.housePoints ?? 5),
      houseScore: prev?.houseScore ?? null,
      teamScores: prev?.teamScores ?? {},
      settled: prev?.settled ?? false,
    };
    return { audit: ["house.settings", `${a.name}: Beat the House (${direction === "high" ? "highest" : "lowest"} score wins)`] };
  },

  /** Locks in the House's score. It can't be changed afterwards. */
  "house.score": (s, _a, p) => {
    const { a, h } = houseOf(s, p.activityId);
    if (h.houseScore !== null) throw new UserError("The House's score is locked in.");
    h.houseScore = score(p, "score", "the House's score");
    return { audit: ["house.score", `${a.name}: the House's score is locked in`] };
  },

  /** Records a team's score in a live activity. */
  "house.teamScore": (s, _a, p) => {
    const { a, h } = houseOf(s, p.activityId);
    if (a.format === "quiz" || a.format === "poll") throw new UserError("Quiz and poll scores come from the points earned.");
    const t = findTeam(s, p.teamId);
    if (p.score === null || p.score === "") delete h.teamScores[t.id];
    else h.teamScores[t.id] = score(p, "score", "the team's score");
    return {};
  },

  /** Settles the face-off and puts it on the TV. Can be run again; old points are voided, never deleted. */
  "house.reveal": (s, _a, p, now) => {
    requireComplete(s);
    const { a, h } = houseOf(s, p.activityId);
    const result = faceOff(s, a);
    if (result.rows.every((r) => r.score === null)) throw new UserError("Enter the teams' scores first.");
    for (const e of s.ledger) {
      if (!e.voided && e.questionId === tag(a.id)) {
        e.voided = true;
        e.voidedAt = now;
      }
    }
    const push = (teamId: string, pts: number, reason: string) =>
      s.ledger.push({
        id: newId(s, "e"),
        at: now,
        teamId,
        playerId: null,
        activityId: a.id,
        points: pts,
        reason,
        kind: "award",
        placement: null,
        questionId: tag(a.id),
        voided: false,
        voidedAt: null,
        revealed: false,
      });
    if (result.houseWins) {
      if (h.housePoints) push(HOUSE_ID, h.housePoints, "Nobody beat the House");
    } else {
      for (const r of result.rows) if (r.beat && h.teamPoints) push(r.teamId, h.teamPoints, "Beat the House");
    }
    h.settled = true;
    s.video = null;
    s.stage = { screen: "house", activityId: a.id, timer: null };
    const winners = result.rows.filter((r) => r.beat).length;
    return { audit: ["house.reveal", `${a.name}: ${result.houseWins ? "the House wins" : `${winners} ${winners === 1 ? "team beats" : "teams beat"} the House`}`] };
  },
};
