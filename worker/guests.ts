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

/** Validates a questionnaire. Fact ids are kept by position, so editing a fact keeps any poll that uses it. */
export function parseAnswers(s: ServerState, pl: ServerPlayer, p: Payload, now: number): Questionnaire {
  const dish = str(p, "dish", { max: DISH_MAX, label: "your dish" });
  const category = p.category as DishCategory;
  if (!DISH_CATEGORIES.includes(category)) throw new UserError("Choose what kind of dish it is.");
  const dietary = str(p, "dietary", { max: DIETARY_MAX, optional: true, label: "the dietary notes" });
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
  return { dish, category, dietary, facts, completedAt: pl.answers?.completedAt ?? now, updatedAt: now };
}

export function questionnaireView(q: Questionnaire | null | undefined): QuestionnaireView | null {
  if (!q) return null;
  return { dish: q.dish, category: q.category, dietary: q.dietary, facts: q.facts.map((f) => ({ ...f })), completedAt: q.completedAt };
}

/** Guests who count for the menu and the questionnaire list. */
function guestsWithAnswers(s: ServerState): (ServerPlayer & { answers: Questionnaire })[] {
  return s.players.filter((p): p is ServerPlayer & { answers: Questionnaire } => !!p.answers && p.status !== "pending");
}

/** The food list for the TV: dish, category and notes only. Never facts. */
export function menuView(s: ServerState): MenuItem[] {
  return guestsWithAnswers(s)
    .map((p) => ({ playerId: p.id, dish: p.answers.dish, category: p.answers.category, dietary: p.answers.dietary }))
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
  const guests = guestsWithAnswers(s);
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
