// The guest questionnaire (Block 4): what each guest is bringing to eat, and
// their secret facts for "Who wrote this?". Guests fill it in from the guest
// link, any time before or on the day. Facts are host-only: they never reach
// the TV or another phone until the host uses one in a poll.

import {
  DIETARY_MAX,
  DISH_CATEGORIES,
  DISH_CATEGORY_LABEL,
  DISH_MAX,
  EXPECTED_CATEGORIES,
  FACT_MAX,
  MAX_FACTS,
  type DishCategory,
  type FoodWarning,
  type MenuItem,
  type QuestionnaireView,
} from "../shared/types";
import { findPlayer, str, UserError, type Handler, type Payload } from "./common";
import { newId, type Questionnaire, type ServerPlayer, type ServerState } from "./state";

/** Guests with answers, who aren't sharing someone else's dish. Follows a chain to its start. */
function dishOwner(s: ServerState, pl: ServerPlayer): ServerPlayer & { answers: Questionnaire } {
  let cur = pl as ServerPlayer & { answers: Questionnaire };
  const seen = new Set<string>();
  while (cur.answers?.sharedWith && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = s.players.find((x) => x.id === cur.answers.sharedWith && x.answers && x.status !== "pending");
    if (!next || seen.has(next.id)) break;
    cur = next as ServerPlayer & { answers: Questionnaire };
  }
  return cur;
}

/** Validates "bringing it with": the guest whose dish it is (never yourself). */
function sharedTarget(s: ServerState, pl: ServerPlayer, id: unknown) {
  if (id === null || id === undefined || id === "") return null;
  const target = s.players.find((x) => x.id === id);
  if (!target?.answers) throw new UserError("That dish is no longer on the menu. Choose another, or type your own.");
  const owner = dishOwner(s, target);
  if (owner.id === pl.id) throw new UserError("That's your own dish.");
  return owner;
}

/** Validates a questionnaire. Fact ids are kept by position, so editing a fact keeps any poll that uses it. */
export function parseAnswers(s: ServerState, pl: ServerPlayer, p: Payload, now: number): Questionnaire {
  const owner = sharedTarget(s, pl, p.sharedWith);
  // Bringing someone else's dish: keep a copy of it, in case they leave.
  const dish = owner ? owner.answers.dish : str(p, "dish", { max: DISH_MAX, label: "your dish" });
  const category = (owner ? owner.answers.category : p.category) as DishCategory;
  if (!DISH_CATEGORIES.includes(category)) throw new UserError("Choose what kind of dish it is.");
  const dietary = owner ? owner.answers.dietary : str(p, "dietary", { max: DIETARY_MAX, optional: true, label: "the dietary notes" });
  if (!Array.isArray(p.facts)) throw new UserError("Add at least one secret fact.");
  const texts = p.facts.map((f, i) => {
    if (typeof f !== "string") throw new UserError("Facts must be text.");
    const t = f.trim().replace(/\s+/g, " ");
    if (t.length > FACT_MAX) throw new UserError(`Fact ${i + 1} must be ${FACT_MAX} characters or fewer.`);
    return t;
  }).filter(Boolean);
  if (!texts.length) throw new UserError("Add at least one secret fact.");
  if (texts.length > MAX_FACTS) throw new UserError(`Add up to ${MAX_FACTS} facts.`);
  const old = pl.answers?.facts ?? [];
  const facts = texts.map((text, i) => ({ id: old[i]?.id ?? newId(s, "f"), text }));
  return { dish, category, dietary, facts, completedAt: pl.answers?.completedAt ?? now, updatedAt: now, sharedWith: owner?.id ?? null };
}

/** A guest's answers, with a shared dish shown as it is now. */
export function questionnaireView(q: Questionnaire | null | undefined, s?: ServerState, pl?: ServerPlayer): QuestionnaireView | null {
  if (!q) return null;
  const owner = s && pl ? dishOwner(s, pl) : null;
  const shared = owner && owner.id !== pl?.id ? owner : null;
  const src = shared ? shared.answers : q;
  return {
    dish: src.dish,
    category: src.category,
    dietary: src.dietary,
    facts: q.facts.map((f) => ({ ...f })),
    completedAt: q.completedAt,
    sharedWith: shared?.id ?? null,
  };
}

/** Guests who count for the menu and the questionnaire list. */
function guestsWithAnswers(s: ServerState): (ServerPlayer & { answers: Questionnaire })[] {
  return s.players.filter((p): p is ServerPlayer & { answers: Questionnaire } => !!p.answers && p.status !== "pending");
}

/** The food list for the TV: dish, category and notes only. Never facts. A dish brought by two people appears once. */
export function menuView(s: ServerState): MenuItem[] {
  const guests = guestsWithAnswers(s);
  const owners = guests.filter((p) => dishOwner(s, p).id === p.id);
  return owners
    .map((p) => ({
      playerId: p.id,
      dish: p.answers.dish,
      category: p.answers.category,
      dietary: p.answers.dietary,
      withIds: guests.filter((g) => g.id !== p.id && dishOwner(s, g).id === p.id).map((g) => g.id),
    }))
    .sort((a, b) => DISH_CATEGORIES.indexOf(a.category) - DISH_CATEGORIES.indexOf(b.category) || a.dish.localeCompare(b.dish));
}

/** "The Trifle!" and "trifles" are the same dish. */
export function dishKey(dish: string): string {
  return dish
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["a", "an", "the", "my", "some", "homemade", "home", "made"].includes(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");
}

/** Warnings for the control room's food list: two people bringing the same thing, or a course nobody is bringing. */
export function foodWarnings(s: ServerState): FoodWarning[] {
  // Guests bringing someone else's dish aren't a duplicate of it.
  const guests = guestsWithAnswers(s).filter((p) => dishOwner(s, p).id === p.id);
  if (!guests.length) return [];
  const warnings: FoodWarning[] = [];
  const byKey = new Map<string, typeof guests>();
  for (const g of guests) {
    const k = dishKey(g.answers.dish);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), g]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const names = group.map((g) => g.name);
    warnings.push({
      kind: "duplicate",
      message: `${joinNames(names)} are ${names.length === 2 ? "both" : "all"} bringing ${group[0].answers.dish}.`,
      playerIds: group.map((g) => g.id),
    });
  }
  for (const c of EXPECTED_CATEGORIES) {
    if (!guests.some((g) => g.answers.category === c)) {
      warnings.push({ kind: "missing", message: `Nobody is bringing ${DISH_CATEGORY_LABEL[c].toLowerCase()} yet.`, playerIds: [] });
    }
  }
  return warnings;
}

function joinNames(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Every secret fact, with its writer. */
export function allFacts(s: ServerState): { id: string; text: string; playerId: string }[] {
  return s.players.flatMap((p) => (p.answers?.facts ?? []).map((f) => ({ ...f, playerId: p.id })));
}

export const guestsHost: Record<string, Handler> = {
  /** The host fills in or corrects a guest's answers (e.g. for someone who told them in person). */
  "guest.answers": (s, _a, p, now) => {
    const pl = findPlayer(s, p.playerId);
    pl.answers = parseAnswers(s, pl, p, now);
    return { audit: ["guest.answers", `Updated ${pl.name}'s questionnaire`] };
  },

  /** Lists two guests' dish once: `playerId` is bringing `withId`'s dish with them (null separates them again). */
  "guest.shareDish": (s, _a, p) => {
    const pl = findPlayer(s, p.playerId);
    if (!pl.answers) throw new UserError(`${pl.name} hasn't said what they're bringing yet.`);
    if (p.withId === null) {
      if (!pl.answers.sharedWith) return { noChange: true };
      const owner = dishOwner(s, pl);
      // Keep the dish as it is now, as their own.
      pl.answers = { ...pl.answers, dish: owner.answers.dish, category: owner.answers.category, dietary: owner.answers.dietary, sharedWith: null };
      return { audit: ["guest.shareDish", `${pl.name}'s dish is listed separately again`] };
    }
    const owner = sharedTarget(s, pl, p.withId)!;
    pl.answers = { ...pl.answers, sharedWith: owner.id, dish: owner.answers.dish, category: owner.answers.category, dietary: owner.answers.dietary };
    return { audit: ["guest.shareDish", `${pl.name} is bringing ${owner.answers.dish} with ${owner.name}`] };
  },
};

export const guestsPlayer: Record<string, Handler> = {
  "player.answers": (s, actor, p, now) => {
    if (!actor.playerId) throw new UserError("Join the event first.");
    const pl = findPlayer(s, actor.playerId);
    const first = !pl.answers;
    pl.answers = parseAnswers(s, pl, p, now);
    return { audit: ["player.answers", first ? `${pl.name} finished the questionnaire` : `${pl.name} updated their questionnaire`] };
  },
};
