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

export type ActivityKind = "team" | "individual";
export type ScoringScheme = "placement" | "perCorrect" | "judged";
export type EntryKind = "award" | "bonus" | "penalty";
export type StageScreen = "teams" | "activity" | "results" | "standings" | "final";

export interface PublicPlayer {
  id: string;
  name: string;
  emoji: string;
  status: PlayerStatus;
  /** Only set once this player's team has been revealed to the viewer. */
  teamId: string | null;
  isTest: boolean;
  /** Photo version, or null if the guest hasn't added a photo. See photoUrl(). */
  photo: number | null;
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

export interface ActivityView {
  id: string;
  name: string;
  kind: ActivityKind;
  scoring: ScoringScheme;
  /** Points for 1st, 2nd, 3rd… when scoring is "placement". */
  placements: number[];
  /** Points per correct answer when scoring is "perCorrect". */
  perCorrect: number;
  description: string;
  /** Default length of the on-screen timer, or 0 for none. */
  timerSeconds: number;
  resultsShown: boolean;
}

export interface TimerView {
  /** Set while running. */
  endsAt: number | null;
  /** Set while paused. */
  remainingMs: number | null;
  durationMs: number;
}

export interface StageStateView {
  screen: StageScreen;
  activityId: string | null;
  timer: TimerView | null;
}

export interface StandingsRow {
  teamId: string;
  points: number;
  /** 1-based; tied teams share a rank. */
  rank: number;
  tied: boolean;
  /** Points and rank at the previous reveal, if the team was on it. */
  prevPoints: number | null;
  prevRank: number | null;
}

export interface StandingsView {
  /** Increases with every reveal, so screens can replay the animation. */
  seq: number;
  at: number;
  final: boolean;
  /** Best first. */
  rows: StandingsRow[];
}

export interface ResultsView {
  activityId: string;
  /** Points each team earned in the activity, best first. Only revealed points. */
  rows: { teamId: string; points: number; rank: number; earners: { playerId: string; points: number }[] }[];
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
  activities: ActivityView[];
  stage: StageStateView;
  /** The last revealed leaderboard, or null before the first reveal. */
  standings: StandingsView | null;
  /** While on, standings are kept secret until the final reveal. */
  blackout: boolean;
  /** Results of the activity on the TV, when the TV is showing results. */
  results: ResultsView | null;
}

export interface MyTeamView extends PublicTeam {
  suggestions: string[];
  rerollUsed: boolean;
}

export interface PlayerView extends PublicView {
  role: "player";
  me: PublicPlayer | null;
  myTeam: MyTeamView | null;
  /** This guest's share of their team's points at the last reveal. */
  myPoints: number;
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

export interface LedgerEntryView {
  id: string;
  at: number;
  teamId: string;
  playerId: string | null;
  activityId: string | null;
  points: number;
  reason: string;
  kind: EntryKind;
  /** 1-based placing, for placement awards. */
  placement: number | null;
  voided: boolean;
  /** False until the host reveals it (activity results or a standings reveal). */
  revealed: boolean;
}

export interface HostView extends PublicView {
  role: "host";
  roster: HostPlayer[];
  audit: AuditEntry[];
  /** Team names suggested to each team, so the host can see what's on offer. */
  suggestions: Record<string, string[]>;
  spinCooldownUntil: number | null;
  /** Every score change, newest first. */
  ledger: LedgerEntryView[];
  /** Current totals including points not yet revealed. */
  liveTotals: Record<string, number>;
  /** True when the live totals differ from the last revealed leaderboard. */
  standingsStale: boolean;
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

export const SPIN_MS = 8000;
export const FINAL_REVEAL_MS = 5600;
export const NAMING_MS = 120_000;
export const MOTTO_MAX = 60;
export const NAME_MAX = 24;
export const ACTIVITY_NAME_MAX = 40;
export const REASON_MAX = 60;
export const MAX_POINTS = 1000;
export const UNDO_MS = 10_000;

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

export const PHOTO_SIZE = 360;
export const PHOTO_MAX_BYTES = 300_000;

export function photoUrl(p: { id: string; photo: number | null }, eventCode: string): string | null {
  return p.photo ? `/api/photo/${p.id}?v=${p.photo}&c=${eventCode}` : null;
}

export function teamDisplayName(team: { name: string | null; order: number }): string {
  return team.name ?? `Team ${team.order + 1}`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function placeLabel(row: { rank: number; tied: boolean }): string {
  return `${row.tied ? "=" : ""}${ordinal(row.rank)}`;
}

export function formatPoints(n: number): string {
  return `${n} ${Math.abs(n) === 1 ? "pt" : "pts"}`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : "0";
}

/** How an activity is scored, in words, e.g. "1st: 5 points · 2nd: 3 points". */
export function scoringSummary(a: Pick<ActivityView, "scoring" | "placements" | "perCorrect">): string {
  const pts = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;
  if (a.scoring === "placement") return a.placements.map((p, i) => `${ordinal(i + 1)}: ${pts(p)}`).join(" · ");
  if (a.scoring === "perCorrect") return `${pts(a.perCorrect)} for every correct answer`;
  return "Points at the host's discretion";
}
