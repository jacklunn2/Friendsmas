import type {
  DrawPhase,
  NamingPhase,
  OddFallback,
  PlayerStatus,
  RevealMode,
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
  };
}

export function newId(state: ServerState, prefix: string): string {
  return `${prefix}${state.nextId++}`;
}
