// Shared building blocks for the game rules (logic.ts and scoring.ts).

import type { Role } from "../shared/types";
import type { ServerPlayer, ServerState, ServerTeam } from "./state";

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

export type Payload = Record<string, unknown>;
export type Handler = (s: ServerState, actor: Actor, p: Payload, now: number) => ActionResult;

export function str(p: Payload, key: string, opts: { max?: number; optional?: boolean; label?: string } = {}): string {
  const label = opts.label ?? key;
  const v = p[key];
  if (v === undefined || v === null) {
    if (opts.optional) return "";
    throw new UserError(`Enter ${label}.`);
  }
  if (typeof v !== "string") throw new UserError(`${capitalise(label)} must be text.`);
  const t = v.trim().replace(/\s+/g, " ");
  if (!t && !opts.optional) throw new UserError(`Enter ${label}.`);
  if (opts.max && t.length > opts.max) throw new UserError(`${capitalise(label)} must be ${opts.max} characters or fewer.`);
  return t;
}

/** Multi-line text, kept as written apart from trimming. */
export function text(p: Payload, key: string, max: number, label = key): string {
  const v = p[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new UserError(`${capitalise(label)} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new UserError(`${capitalise(label)} must be ${max} characters or fewer.`);
  return t;
}

export function int(p: Payload, key: string, opts: { min: number; max: number; label?: string }): number {
  const label = opts.label ?? key;
  const v = p[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new UserError(`${capitalise(label)} must be a whole number.`);
  if (v < opts.min || v > opts.max) throw new UserError(`${capitalise(label)} must be between ${opts.min} and ${opts.max}.`);
  return v;
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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

export function teamLabel(t: ServerTeam): string {
  return t.name ?? `Team ${t.order + 1}`;
}

export function requireComplete(s: ServerState) {
  if (s.draw.phase !== "complete") throw new UserError("Finish the team draw first.");
}
