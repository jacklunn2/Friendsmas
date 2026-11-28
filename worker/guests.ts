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
  MAX_DISHES,
  MAX_FACTS,
  type DishView,
  type DishCategory,
  type FoodWarning,
  type MenuItem,
  type QuestionnaireView,
} from "../shared/types";
import { findPlayer, str, UserError, type Handler, type Payload } from "./common";
import { newId, type Dish, type Questionnaire, type ServerPlayer, type ServerState } from "./state";

/** Every dish in a guest's answers. Answers from before multiple dishes have just the one. */
export function dishesOf(q: Questionnaire): Dish[] {
  return q.dishes?.length ? q.dishes : [{ id: "d0", dish: q.dish, category: q.category, dietary: q.dietary }];
}

/** Reads the dishes from the survey: a list, or the older single dish fields. Keeps dish ids and hidden flags by position. */
function parseDishes(s: ServerState, pl: ServerPlayer, p: Payload): Dish[] {
  const raw = Array.isArray(p.dishes) ? p.dishes : [{ dish: p.dish, category: p.category, dietary: p.dietary }];
  const list = raw.filter((d) => d && typeof d === "object" && typeof (d as Payload).dish === "string" && ((d as Payload).dish as string).trim()) as Payload[];
  if (!list.length) throw new UserError("Tell us what dish you're bringing.");
  if (list.length > MAX_DISHES) throw new UserError(`List up to ${MAX_DISHES} dishes.`);
  const old = pl.answers ? dishesOf(pl.answers) : [];
  return list.map((d, i) => {
    const category = d.category as DishCategory;
    if (!DISH_CATEGORIES.includes(category)) throw new UserError(`Choose what kind of dish ${list.length > 1 ? `dish ${i + 1} is` : "it is"}.`);
    const prev = old[i];
    return {
      id: prev?.id && prev.id !== "d0" ? prev.id : newId(s, "d"),
      dish: str(d, "dish", { max: DISH_MAX, label: "your dish" }),
      category,
      dietary: str(d, "dietary", { max: DIETARY_MAX, optional: true, label: "the dietary notes" }),
      ...(prev?.hidden ? { hidden: true } : {}),
    };
  });
}

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
  // Bringing someone else's dishes: keep a copy of them, in case they leave.
  const dishes = owner ? dishesOf(owner.answers).map((d) => ({ ...d })) : parseDishes(s, pl, p);
  const { dish, category, dietary } = dishes[0];
  // The hosts (the House) don't need secret facts.
  const house = p.house === undefined ? !!pl.house : p.house === true;
  if (!Array.isArray(p.facts) && !house) throw new UserError("Add at least one secret fact.");
  const rawFacts: unknown[] = Array.isArray(p.facts) ? p.facts : [];
  const texts = rawFacts.map((f, i) => {
    if (typeof f !== "string") throw new UserError("Facts must be text.");
    const t = f.trim().replace(/\s+/g, " ");
    if (t.length > FACT_MAX) throw new UserError(`Fact ${i + 1} must be ${FACT_MAX} characters or fewer.`);
    return t;
  }).filter(Boolean);
  if (!texts.length && !house) throw new UserError("Add at least one secret fact.");
  if (texts.length > MAX_FACTS) throw new UserError(`Add up to ${MAX_FACTS} facts.`);
  const old = pl.answers?.facts ?? [];
  const facts = texts.map((text, i) => ({ id: old[i]?.id ?? newId(s, "f"), text }));
  return { dish, category, dietary, dishes, facts, completedAt: pl.answers?.completedAt ?? now, updatedAt: now, sharedWith: owner?.id ?? null };
}

/** A guest's answers, with a shared dish shown as it is now. */
export function questionnaireView(q: Questionnaire | null | undefined, s?: ServerState, pl?: ServerPlayer): QuestionnaireView | null {
  if (!q) return null;
  const owner = s && pl ? dishOwner(s, pl) : null;
  const shared = owner && owner.id !== pl?.id ? owner : null;
  const src = shared ? shared.answers : q;
  const dishes: DishView[] = dishesOf(src).map((d) => ({ id: d.id, dish: d.dish, category: d.category, dietary: d.dietary, hidden: !!d.hidden }));
  return {
    dishes,
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
    .flatMap((p) => {
      const withIds = guests.filter((g) => g.id !== p.id && dishOwner(s, g).id === p.id).map((g) => g.id);
      // Dishes the host left off the welcome page stay off it.
      return dishesOf(p.answers)
        .filter((d) => !d.hidden)
        .map((d) => ({ playerId: p.id, dishId: d.id, dish: d.dish, category: d.category, dietary: d.dietary, withIds }));
    })
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
  // Dishes on the menu: hidden ones don't count.
  const shown = guests.flatMap((g) => dishesOf(g.answers).filter((d) => !d.hidden).map((d) => ({ g, d })));
  const byKey = new Map<string, typeof shown>();
  for (const x of shown) {
    const k = dishKey(x.d.dish);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), x]);
  }
  for (const group of byKey.values()) {
    const people = [...new Map(group.map((x) => [x.g.id, x.g])).values()];
    if (people.length < 2) continue;
    const names = people.map((g) => g.name);
    warnings.push({
      kind: "duplicate",
      message: `${joinNames(names)} are ${names.length === 2 ? "both" : "all"} bringing ${group[0].d.dish}.`,
      playerIds: people.map((g) => g.id),
    });
  }
  for (const c of EXPECTED_CATEGORIES) {
    if (!shown.some((x) => x.d.category === c)) {
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

/** Makes a guest one of the hosts (the House) or a player. Only before they're on a team. */
function setHouse(s: ServerState, pl: ServerPlayer, on: boolean) {
  if (on && pl.teamId) throw new UserError(`${pl.name} is already on a team, so can't join the House now.`);
  pl.house = on;
  // The House doesn't do secret missions.
  if (on) delete s.missions.assigned[pl.id];
}

export const guestsHost: Record<string, Handler> = {
  /** Puts a guest in the House (the hosts) or back among the players. */
  "guest.house": (s, _a, p) => {
    const pl = findPlayer(s, p.id);
    if ((p.on === true) === !!pl.house) return { noChange: true };
    setHouse(s, pl, p.on === true);
    return { audit: ["guest.house", p.on === true ? `${pl.name} is one of the hosts (the House)` : `${pl.name} is a player`] };
  },

  /** The host fills in or corrects a guest's answers (e.g. for someone who told them in person). */
  "guest.answers": (s, _a, p, now) => {
    const pl = findPlayer(s, p.playerId);
    pl.answers = parseAnswers(s, pl, p, now);
    return { audit: ["guest.answers", `Updated ${pl.name}'s questionnaire`] };
  },

  /** Leaves one of a guest's dishes off the welcome page's menu (or puts it back). Their answers don't change. */
  "guest.hideDish": (s, _a, p) => {
    const pl = findPlayer(s, p.playerId);
    if (!pl.answers) throw new UserError(`${pl.name} hasn't said what they're bringing yet.`);
    const dishes = dishesOf(pl.answers).map((d) => ({ ...d }));
    const d = dishes.find((x) => x.id === p.dishId);
    if (!d) throw new UserError("That dish is no longer in their answers.");
    if (!!d.hidden === (p.hidden === true)) return { noChange: true };
    d.hidden = p.hidden === true;
    pl.answers = { ...pl.answers, dishes };
    return { audit: ["guest.hideDish", `${pl.name}'s ${d.dish} ${d.hidden ? "left off" : "back on"} the welcome page`] };
  },

  /** Lists two guests' dish once: `playerId` is bringing `withId`'s dish with them (null separates them again). */
  "guest.shareDish": (s, _a, p) => {
    const pl = findPlayer(s, p.playerId);
    if (!pl.answers) throw new UserError(`${pl.name} hasn't said what they're bringing yet.`);
    if (p.withId === null) {
      if (!pl.answers.sharedWith) return { noChange: true };
      const owner = dishOwner(s, pl);
      // Keep the dish as it is now, as their own.
      pl.answers = {
        ...pl.answers,
        dish: owner.answers.dish,
        category: owner.answers.category,
        dietary: owner.answers.dietary,
        dishes: dishesOf(owner.answers).map((d) => ({ ...d, id: newId(s, "d") })),
        sharedWith: null,
      };
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
    if (p.house !== undefined && (p.house === true) !== !!pl.house) setHouse(s, pl, p.house === true);
    pl.answers = parseAnswers(s, pl, p, now);
    return { audit: ["player.answers", first ? `${pl.name} finished the questionnaire` : `${pl.name} updated their questionnaire`] };
  },
};
