// Block 4: the questionnaire, the welcome screen, secret missions, polls,
// the grand prize, videos and The House.

import { describe, expect, it } from "vitest";
import { runAction, type Actor } from "../worker/logic";
import { dishKey } from "../worker/guests";
import { freshState, migrate, type ServerState } from "../worker/state";
import { hostView, playerView, stageView } from "../worker/views";

const HOST: Actor = { role: "host", playerId: null };
const T0 = 1_700_000_000_000;

function setup(n: number) {
  const s = freshState(T0);
  runAction(s, HOST, "guest.add", { names: Array.from({ length: n }, (_, i) => `Guest ${i + 1}`).join("\n") }, T0);
  for (const p of s.players) runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: p.id, emoji: "🎅" }, T0);
  return s;
}

const as = (s: ServerState, i: number): Actor => ({ role: "player", playerId: s.players[i].id });

/** Everything every phone and the TV are sent, as one string. */
function publicJson(s: ServerState) {
  return JSON.stringify([stageView(s, T0), ...s.players.map((p) => playerView(s, p.id, T0)), playerView(s, null, T0)]);
}

function answers(dish: string, category: string, facts = ["I once met a famous goat"]) {
  return { dish, category, dietary: "", facts };
}

describe("the questionnaire", () => {
  it("saves a guest's food and facts, and keeps fact ids when they're edited", () => {
    const s = setup(3);
    expect(playerView(s, s.players[0].id, T0).myQuestionnaire).toBeNull();
    runAction(s, as(s, 0), "player.answers", { dish: "  Pigs in   blankets ", category: "side", dietary: "Contains pork", facts: ["Fact one", "", "Fact two"] }, T0);
    const mine = playerView(s, s.players[0].id, T0).myQuestionnaire!;
    expect(mine.dish).toBe("Pigs in blankets");
    expect(mine.facts.map((f) => f.text)).toEqual(["Fact one", "Fact two"]);
    const firstId = mine.facts[0].id;
    runAction(s, as(s, 0), "player.answers", { ...answers("Pigs in blankets", "side"), facts: ["Fact one, edited"] }, T0 + 5);
    const again = playerView(s, s.players[0].id, T0).myQuestionnaire!;
    expect(again.facts).toEqual([{ id: firstId, text: "Fact one, edited" }]);
    expect(again.completedAt).toBe(T0);
  });

  it("checks the answers", () => {
    const s = setup(1);
    expect(() => runAction(s, as(s, 0), "player.answers", answers("", "main"), T0)).toThrow(/dish/);
    expect(() => runAction(s, as(s, 0), "player.answers", answers("Trifle", "pudding"), T0)).toThrow(/kind of dish/);
    expect(() => runAction(s, as(s, 0), "player.answers", answers("Trifle", "dessert", ["", " "]), T0)).toThrow(/secret fact/);
    expect(() => runAction(s, as(s, 0), "player.answers", answers("Trifle", "dessert", ["a", "b", "c", "d"]), T0)).toThrow(/up to 3/);
    expect(() => runAction(s, { role: "player", playerId: null }, "player.answers", answers("Trifle", "dessert"), T0)).toThrow(/Join/);
  });

  it("never sends secret facts to the TV or to other phones", () => {
    const s = setup(3);
    runAction(s, as(s, 0), "player.answers", answers("Trifle", "dessert", ["I was on Blue Peter"]), T0);
    const others = JSON.stringify([stageView(s, T0), playerView(s, s.players[1].id, T0), playerView(s, null, T0)]);
    expect(others).not.toContain("Blue Peter");
    expect(stageView(s, T0).menu).toEqual([{ playerId: s.players[0].id, dish: "Trifle", category: "dessert", dietary: "" }]);
    expect(hostView(s, [], T0).questionnaires[s.players[0].id].facts[0].text).toBe("I was on Blue Peter");
  });

  it("warns about duplicate dishes and missing courses", () => {
    const s = setup(4);
    expect(hostView(s, [], T0).foodWarnings).toEqual([]);
    runAction(s, as(s, 0), "player.answers", answers("Trifle", "dessert"), T0);
    runAction(s, as(s, 1), "player.answers", answers("The trifles!", "dessert"), T0);
    runAction(s, as(s, 2), "player.answers", answers("Roast potatoes", "side"), T0);
    const w = hostView(s, [], T0).foodWarnings;
    expect(w.filter((x) => x.kind === "duplicate")).toEqual([
      { kind: "duplicate", message: "Guest 1 and Guest 2 are both bringing Trifle.", playerIds: [s.players[0].id, s.players[1].id] },
    ]);
    expect(w.filter((x) => x.kind === "missing").map((x) => x.message)).toEqual([
      "Nobody is bringing mains yet.",
      "Nobody is bringing drinks yet.",
    ]);
    expect(dishKey("My homemade Mince Pies")).toBe(dishKey("mince pie"));
  });

  it("lets the host fill in answers for a guest", () => {
    const s = setup(2);
    runAction(s, HOST, "guest.answers", { playerId: s.players[1].id, ...answers("Mulled wine", "drinks") }, T0);
    expect(playerView(s, s.players[1].id, T0).myQuestionnaire!.dish).toBe("Mulled wine");
  });

  it("upgrades an event saved before the questionnaire existed", () => {
    const s = setup(1);
    const old = JSON.parse(JSON.stringify(s));
    expect(() => playerView(migrate(old), old.players[0].id, T0)).not.toThrow();
    expect(publicJson(s)).toBeTruthy();
  });
});

describe("the welcome screen", () => {
  it("shows the host's agenda, keeping row ids and dropping blank rows", () => {
    const s = setup(2);
    runAction(s, HOST, "agenda.save", { items: [{ time: "12:00", item: "Arrivals" }, { time: "", item: "" }, { time: "1pm", item: "  The draw " }] }, T0);
    const first = stageView(s, T0).agenda;
    expect(first.map((a) => [a.time, a.item])).toEqual([["12:00", "Arrivals"], ["1pm", "The draw"]]);
    runAction(s, HOST, "agenda.save", { items: [first[1], { ...first[0], time: "12:30" }] }, T0);
    const second = stageView(s, T0).agenda;
    expect(second.map((a) => a.id)).toEqual([first[1].id, first[0].id]);
    expect(playerView(s, s.players[0].id, T0).agenda).toHaveLength(2);
    expect(() => runAction(s, HOST, "agenda.save", { items: [{ time: "2pm", item: "" }] }, T0)).toThrow(/description/);
    expect(() => runAction(s, HOST, "agenda.save", { items: Array.from({ length: 15 }, () => ({ item: "x" })) }, T0)).toThrow(/up to 14/);
  });

  it("can go back on the TV after the draw, and the agenda survives starting fresh", () => {
    const s = setup(2);
    runAction(s, HOST, "agenda.save", { items: [{ time: "12:00", item: "Arrivals" }] }, T0);
    runAction(s, HOST, "stage.show", { screen: "welcome" }, T0);
    expect(stageView(s, T0).stage.screen).toBe("welcome");
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.agenda).toHaveLength(1);
  });
});
