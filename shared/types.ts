// Types shared by the Worker (server) and the React app (client).

export type PlayerStatus =
  | "expected" // on the guest list, hasn't joined yet
  | "joined" // has claimed their name on a phone
  | "pending" // joined with a new nickname, waiting for host approval
  | "excluded" // not taking part in the draw
  | "left"; // left early; stays on their team

export type OddFallback = "trio" | "solo";
export type RevealMode = "live" | "finale";
export type DrawPhase = "draft" | "locked" | "revealing" | "complete";
export type NamingPhase = "idle" | "open" | "closed";
export type Role = "host" | "stage" | "player";

export interface PublicPlayer {
  id: string;
  name: string;
  emoji: string;
  status: PlayerStatus;
  /** Only set once this player's team has been revealed to the viewer. */
  teamId: string | null;
  isTest: boolean;
}

export interface PublicTeam {
  id: string;
  order: number;
  colour: string;
  badge: string;
  /** null until the team picks a name. Display as "Team N" meanwhile. */
  name: string | null;
  motto: string;
  memberCount: number;
  /** Members revealed so far, in reveal order. */
  memberIds: string[];
}

export interface RevealEventView {
  step: number;
  teamId: string;
  playerIds: string[];
  /** The last team is completed without a spin. */
  final: boolean;
}

export interface DrawView {
  phase: DrawPhase;
  revealMode: RevealMode;
  oddFallback: OddFallback | null;
  /** Number of reveal events already shown. */
  step: number;
  totalSteps: number;
  /** True when the next reveal is the final, no-spin one. */
  nextIsFinal: boolean;
  lastEvent: RevealEventView | null;
  /** Players still on the wheel, sorted by name. */
  pool: string[];
  /** True when this viewer is not shown results until the draw completes. */
  hidden: boolean;
}

export interface NamingView {
  phase: NamingPhase;
  deadline: number | null;
}

export interface PublicView {
  version: number;
  serverTime: number;
  eventCode: string;
  players: PublicPlayer[];
  teams: PublicTeam[];
  draw: DrawView;
  naming: NamingView;
  intermission: boolean;
}

export interface MyTeamView extends PublicTeam {
  suggestions: string[];
  rerollUsed: boolean;
}

export interface PlayerView extends PublicView {
  role: "player";
  me: PublicPlayer | null;
  myTeam: MyTeamView | null;
  /** Names on the guest list that can still be claimed. */
  claimable: { id: string; name: string }[];
}

export interface StageView extends PublicView {
  role: "stage";
  /** True when this stage was opened from a signed-in control room, so clicking the wheel spins it. */
  canSpin: boolean;
}

export interface HostPlayer extends PublicPlayer {
  /** The host always sees team membership once teams exist. */
  hasDevice: boolean;
  joinedAt: number | null;
  rejoinCode: string | null;
  rejoinExpires: number | null;
}

export interface AuditEntry {
  at: number;
  action: string;
  detail: string;
}

export interface HostView extends PublicView {
  role: "host";
  roster: HostPlayer[];
  audit: AuditEntry[];
  /** Team names suggested to each team, so the host can see what's on offer. */
  suggestions: Record<string, string[]>;
  spinCooldownUntil: number | null;
}

export type AnyView = PlayerView | StageView | HostView;

// ---------------------------------------------------------------------------
// Messages

export type ServerMessage =
  | { type: "state"; view: AnyView }
  | { type: "ok"; rid: string; data?: unknown }
  | { type: "error"; rid?: string; message: string }
  | { type: "welcome"; rid?: string; token: string; playerId: string }
  | { type: "unauthorized"; message: string };

/** Every client request carries an action name, a request id and a payload. */
export interface ClientRequest {
  a: string;
  rid: string;
  p?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants shared by both sides

export const SPIN_MS = 6500;
export const FINAL_REVEAL_MS = 4200;
export const NAMING_MS = 120_000;
export const MOTTO_MAX = 60;
export const NAME_MAX = 24;

export const TEAM_COLOURS = [
  "#e2445c", // cranberry
  "#f2b544", // brass
  "#5cc4ea", // ice
  "#a77ce8", // plum
  "#f2803f", // tangerine
  "#5fd6a0", // mint
] as const;

export const TEAM_BADGES = ["🎄", "⭐", "🔔", "🎁", "❄️", "🦌"] as const;
export const EXTRA_BADGES = ["🍬", "🧦", "☃️", "🍪", "🎅", "🕯️", "🦘", "🏖️"] as const;

export const AVATARS = [
  "🎅", "🤶", "🧝", "🦌", "⛄", "🐧", "🦘", "🐨",
  "🎄", "⭐", "🔔", "🎁", "🍪", "🥧", "🍤", "🍉",
  "🏖️", "🕶️", "🎸", "🎳", "🦄", "🐙", "🦖", "🌵",
] as const;

export function teamDisplayName(team: { name: string | null; order: number }): string {
  return team.name ?? `Team ${team.order + 1}`;
}
