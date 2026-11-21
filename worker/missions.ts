// Secret missions (Block 4): one per guest, drawn at random from the host's
// list, never repeated. A mission lives only on its guest's phone and in the
// control room until the optional finale reveal. "Completed" adds +5 to the
// guest's team (hidden until the next leaderboard reveal); "Noticed" fails it
// and voids that +5 if it was already given. Nothing is ever deleted.

import {
  MAX_MISSIONS,
  MISSION_MAX,
  MISSION_POINTS,
  type HostMissionsView,
  type MissionRevealRow,
  type MyMissionView,
} from "../shared/types";
import { findPlayer, requireComplete, str, UserError, type Handler } from "./common";
import { pick } from "./random";
import { award } from "./scoring";
import { newId, type MissionAssignment, type ServerPlayer, type ServerState } from "./state";

function findMission(s: ServerState, id: unknown) {
  const m = s.missions.list.find((x) => x.id === id);
  if (!m) throw new UserError("That mission no longer exists.");
  return m;
}

function heldBy(s: ServerState, missionId: string): string | null {
  for (const [pid, a] of Object.entries(s.missions.assigned)) if (a.missionId === missionId && s.players.some((p) => p.id === pid)) return pid;
  return null;
}

/** Missions nobody holds. */
function unused(s: ServerState) {
  const taken = new Set(
    Object.entries(s.missions.assigned)
      .filter(([pid]) => s.players.some((p) => p.id === pid))
      .map(([, a]) => a.missionId),
  );
  return s.missions.list.filter((m) => !taken.has(m.id));
}

function assignmentFor(s: ServerState, playerId: unknown): { pl: ServerPlayer; a: MissionAssignment } {
  const pl = findPlayer(s, playerId);
  const a = s.missions.assigned[pl.id];
  if (!a) throw new UserError(`${pl.name} doesn't have a mission yet.`);
  return { pl, a };
}

/** Voids the mission's +5, if it has one. */
function voidBonus(s: ServerState, a: MissionAssignment, now: number) {
  const e = a.entryId ? s.ledger.find((x) => x.id === a.entryId) : null;
  if (e && !e.voided) {
    e.voided = true;
    e.voidedAt = now;
  }
  a.entryId = null;
}

function give(s: ServerState, pl: ServerPlayer, missionId: string, now: number) {
  const old = s.missions.assigned[pl.id];
  if (old) voidBonus(s, old, now);
  s.missions.assigned[pl.id] = { missionId, status: "active", seen: false, entryId: null, assignedAt: now };
}

const eligible = (pl: ServerPlayer) => pl.status === "joined";

/** Hands a mission to a guest who has just joined, if the host turned that on. */
export function autoAssignMission(s: ServerState, pl: ServerPlayer, now: number): void {
  if (!s.missions.autoOnJoin || !eligible(pl) || s.missions.assigned[pl.id]) return;
  const free = unused(s);
  if (free.length) give(s, pl, pick(free).id, now);
}

/** Forgets every guest's mission (used when starting fresh). The list stays. */
export function clearMissionAssignments(s: ServerState): void {
  s.missions.assigned = {};
}

// ---------------------------------------------------------------------------
// Views

export function myMissionView(s: ServerState, playerId: string | null): MyMissionView | null {
  const a = playerId ? s.missions.assigned[playerId] : undefined;
  const m = a && s.missions.list.find((x) => x.id === a.missionId);
  if (!a || !m) return null;
  // The +5 stays a secret, even from the guest, until it's on the leaderboard.
  const entry = a.entryId ? s.ledger.find((e) => e.id === a.entryId) : null;
  const status = a.status === "completed" && !entry?.revealed ? "active" : a.status;
  return { text: m.text, status, seen: a.seen, noticedAt: a.status === "noticed" ? (a.noticedAt ?? null) : null };
}

export function hostMissionsView(s: ServerState): HostMissionsView {
  return {
    list: s.missions.list.map((m) => ({ ...m })),
    autoOnJoin: s.missions.autoOnJoin,
    assignments: Object.entries(s.missions.assigned)
      .filter(([pid]) => s.players.some((p) => p.id === pid))
      .map(([playerId, a]) => ({
        playerId,
        missionId: a.missionId,
        text: s.missions.list.find((m) => m.id === a.missionId)?.text ?? "(deleted mission)",
        status: a.status,
        seen: a.seen,
        entryId: a.entryId,
      })),
  };
}

/** Only while the finale reveal is on the TV. */
export function missionsRevealView(s: ServerState): MissionRevealRow[] | null {
  if (s.stage.screen !== "missions") return null;
  const order = { completed: 0, noticed: 1, active: 2 };
  return Object.entries(s.missions.assigned)
    .filter(([pid]) => s.players.some((p) => p.id === pid && p.status !== "pending"))
    .map(([playerId, a]) => ({ playerId, text: s.missions.list.find((m) => m.id === a.missionId)?.text ?? "", status: a.status }))
    .sort((x, y) => order[x.status] - order[y.status]);
}

// ---------------------------------------------------------------------------
// Actions

export const missionsHost: Record<string, Handler> = {
  "missions.add": (s, _a, p) => {
    const text = str(p, "text", { max: MISSION_MAX, label: "the mission" });
    if (s.missions.list.length >= MAX_MISSIONS) throw new UserError(`You can have up to ${MAX_MISSIONS} missions.`);
    s.missions.list.push({ id: newId(s, "m"), text });
    return { audit: ["missions.add", text] };
  },

  "missions.update": (s, _a, p) => {
    const m = findMission(s, p.id);
    m.text = str(p, "text", { max: MISSION_MAX, label: "the mission" });
    return { audit: ["missions.update", m.text] };
  },

  "missions.delete": (s, _a, p) => {
    const m = findMission(s, p.id);
    const holder = heldBy(s, m.id);
    if (holder) throw new UserError(`${findPlayer(s, holder).name} has this mission. Redraw theirs first.`);
    s.missions.list = s.missions.list.filter((x) => x.id !== m.id);
    return { audit: ["missions.delete", m.text] };
  },

  "missions.auto": (s, _a, p, now) => {
    s.missions.autoOnJoin = p.on === true;
    if (s.missions.autoOnJoin) for (const pl of s.players) autoAssignMission(s, pl, now);
    return { audit: ["missions.auto", s.missions.autoOnJoin ? "Missions handed out as guests join" : "Missions handed out by the host"] };
  },

  /** Gives every guest who's here, and hasn't got one, a random unused mission. */
  "missions.handOut": (s, _a, _p, now) => {
    const waiting = s.players.filter((pl) => eligible(pl) && !s.missions.assigned[pl.id]);
    if (!waiting.length) throw new UserError("Everyone who's here already has a mission.");
    let given = 0;
    for (const pl of waiting) {
      const free = unused(s);
      if (!free.length) break;
      give(s, pl, pick(free).id, now);
      given++;
    }
    const short = waiting.length - given;
    if (!given) throw new UserError(`Every mission is taken. Add ${short} more.`);
    return {
      data: { given, short },
      audit: ["missions.handOut", `Handed out ${given} missions${short ? `; ${short} guests need more missions` : ""}`],
    };
  },

  /** A new random mission for one guest. */
  "missions.redraw": (s, _a, p, now) => {
    const pl = findPlayer(s, p.playerId);
    const current = s.missions.assigned[pl.id]?.missionId;
    const free = unused(s).filter((m) => m.id !== current);
    if (!free.length) throw new UserError("There are no unused missions left. Add another first.");
    give(s, pl, pick(free).id, now);
    return { audit: ["missions.redraw", `New mission for ${pl.name}`] };
  },

  /** The host chooses a guest's mission. */
  "missions.assign": (s, _a, p, now) => {
    const pl = findPlayer(s, p.playerId);
    const m = findMission(s, p.missionId);
    const holder = heldBy(s, m.id);
    if (holder === pl.id) return { noChange: true };
    if (holder) throw new UserError(`${findPlayer(s, holder).name} already has that mission.`);
    give(s, pl, m.id, now);
    return { audit: ["missions.assign", `${pl.name}'s mission changed`] };
  },

  "missions.remove": (s, _a, p, now) => {
    const { pl, a } = assignmentFor(s, p.playerId);
    voidBonus(s, a, now);
    delete s.missions.assigned[pl.id];
    return { audit: ["missions.remove", `Took back ${pl.name}'s mission`] };
  },

  "missions.complete": (s, _a, p, now) => {
    requireComplete(s);
    const { pl, a } = assignmentFor(s, p.playerId);
    if (a.status === "completed") return { noChange: true };
    if (!pl.teamId || !s.teams.some((t) => t.id === pl.teamId)) throw new UserError(`${pl.name} isn't on a team yet.`);
    const e = award(s, now, {
      teamId: pl.teamId,
      playerId: pl.id,
      activityId: null,
      points: MISSION_POINTS,
      reason: "Secret mission",
      kind: "bonus",
      placement: null,
    });
    a.status = "completed";
    a.entryId = e.id;
    return { data: { entryId: e.id }, audit: ["missions.complete", `${pl.name} completed their mission (+${MISSION_POINTS}, hidden until the next reveal)`] };
  },

  "missions.notice": (s, _a, p, now) => {
    const { pl, a } = assignmentFor(s, p.playerId);
    if (a.status === "noticed") return { noChange: true };
    voidBonus(s, a, now);
    a.status = "noticed";
    a.noticedAt = now;
    return { audit: ["missions.notice", `${pl.name}'s mission was noticed`] };
  },

  /** Back to "in progress", voiding any +5. */
  "missions.reset": (s, _a, p, now) => {
    const { pl, a } = assignmentFor(s, p.playerId);
    if (a.status === "active") return { noChange: true };
    voidBonus(s, a, now);
    a.status = "active";
    return { audit: ["missions.reset", `${pl.name}'s mission is back in progress`] };
  },
};

export const missionsPlayer: Record<string, Handler> = {
  "mission.seen": (s, actor) => {
    if (!actor.playerId) throw new UserError("Join the event first.");
    const a = s.missions.assigned[actor.playerId];
    if (!a) throw new UserError("You don't have a mission yet.");
    if (a.seen) return { noChange: true };
    a.seen = true;
    return {};
  },
};
