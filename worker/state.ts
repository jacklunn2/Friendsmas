import type {
  ActivityKind,
  DrawPhase,
  EntryKind,
  NamingPhase,
  OddFallback,
  PlayerStatus,
  RevealMode,
  ScoringScheme,
  StageScreen,
} from "../shared/types";
import { randomCode } from "./random";

export interface ServerPlayer {
  id: string;
  name: string;
  emoji: string;
  status: PlayerStatus;
  teamId: string | null;
  isTest: boolean;
  /** Secret that identifies this guest's phone. */
  token: string | null;
  joinedAt: number | null;
  rejoinCode: string | null;
  rejoinExpires: number | null;
  createdAt: number;
  /** Photo version (bumped on each upload), or null. The image lives in the photos table. */
  photo?: number | null;
}

export interface ServerTeam {
  id: string;
  order: number;
  colour: string;
  badge: string;
  name: string | null;
  motto: string;
  /** In reveal order. */
  memberIds: string[];
  suggestions: string[];
  rerollUsed: boolean;
}

export interface RevealEvent {
  teamId: string;
  playerIds: string[];
  final: boolean;
}

export interface DrawState {
  phase: DrawPhase;
  revealMode: RevealMode;
  oddFallback: OddFallback | null;
  /** Fixed at lock. The wheel only ever reveals these, in this order. */
  events: RevealEvent[];
  step: number;
  lastStepAt: number | null;
  lockedAt: number | null;
}

export interface Activity {
  id: string;
  name: string;
  kind: ActivityKind;
  scoring: ScoringScheme;
  placements: number[];
  perCorrect: number;
  description: string;
  timerSeconds: number;
  resultsShown: boolean;
  createdAt: number;
}

/** One score change. Totals are always added up from these; nothing is ever deleted. */
export interface LedgerEntry {
  id: string;
  at: number;
  teamId: string;
  playerId: string | null;
  activityId: string | null;
  points: number;
  reason: string;
  kind: EntryKind;
  placement: number | null;
  voided: boolean;
  voidedAt: number | null;
  revealed: boolean;
}

export interface Snapshot {
  seq: number;
  at: number;
  final: boolean;
  /** Totals per team at the moment of the reveal. */
  teams: Record<string, number>;
  /** Each guest's contribution at the moment of the reveal. */
  players: Record<string, number>;
}

export interface StageState {
  screen: StageScreen;
  activityId: string | null;
  timer: { endsAt: number | null; remainingMs: number | null; durationMs: number } | null;
}

export interface ServerState {
  schema: 1;
  version: number;
  eventCode: string;
  createdAt: number;
  players: ServerPlayer[];
  teams: ServerTeam[];
  draw: DrawState;
  naming: { phase: NamingPhase; deadline: number | null };
  intermission: boolean;
  hostTokens: { token: string; createdAt: number }[];
  /** Every team name offered so far, so suggestions never repeat. */
  offeredNames: string[];
  nextId: number;
  activities: Activity[];
  ledger: LedgerEntry[];
  /** The last two leaderboard reveals: [previous, current]. */
  snapshots: Snapshot[];
  snapshotSeq: number;
  blackout: boolean;
  stage: StageState;
}

export function freshStage(): StageState {
  return { screen: "teams", activityId: null, timer: null };
}

/** Fills in fields added after an event was first created. */
export function migrate(s: ServerState): ServerState {
  s.activities ??= [];
  s.ledger ??= [];
  s.snapshots ??= [];
  s.snapshotSeq ??= 0;
  s.blackout ??= false;
  s.stage ??= freshStage();
  return s;
}

export function freshDraw(revealMode: RevealMode = "live", oddFallback: OddFallback | null = null): DrawState {
  return { phase: "draft", revealMode, oddFallback, events: [], step: 0, lastStepAt: null, lockedAt: null };
}

export function freshState(now: number): ServerState {
  return {
    schema: 1,
    version: 0,
    eventCode: randomCode(10),
    createdAt: now,
    players: [],
    teams: [],
    draw: freshDraw(),
    naming: { phase: "idle", deadline: null },
    intermission: false,
    hostTokens: [],
    offeredNames: [],
    nextId: 1,
    activities: [],
    ledger: [],
    snapshots: [],
    snapshotSeq: 0,
    blackout: false,
    stage: freshStage(),
  };
}

export function newId(state: ServerState, prefix: string): string {
  return `${prefix}${state.nextId++}`;
}
