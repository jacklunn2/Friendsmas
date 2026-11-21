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

/** Locks and reveals the whole draw. */
function drawTeams(s: ServerState) {
  runAction(s, HOST, "draw.options", { revealMode: "finale" }, T0);
  runAction(s, HOST, "draw.lock", {}, T0);
  runAction(s, HOST, "draw.skip", {}, T0);
  expect(s.draw.phase).toBe("complete");
}

describe("secret missions", () => {
  it("starts with a few example missions the host can change", () => {
    const s = setup(2);
    const list = hostView(s, [], T0).missions.list;
    expect(list.length).toBeGreaterThanOrEqual(5);
    runAction(s, HOST, "missions.update", { id: list[0].id, text: "Hide a sprout in someone's drink" }, T0);
    runAction(s, HOST, "missions.add", { text: "Get a hug from the host" }, T0);
    runAction(s, HOST, "missions.delete", { id: list[1].id }, T0);
    const after = hostView(s, [], T0).missions.list.map((m) => m.text);
    expect(after[0]).toBe("Hide a sprout in someone's drink");
    expect(after).toContain("Get a hug from the host");
    expect(after).toHaveLength(list.length);
  });

  it("hands every guest a different mission, seen only on their own phone", () => {
    const s = setup(6);
    runAction(s, HOST, "missions.handOut", {}, T0);
    const assigned = hostView(s, [], T0).missions.assignments;
    expect(assigned).toHaveLength(6);
    expect(new Set(assigned.map((a) => a.missionId)).size).toBe(6);
    const mine = playerView(s, s.players[0].id, T0).myMission!;
    expect(mine.seen).toBe(false);
    const theirs = assigned.find((a) => a.playerId === s.players[0].id)!;
    expect(mine.text).toBe(theirs.text);
    // Nobody else gets it: not the TV, not another phone.
    const others = JSON.stringify([stageView(s, T0), playerView(s, s.players[1].id, T0), playerView(s, null, T0)]);
    expect(others).not.toContain(mine.text);
    runAction(s, as(s, 0), "mission.seen", {}, T0);
    expect(playerView(s, s.players[0].id, T0).myMission!.seen).toBe(true);
  });

  it("says when there aren't enough missions, and never repeats one", () => {
    const s = setup(8);
    const r = runAction(s, HOST, "missions.handOut", {}, T0);
    expect(r.data).toEqual({ given: 6, short: 2 });
    expect(() => runAction(s, HOST, "missions.redraw", { playerId: s.players[0].id }, T0)).toThrow(/no unused missions/);
    runAction(s, HOST, "missions.add", { text: "Mission seven" }, T0);
    runAction(s, HOST, "missions.add", { text: "Mission eight" }, T0);
    runAction(s, HOST, "missions.handOut", {}, T0);
    expect(new Set(Object.values(s.missions.assigned).map((a) => a.missionId)).size).toBe(8);
    expect(() => runAction(s, HOST, "missions.handOut", {}, T0)).toThrow(/already has a mission/);
  });

  it("can hand missions out as guests join", () => {
    const s = freshState(T0);
    runAction(s, HOST, "missions.auto", { on: true }, T0);
    runAction(s, HOST, "guest.add", { names: "Zed" }, T0);
    runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: s.players[0].id, emoji: "🎅" }, T0);
    expect(playerView(s, s.players[0].id, T0).myMission).not.toBeNull();
  });

  it("lets the host choose or redraw a mission, but not one someone else has", () => {
    const s = setup(2);
    runAction(s, HOST, "missions.handOut", {}, T0);
    const [a, b] = hostView(s, [], T0).missions.assignments;
    expect(() => runAction(s, HOST, "missions.assign", { playerId: a.playerId, missionId: b.missionId }, T0)).toThrow(/already has/);
    expect(() => runAction(s, HOST, "missions.delete", { id: a.missionId }, T0)).toThrow(/Redraw/);
    runAction(s, HOST, "missions.redraw", { playerId: a.playerId }, T0);
    const now = s.missions.assigned[a.playerId];
    expect(now.missionId).not.toBe(a.missionId);
    expect(now.missionId).not.toBe(b.missionId);
    runAction(s, HOST, "missions.assign", { playerId: a.playerId, missionId: a.missionId }, T0);
    expect(s.missions.assigned[a.playerId].missionId).toBe(a.missionId);
  });

  it("gives +5 to the team for a completed mission, hidden until the next reveal, and voids it if noticed", () => {
    const s = setup(4);
    drawTeams(s);
    runAction(s, HOST, "missions.handOut", {}, T0);
    const pid = s.players[0].id;
    const team = s.players[0].teamId!;
    runAction(s, HOST, "missions.complete", { playerId: pid }, T0);
    expect(hostView(s, [], T0).liveTotals[team]).toBe(5);
    const entry = s.ledger.at(-1)!;
    expect(entry).toMatchObject({ playerId: pid, teamId: team, points: 5, revealed: false });
    // Still a secret: not on the TV, and the guest's phone doesn't say "completed" yet.
    expect(stageView(s, T0).standings).toBeNull();
    expect(playerView(s, pid, T0).myMission!.status).toBe("active");
    runAction(s, HOST, "standings.reveal", {}, T0 + 1);
    expect(stageView(s, T0).standings!.rows.find((r) => r.teamId === team)!.points).toBe(5);
    expect(playerView(s, pid, T0).myMission!.status).toBe("completed");
    // Noticed after all: the +5 is voided, not deleted.
    runAction(s, HOST, "missions.notice", { playerId: pid }, T0 + 2);
    expect(s.ledger.find((e) => e.id === entry.id)!.voided).toBe(true);
    expect(hostView(s, [], T0).liveTotals[team]).toBe(0);
    expect(playerView(s, pid, T0).myMission!.status).toBe("noticed");
    // And back again.
    runAction(s, HOST, "missions.complete", { playerId: pid }, T0 + 3);
    expect(hostView(s, [], T0).liveTotals[team]).toBe(5);
    expect(s.ledger.filter((e) => e.reason === "Secret mission")).toHaveLength(2);
  });

  it("needs the teams drawn before a mission can score", () => {
    const s = setup(2);
    runAction(s, HOST, "missions.handOut", {}, T0);
    expect(() => runAction(s, HOST, "missions.complete", { playerId: s.players[0].id }, T0)).toThrow(/team draw/);
  });

  it("reveals every mission on the TV only when the host chooses", () => {
    const s = setup(4);
    drawTeams(s);
    expect(() => runAction(s, HOST, "stage.show", { screen: "missions" }, T0)).toThrow(/Hand out/);
    runAction(s, HOST, "missions.handOut", {}, T0);
    runAction(s, HOST, "missions.complete", { playerId: s.players[1].id }, T0);
    runAction(s, HOST, "missions.notice", { playerId: s.players[2].id }, T0);
    expect(stageView(s, T0).missionsReveal).toBeNull();
    runAction(s, HOST, "stage.show", { screen: "missions" }, T0);
    const rows = stageView(s, T0).missionsReveal!;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ playerId: s.players[1].id, status: "completed" });
    expect(rows[1]).toMatchObject({ playerId: s.players[2].id, status: "noticed" });
  });

  it("forgets who had which mission when starting fresh, but keeps the list", () => {
    const s = setup(2);
    runAction(s, HOST, "missions.handOut", {}, T0);
    const n = s.missions.list.length;
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.missions.assigned).toEqual({});
    expect(s.missions.list).toHaveLength(n);
  });
});
