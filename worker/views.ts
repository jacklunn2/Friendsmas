// Builds what each screen is allowed to see. Unrevealed draw results never
// leave the server: the stage, the host and the phones only receive what has
// already been revealed.

import type {
  AuditEntry,
  DrawView,
  HostView,
  PlayerView,
  PublicPlayer,
  PublicTeam,
  PublicView,
  StageView,
} from "../shared/types";
import { revealedIds, spinCooldownUntil } from "./logic";
import type { ServerPlayer, ServerState } from "./state";

export type Viewer =
  | { role: "host" }
  | { role: "stage" }
  | { role: "player"; playerId: string | null };

function hiddenFor(s: ServerState, viewer: Viewer): boolean {
  return viewer.role === "player" && s.draw.revealMode === "finale" && s.draw.phase !== "complete";
}

function publicPlayer(p: ServerPlayer, revealed: Set<string>): PublicPlayer {
  return {
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    status: p.status,
    teamId: revealed.has(p.id) ? p.teamId : null,
    isTest: p.isTest,
  };
}

function base(s: ServerState, viewer: Viewer, now: number): PublicView {
  const hidden = hiddenFor(s, viewer);
  const revealed = hidden ? new Set<string>() : revealedIds(s);
  const { phase, events, step, revealMode, oddFallback } = s.draw;

  const teams: PublicTeam[] = s.teams.map((t) => ({
    id: t.id,
    order: t.order,
    colour: t.colour,
    badge: t.badge,
    name: t.name,
    motto: t.motto,
    memberCount: t.memberIds.length,
    memberIds: t.memberIds.filter((id) => revealed.has(id)),
  }));

  const onWheel = phase === "locked" || phase === "revealing";
  const pool =
    onWheel && !hidden
      ? s.players
          .filter((p) => p.teamId && !revealed.has(p.id))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => p.id)
      : [];

  const last = step > 0 && !hidden ? events[step - 1] : null;
  const draw: DrawView = {
    phase,
    revealMode,
    oddFallback,
    step: hidden ? 0 : step,
    totalSteps: events.length,
    nextIsFinal: events[step]?.final ?? false,
    lastEvent: last ? { step, teamId: last.teamId, playerIds: last.playerIds, final: last.final } : null,
    pool,
    hidden,
  };

  return {
    version: s.version,
    serverTime: now,
    eventCode: s.eventCode,
    players: s.players
      .filter((p) => p.status !== "pending")
      .map((p) => publicPlayer(p, revealed)),
    teams,
    draw,
    naming: { ...s.naming },
    intermission: s.intermission,
  };
}

export function stageView(s: ServerState, now: number, canSpin = false): StageView {
  return { ...base(s, { role: "stage" }, now), role: "stage", canSpin };
}

export function playerView(s: ServerState, playerId: string | null, now: number): PlayerView {
  const viewer: Viewer = { role: "player", playerId };
  const view = base(s, viewer, now);
  const raw = playerId ? s.players.find((p) => p.id === playerId) ?? null : null;
  const me = raw ? (view.players.find((p) => p.id === raw.id) ?? publicPlayer(raw, new Set())) : null;
  const myTeamPublic = me?.teamId ? view.teams.find((t) => t.id === me.teamId) ?? null : null;
  const myTeamRaw = myTeamPublic ? s.teams.find((t) => t.id === myTeamPublic.id)! : null;
  return {
    ...view,
    role: "player",
    me,
    myTeam:
      myTeamPublic && myTeamRaw
        ? { ...myTeamPublic, suggestions: myTeamRaw.suggestions, rerollUsed: myTeamRaw.rerollUsed }
        : null,
    claimable: me
      ? []
      : s.players
          .filter((p) => p.status === "expected" && !p.token && !p.isTest)
          .map((p) => ({ id: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function hostView(s: ServerState, audit: AuditEntry[], now: number): HostView {
  const view = base(s, { role: "host" }, now);
  const revealed = revealedIds(s);
  return {
    ...view,
    role: "host",
    roster: s.players.map((p) => ({
      ...publicPlayer(p, revealed),
      hasDevice: !!p.token,
      joinedAt: p.joinedAt,
      rejoinCode: p.rejoinExpires && p.rejoinExpires > now ? p.rejoinCode : null,
      rejoinExpires: p.rejoinExpires && p.rejoinExpires > now ? p.rejoinExpires : null,
    })),
    audit,
    suggestions: Object.fromEntries(s.teams.map((t) => [t.id, t.suggestions])),
    spinCooldownUntil: spinCooldownUntil(s),
  };
}
