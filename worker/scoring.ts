// Scoring: activities, the points ledger, reveals and the leaderboard.
//
// Every point belongs to a team and may also record the guest who earned it.
// Totals are always added up from the ledger, never stored, so nothing can be
// counted twice. Undo voids an entry; nothing is ever deleted. New points are
// hidden until the host reveals them.

import {
  ACTIVITY_NAME_MAX,
  MAX_POINTS,
  REASON_MAX,
  ordinal,
  type ActivityKind,
  type ScoringScheme,
  type StandingsRow,
  type StandingsView,
} from "../shared/types";
import {
  findPlayer,
  findTeam,
  int,
  requireComplete,
  str,
  teamLabel,
  text,
  UserError,
  type Handler,
  type Payload,
} from "./common";
import { newId, type Activity, type LedgerEntry, type ServerState, type Snapshot } from "./state";

const DESCRIPTION_MAX = 400;
const MAX_TIMER_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Totals and ranks

export function liveEntries(s: ServerState): LedgerEntry[] {
  return s.ledger.filter((e) => !e.voided);
}

export function totalsFrom(s: ServerState, entries: LedgerEntry[]) {
  const teams: Record<string, number> = Object.fromEntries(s.teams.map((t) => [t.id, 0]));
  const players: Record<string, number> = {};
  for (const e of entries) {
    if (!(e.teamId in teams)) continue;
    teams[e.teamId] += e.points;
    if (e.playerId) players[e.playerId] = (players[e.playerId] ?? 0) + e.points;
  }
  return { teams, players };
}

/** Best first. Tied teams share a rank (1, 2, 2, 4) and keep team order. */
export function rank(
  totals: Record<string, number>,
  order: { id: string; order: number }[],
): { teamId: string; points: number; rank: number; tied: boolean }[] {
  const sorted = order
    .filter((t) => t.id in totals)
    .map((t) => ({ teamId: t.id, points: totals[t.id], order: t.order }))
    .sort((a, b) => b.points - a.points || a.order - b.order);
  return sorted.map((row) => {
    const firstIndex = sorted.findIndex((x) => x.points === row.points);
    const tied = sorted.filter((x) => x.points === row.points).length > 1;
    return { teamId: row.teamId, points: row.points, rank: firstIndex + 1, tied };
  });
}

export function standingsView(s: ServerState): StandingsView | null {
  const current = s.snapshots.at(-1);
  if (!current) return null;
  const previous = s.snapshots.length > 1 ? s.snapshots.at(-2)! : null;
  const prevRanks = previous ? rank(previous.teams, s.teams) : [];
  const rows: StandingsRow[] = rank(current.teams, s.teams).map((r) => {
    const prev = prevRanks.find((p) => p.teamId === r.teamId);
    return { ...r, prevPoints: prev ? prev.points : null, prevRank: prev ? prev.rank : null };
  });
  return { seq: current.seq, at: current.at, final: current.final, rows };
}

/** True when what's on the leaderboard no longer matches the live totals. */
export function standingsStale(s: ServerState): boolean {
  const live = totalsFrom(s, liveEntries(s)).teams;
  const shown = s.snapshots.at(-1)?.teams;
  if (!shown) return liveEntries(s).length > 0;
  return s.teams.some((t) => (live[t.id] ?? 0) !== (shown[t.id] ?? 0));
}

function takeSnapshot(s: ServerState, now: number, final: boolean): Snapshot {
  for (const e of s.ledger) if (!e.voided) e.revealed = true;
  const { teams, players } = totalsFrom(s, liveEntries(s));
  const snap: Snapshot = { seq: ++s.snapshotSeq, at: now, final, teams, players };
  s.snapshots = [...s.snapshots, snap].slice(-2);
  return snap;
}

// ---------------------------------------------------------------------------
// Activities

function findActivity(s: ServerState, id: unknown): Activity {
  const a = s.activities.find((x) => x.id === id);
  if (!a) throw new UserError("That activity no longer exists.");
  return a;
}

function activityFields(p: Payload) {
  const name = str(p, "name", { max: ACTIVITY_NAME_MAX, label: "a name for the activity" });
  const kind = p.kind as ActivityKind;
  if (kind !== "team" && kind !== "individual") throw new UserError("Choose whether teams or individuals play.");
  const scoring = p.scoring as ScoringScheme;
  if (scoring !== "placement" && scoring !== "perCorrect" && scoring !== "judged") {
    throw new UserError("Choose how the activity is scored.");
  }
  let placements: number[] = [5, 3, 1];
  if (Array.isArray(p.placements)) {
    placements = p.placements.map((v) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_POINTS) {
        throw new UserError(`Points for each place must be whole numbers from 0 to ${MAX_POINTS}.`);
      }
      return v;
    });
  }
  if (scoring === "placement" && (placements.length === 0 || placements.length > 12)) {
    throw new UserError("Give points for between 1 and 12 places.");
  }
  const perCorrect = p.perCorrect === undefined ? 1 : int(p, "perCorrect", { min: 1, max: MAX_POINTS, label: "points per correct answer" });
  const timerSeconds = p.timerSeconds === undefined ? 0 : int(p, "timerSeconds", { min: 0, max: MAX_TIMER_SECONDS, label: "the timer" });
  const description = text(p, "description", DESCRIPTION_MAX, "the description");
  return { name, kind, scoring, placements, perCorrect, timerSeconds, description };
}

function entriesFor(s: ServerState, activityId: string) {
  return s.ledger.filter((e) => e.activityId === activityId);
}

// ---------------------------------------------------------------------------
// Awarding

function award(
  s: ServerState,
  now: number,
  fields: Omit<LedgerEntry, "id" | "at" | "voided" | "voidedAt" | "revealed">,
): LedgerEntry {
  const entry: LedgerEntry = { ...fields, id: newId(s, "e"), at: now, voided: false, voidedAt: null, revealed: false };
  s.ledger.push(entry);
  return entry;
}

function describeEntry(s: ServerState, e: LedgerEntry): string {
  const team = s.teams.find((t) => t.id === e.teamId);
  const who = e.playerId ? s.players.find((p) => p.id === e.playerId)?.name : null;
  const pts = `${e.points > 0 ? "+" : ""}${e.points}`;
  return `${pts} to ${team ? teamLabel(team) : "a team"}${who ? ` (${who})` : ""}: ${e.reason}`;
}

// ---------------------------------------------------------------------------
// Host actions

export const scoringHost: Record<string, Handler> = {
  "activity.create": (s, _a, p, now) => {
    const f = activityFields(p);
    if (s.activities.length >= 60) throw new UserError("That's a lot of activities. Remove some first.");
    const a: Activity = { id: newId(s, "a"), ...f, resultsShown: false, createdAt: now };
    s.activities.push(a);
    return { data: { id: a.id }, audit: ["activity.create", a.name] };
  },

  "activity.update": (s, _a, p) => {
    const a = findActivity(s, p.id);
    const f = activityFields(p);
    const used = entriesFor(s, a.id).some((e) => !e.voided);
    if (used && (f.kind !== a.kind || f.scoring !== a.scoring)) {
      throw new UserError("Points have been awarded in this activity, so its type and scoring can't change. Void them first.");
    }
    Object.assign(a, f);
    return { audit: ["activity.update", a.name] };
  },

  "activity.delete": (s, _a, p) => {
    const a = findActivity(s, p.id);
    if (entriesFor(s, a.id).some((e) => !e.voided)) {
      throw new UserError(`${a.name} has points awarded. Void them before removing it.`);
    }
    s.activities = s.activities.filter((x) => x.id !== a.id);
    s.ledger = s.ledger.filter((e) => e.activityId !== a.id);
    if (s.stage.activityId === a.id) {
      s.stage = { screen: "teams", activityId: null, timer: null };
    }
    return { audit: ["activity.delete", a.name] };
  },

  /** Awards points in an activity. */
  "score.award": (s, _a, p, now) => {
    requireComplete(s);
    const a = findActivity(s, p.activityId);
    const team = findTeam(s, p.teamId);
    let playerId: string | null = null;
    if (p.playerId) {
      const pl = findPlayer(s, p.playerId);
      if (pl.teamId !== team.id) throw new UserError(`${pl.name} isn't on ${teamLabel(team)}.`);
      playerId = pl.id;
    }
    if (a.kind === "individual" && !playerId) throw new UserError("Choose who earned the points.");

    let points: number;
    let reason: string;
    let placement: number | null = null;
    if (a.scoring === "placement") {
      placement = int(p, "placement", { min: 1, max: a.placements.length, label: "the place" });
      points = a.placements[placement - 1];
      reason = `${ordinal(placement)} place`;
      // A team (or, in individual activities, a guest) holds one place per
      // activity: a new place replaces the old one.
      for (const e of entriesFor(s, a.id)) {
        if (!e.voided && e.placement !== null && e.teamId === team.id && (a.kind === "team" || e.playerId === playerId)) {
          e.voided = true;
          e.voidedAt = now;
        }
      }
    } else if (a.scoring === "perCorrect") {
      points = a.perCorrect;
      reason = "Correct answer";
    } else {
      points = int(p, "points", { min: -MAX_POINTS, max: MAX_POINTS, label: "the points" });
      if (points === 0) throw new UserError("Enter some points.");
      reason = str(p, "reason", { max: REASON_MAX, optional: true }) || "Judged";
    }
    const e = award(s, now, { teamId: team.id, playerId, activityId: a.id, points, reason, kind: "award", placement });
    return { data: { entryId: e.id }, audit: ["score.award", `${a.name}: ${describeEntry(s, e)}`] };
  },

  /** A bonus or penalty outside any activity. */
  "score.adjust": (s, _a, p, now) => {
    requireComplete(s);
    const team = findTeam(s, p.teamId);
    let playerId: string | null = null;
    if (p.playerId) {
      const pl = findPlayer(s, p.playerId);
      if (pl.teamId !== team.id) throw new UserError(`${pl.name} isn't on ${teamLabel(team)}.`);
      playerId = pl.id;
    }
    const points = int(p, "points", { min: -MAX_POINTS, max: MAX_POINTS, label: "the points" });
    if (points === 0) throw new UserError("Enter some points.");
    const reason = str(p, "reason", { max: REASON_MAX, label: "a reason" });
    const kind = points > 0 ? "bonus" : "penalty";
    const e = award(s, now, { teamId: team.id, playerId, activityId: null, points, reason, kind, placement: null });
    return { data: { entryId: e.id }, audit: ["score.adjust", describeEntry(s, e)] };
  },

  "score.void": (s, _a, p, now) => {
    const e = s.ledger.find((x) => x.id === p.entryId);
    if (!e) throw new UserError("That score no longer exists.");
    if (e.voided) return { noChange: true };
    e.voided = true;
    e.voidedAt = now;
    return { audit: ["score.void", `Voided ${describeEntry(s, e)}`] };
  },

  "score.restore": (s, _a, p, now) => {
    const e = s.ledger.find((x) => x.id === p.entryId);
    if (!e) throw new UserError("That score no longer exists.");
    if (!e.voided) return { noChange: true };
    if (!s.teams.some((t) => t.id === e.teamId)) throw new UserError("That team no longer exists.");
    if (e.placement !== null) {
      // Restoring a place replaces whatever place the team or guest holds now.
      const perTeam = s.activities.find((a) => a.id === e.activityId)?.kind !== "individual";
      for (const x of s.ledger) {
        if (
          !x.voided &&
          x.activityId === e.activityId &&
          x.placement !== null &&
          x.teamId === e.teamId &&
          (perTeam || x.playerId === e.playerId)
        ) {
          x.voided = true;
          x.voidedAt = now;
        }
      }
    }
    e.voided = false;
    e.voidedAt = null;
    return { audit: ["score.restore", `Restored ${describeEntry(s, e)}`] };
  },

  // -------------------------------------------------------------------------
  // The TV

  "stage.show": (s, _a, p) => {
    const screen = p.screen;
    if (screen === "teams") {
      requireComplete(s);
      s.stage = { screen: "teams", activityId: null, timer: null };
      return { audit: ["stage.show", "Teams on the TV"] };
    }
    if (screen === "standings") {
      if (!s.snapshots.length) throw new UserError("Reveal the standings first.");
      s.stage = { screen: s.snapshots.at(-1)!.final ? "final" : "standings", activityId: null, timer: null };
      return { audit: ["stage.show", "Leaderboard on the TV"] };
    }
    if (screen === "activity") {
      const a = findActivity(s, p.activityId);
      const timer = a.timerSeconds ? { endsAt: null, remainingMs: a.timerSeconds * 1000, durationMs: a.timerSeconds * 1000 } : null;
      s.stage = { screen: "activity", activityId: a.id, timer };
      return { audit: ["stage.show", `${a.name} on the TV`] };
    }
    throw new UserError("Choose what to show on the TV.");
  },

  "stage.timer": (s, _a, p, now) => {
    const t = s.stage.timer;
    if (s.stage.screen !== "activity") throw new UserError("Show an activity on the TV first.");
    const action = p.action;
    if (action === "set") {
      const seconds = int(p, "seconds", { min: 5, max: MAX_TIMER_SECONDS, label: "the timer" });
      s.stage.timer = { endsAt: null, remainingMs: seconds * 1000, durationMs: seconds * 1000 };
      return {};
    }
    if (!t) throw new UserError("Set a timer first.");
    if (action === "start") {
      if (t.endsAt) return { noChange: true };
      const left = t.remainingMs && t.remainingMs > 0 ? t.remainingMs : t.durationMs;
      s.stage.timer = { ...t, endsAt: now + left, remainingMs: null };
      return { audit: ["stage.timer", "Timer started"] };
    }
    if (action === "pause") {
      if (!t.endsAt) return { noChange: true };
      s.stage.timer = { ...t, endsAt: null, remainingMs: Math.max(0, t.endsAt - now) };
      return {};
    }
    if (action === "reset") {
      s.stage.timer = { ...t, endsAt: null, remainingMs: t.durationMs };
      return {};
    }
    if (action === "clear") {
      s.stage.timer = null;
      return {};
    }
    throw new UserError("Unknown timer action.");
  },

  /** Reveals one activity's points and shows its results on the TV. */
  "results.show": (s, _a, p) => {
    requireComplete(s);
    const a = findActivity(s, p.activityId);
    const live = entriesFor(s, a.id).filter((e) => !e.voided);
    if (!live.length) throw new UserError(`No points have been awarded in ${a.name} yet.`);
    for (const e of live) e.revealed = true;
    a.resultsShown = true;
    s.stage = { screen: "results", activityId: a.id, timer: null };
    return { audit: ["results.show", `${a.name} results on the TV`] };
  },

  /** Reveals every point so far and updates the leaderboard, from last place up. */
  "standings.reveal": (s, _a, _p, now) => {
    requireComplete(s);
    if (s.blackout) throw new UserError("The blackout is on. Turn it off, or reveal the final results.");
    if (!liveEntries(s).length) throw new UserError("Award some points first.");
    const snap = takeSnapshot(s, now, false);
    s.stage = { screen: "standings", activityId: null, timer: null };
    return { audit: ["standings.reveal", `Leaderboard revealed (#${snap.seq})`] };
  },

  "standings.blackout": (s, _a, p) => {
    s.blackout = p.on === true;
    return { audit: ["standings.blackout", s.blackout ? "Blackout on: standings hidden until the finale" : "Blackout off"] };
  },

  /** The finale: reveals everything, from last place up, then the winners. */
  "standings.final": (s, _a, _p, now) => {
    requireComplete(s);
    if (!liveEntries(s).length) throw new UserError("Award some points first.");
    takeSnapshot(s, now, true);
    s.blackout = false;
    s.stage = { screen: "final", activityId: null, timer: null };
    const winners = rank(s.snapshots.at(-1)!.teams, s.teams).filter((r) => r.rank === 1);
    const names = winners.map((w) => teamLabel(findTeam(s, w.teamId))).join(" and ");
    return { audit: ["standings.final", winners.length > 1 ? `Final results: tie between ${names}` : `Final results: ${names} win`] };
  },
};
