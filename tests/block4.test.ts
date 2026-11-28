// Block 4: the questionnaire, the welcome screen, secret missions, polls,
// the grand prize, videos and The House.

import { describe, expect, it } from "vitest";
import { runAction, type Actor } from "../worker/logic";
import { dishKey } from "../worker/guests";
import { checkVideoUpload, registerVideo } from "../worker/show";
import { nextAlarmAt, onAlarm } from "../worker/logic";
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

/** Everything every phone and the TV are sent, as one string (minus each guest's own answers, which they wrote). */
function publicJson(s: ServerState) {
  return JSON.stringify([stageView(s, T0), ...s.players.map((p) => ({ ...playerView(s, p.id, T0), myQuestionnaire: null })), playerView(s, null, T0)]);
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
    expect(playerView(s, pid, T0).myMission).toMatchObject({ status: "noticed", noticedAt: T0 + 2 });
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

describe("polls on phones", () => {
  /** Six guests in three pairs, drawn, with answers so "Who wrote this?" has facts. */
  function pollSetup() {
    const s = setup(6);
    s.players.forEach((_, i) => runAction(s, as(s, i), "player.answers", answers(`Dish ${i}`, "main", [`Secret ${i}`]), T0));
    drawTeams(s);
    return s;
  }
  const vote = (s: ServerState, i: number, key: string) =>
    runAction(s, as(s, i), "poll.vote", { questionId: s.activities.at(-1)!.polls![s.quiz.index].id, key }, T0 + 10);

  it("hides votes until the reveal, and stops guests voting for themselves", () => {
    const s = pollSetup();
    const { id } = runAction(s, HOST, "activity.create", { name: "Superlatives", format: "poll", perCorrect: 1 }, T0).data as { id: string };
    runAction(s, HOST, "poll.question.save", { activityId: id, question: { prompt: "Most likely to cry at a Christmas advert", optionsKind: "players", scoring: "winner", points: 3 } }, T0);
    runAction(s, HOST, "poll.start", { activityId: id }, T0);
    runAction(s, HOST, "poll.open", {}, T0);
    const [a, b, c] = s.players;
    expect(() => vote(s, 0, a.id)).toThrow(/yourself/);
    vote(s, 0, b.id);
    vote(s, 2, b.id);
    vote(s, 1, c.id);
    const tv = stageView(s, T0).poll!;
    expect(tv.answeredIds.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(tv.reveal).toBeNull();
    expect(JSON.stringify(stageView(s, T0))).not.toContain(`"value"`);
    expect(playerView(s, a.id, T0).myPollVote).toBe(b.id);
    runAction(s, HOST, "poll.reveal", {}, T0 + 20);
    const r = stageView(s, T0).poll!.reveal!;
    expect(r.counts[b.id]).toBe(2);
    expect(r.winners).toEqual([b.id]);
    // The winner's team gets the points, credited to them, hidden until the results.
    const e = s.ledger.filter((x) => !x.voided && x.activityId === id);
    expect(e).toMatchObject([{ playerId: b.id, teamId: b.teamId, points: 3, revealed: false }]);
    expect(() => vote(s, 3, a.id)).toThrow(/closed/);
  });

  it("scores voting with the majority, shares ties, and can be just for fun", () => {
    const s = pollSetup();
    const { id } = runAction(s, HOST, "activity.create", { name: "Hot takes", format: "poll" }, T0).data as { id: string };
    runAction(s, HOST, "poll.question.save", { activityId: id, question: { prompt: "Best Christmas film", optionsKind: "custom", options: ["Elf", "Die Hard", "Love Actually"], scoring: "majority", points: 2 } }, T0);
    runAction(s, HOST, "poll.question.save", { activityId: id, question: { prompt: "Best team", optionsKind: "teams", scoring: "none" } }, T0);
    expect(() =>
      runAction(s, HOST, "poll.question.save", { activityId: id, question: { prompt: "x", optionsKind: "custom", options: ["a", "b"], scoring: "winner", points: 1 } }, T0),
    ).toThrow(/can't win points/);
    runAction(s, HOST, "poll.start", { activityId: id }, T0);
    runAction(s, HOST, "poll.open", {}, T0);
    vote(s, 0, "0");
    vote(s, 1, "0");
    vote(s, 2, "1");
    vote(s, 3, "1");
    vote(s, 4, "2");
    runAction(s, HOST, "poll.reveal", {}, T0 + 20);
    expect(stageView(s, T0).poll!.reveal!.winners.sort()).toEqual(["0", "1"]);
    const paid = s.ledger.filter((x) => !x.voided && x.activityId === id).map((x) => x.playerId).sort();
    expect(paid).toEqual([s.players[0].id, s.players[1].id, s.players[2].id, s.players[3].id].sort());
    // Teams: can't vote for your own, and "just for fun" scores nothing.
    runAction(s, HOST, "poll.open", {}, T0 + 30);
    expect(() => vote(s, 0, s.players[0].teamId!)).toThrow(/own team/);
    const other = s.teams.find((t) => t.id !== s.players[0].teamId)!;
    vote(s, 0, other.id);
    runAction(s, HOST, "poll.reveal", {}, T0 + 40);
    expect(s.ledger.filter((x) => !x.voided && x.activityId === id)).toHaveLength(4);
  });

  it("plays Who wrote this? with secret facts: points for right guesses, a bonus for the best fooler", () => {
    const s = pollSetup();
    const { id } = runAction(s, HOST, "activity.create", { name: "Who wrote this?", format: "poll", pollKind: "whowrote", perCorrect: 2, foolBonus: 5 }, T0).data as { id: string };
    const fact0 = s.players[0].answers!.facts[0];
    const fact1 = s.players[1].answers!.facts[0];
    runAction(s, HOST, "poll.question.save", { activityId: id, question: { factId: fact0.id } }, T0);
    runAction(s, HOST, "poll.question.save", { activityId: id, question: { factId: fact1.id } }, T0);
    expect(() => runAction(s, HOST, "poll.question.save", { activityId: id, question: { factId: fact1.id } }, T0)).toThrow(/already/);
    expect(() => runAction(s, HOST, "poll.question.save", { activityId: id, question: { factId: "nope" } }, T0)).toThrow(/secret facts/);
    // The facts stay secret until their question is open.
    runAction(s, HOST, "poll.start", { activityId: id }, T0);
    expect(publicJson(s)).not.toContain("Secret 0");
    runAction(s, HOST, "poll.open", {}, T0);
    const tv = stageView(s, T0).poll!;
    expect(tv.question!.prompt).toBe("Secret 0");
    expect(JSON.stringify(tv)).not.toContain(`"writerId":"${s.players[0].id}"`);
    expect(publicJson(s)).not.toContain("Secret 1");
    expect(playerView(s, s.players[0].id, T0).myFactOnTv).toBe(true);
    expect(() => vote(s, 0, s.players[1].id)).toThrow(/yours/);
    // Fact 0 (Guest 1's): two right, three fooled.
    const [p0, p1, p2] = s.players.map((p) => p.id);
    vote(s, 1, p0);
    vote(s, 2, p0);
    vote(s, 3, p1);
    vote(s, 4, p2);
    vote(s, 5, p1);
    runAction(s, HOST, "poll.reveal", {}, T0 + 20);
    const r = stageView(s, T0).poll!.reveal!;
    expect(r.writerId).toBe(p0);
    expect(r.correctIds.sort()).toEqual([p1, p2].sort());
    const live = () => s.ledger.filter((x) => !x.voided && x.activityId === id);
    expect(live().filter((e) => e.points === 2)).toHaveLength(2);
    expect(live().filter((e) => e.points === 5).map((e) => e.playerId)).toEqual([p0]);
    // Fact 1 (Guest 2's): fools four, so the bonus moves to Guest 2.
    runAction(s, HOST, "poll.open", {}, T0 + 30);
    vote(s, 0, p2);
    vote(s, 2, s.players[3].id);
    vote(s, 3, s.players[4].id);
    vote(s, 4, s.players[5].id);
    vote(s, 5, p0);
    runAction(s, HOST, "poll.reveal", {}, T0 + 40);
    expect(live().filter((e) => e.points === 5).map((e) => e.playerId)).toEqual([p1]);
    expect(s.ledger.filter((e) => e.points === 5 && e.voided)).toHaveLength(1);
  });

  it("lets the host choose which facts to use and their order", () => {
    const s = pollSetup();
    const { id } = runAction(s, HOST, "activity.create", { name: "Who wrote this?", format: "poll", pollKind: "whowrote" }, T0).data as { id: string };
    for (const i of [2, 0, 4]) runAction(s, HOST, "poll.question.save", { activityId: id, question: { factId: s.players[i].answers!.facts[0].id } }, T0);
    const first = s.activities.at(-1)!.polls![0].id;
    runAction(s, HOST, "poll.question.move", { activityId: id, questionId: first, direction: "down" }, T0);
    expect(hostView(s, [], T0).polls[id].map((q) => q.factId)).toEqual([0, 2, 4].map((i) => s.players[i].answers!.facts[0].id));
    runAction(s, HOST, "poll.question.delete", { activityId: id, questionId: first }, T0);
    expect(hostView(s, [], T0).polls[id]).toHaveLength(2);
  });
});

describe("the grand prize", () => {
  it("keeps a trophy photo and a hall of fame, and deletes pictures that are replaced or removed", () => {
    const s = setup(2);
    expect(() => runAction(s, HOST, "prize.trophy", { imageId: "../etc" }, T0)).toThrow(/Upload/);
    runAction(s, HOST, "prize.trophy", { imageId: "trophy111" }, T0);
    const r = runAction(s, HOST, "prize.trophy", { imageId: "trophy222" }, T0);
    expect(r.deleteImages).toEqual(["trophy111"]);
    expect(stageView(s, T0).prize.trophyImageId).toBe("trophy222");
    runAction(s, HOST, "prize.winner.add", { imageId: "winners2023", caption: "2023: The Baubles" }, T0);
    runAction(s, HOST, "prize.winner.add", { imageId: "winners2024", caption: "2024: Sprout Squad" }, T0);
    const [w1, w2] = s.prize.pastWinners;
    runAction(s, HOST, "prize.winner.move", { id: w2.id, direction: "up" }, T0);
    expect(stageView(s, T0).prize.pastWinners.map((w) => w.caption)).toEqual(["2024: Sprout Squad", "2023: The Baubles"]);
    expect(runAction(s, HOST, "prize.winner.remove", { id: w1.id }, T0).deleteImages).toEqual(["winners2023"]);
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.prize.pastWinners).toHaveLength(1);
    expect(s.prize.trophyImageId).toBe("trophy222");
  });

  it("puts the grand prize moment and the hall of fame on the TV once there's something to show", () => {
    const s = setup(2);
    expect(() => runAction(s, HOST, "stage.show", { screen: "prize" }, T0)).toThrow(/trophy/);
    expect(() => runAction(s, HOST, "stage.show", { screen: "gallery" }, T0)).toThrow(/past winners/);
    runAction(s, HOST, "prize.trophy", { imageId: "trophy111" }, T0);
    runAction(s, HOST, "prize.winner.add", { imageId: "winners2024" }, T0);
    runAction(s, HOST, "stage.show", { screen: "prize" }, T0);
    expect(stageView(s, T0).stage.screen).toBe("prize");
    runAction(s, HOST, "stage.show", { screen: "gallery" }, T0);
    expect(stageView(s, T0).stage.screen).toBe("gallery");
  });
});

describe("videos", () => {
  const MB = 1024 * 1024;
  function withClip(s: ServerState, id = "vid1", durationMs: number | null = 20_000) {
    registerVideo(s, { id, name: "  Intro   clip ", size: 10 * MB, type: "video/mp4", durationMs, createdAt: T0 });
    return id;
  }

  it("checks uploads against the size limits", () => {
    const s = setup(1);
    expect(() => checkVideoUpload(s, 10 * MB, "video/avi")).toThrow(/MP4/);
    expect(() => checkVideoUpload(s, 81 * MB, "video/mp4")).toThrow(/up to 80 MB/);
    expect(() => checkVideoUpload(s, 0, "video/mp4")).toThrow(/empty/);
    checkVideoUpload(s, 80 * MB, "video/mp4");
    for (let i = 0; i < 12; i++) registerVideo(s, { id: `v${i}`, name: "x", size: 80 * MB, type: "video/mp4", durationMs: null, createdAt: T0 });
    expect(() => checkVideoUpload(s, 80 * MB, "video/mp4")).toThrow(/1024 MB/);
  });

  it("plays an activity's clip first when it goes on the TV, and stops when the screen changes", () => {
    const s = setup(2);
    drawTeams(s);
    const vid = withClip(s);
    expect(hostView(s, [], T0).videos[0].name).toBe("Intro clip");
    const { id } = runAction(s, HOST, "activity.create", { name: "Charades", kind: "team", scoring: "judged" }, T0).data as { id: string };
    runAction(s, HOST, "activity.video", { activityId: id, videoId: vid }, T0);
    runAction(s, HOST, "stage.show", { screen: "activity", activityId: id }, T0 + 100);
    expect(stageView(s, T0).video).toMatchObject({ videoId: vid, activityId: id, playing: true, positionMs: 0, since: T0 + 100 });
    runAction(s, HOST, "stage.show", { screen: "teams" }, T0 + 200);
    expect(stageView(s, T0).video).toBeNull();
  });

  it("pauses, resumes, restarts and skips, keeping the TV in step", () => {
    const s = setup(1);
    const vid = withClip(s);
    expect(() => runAction(s, HOST, "video.pause", {}, T0)).toThrow(/Nothing/);
    runAction(s, HOST, "video.play", { videoId: vid }, T0);
    const seq = s.video!.seq;
    runAction(s, HOST, "video.pause", {}, T0 + 4000);
    expect(s.video).toMatchObject({ playing: false, positionMs: 4000 });
    runAction(s, HOST, "video.resume", {}, T0 + 9000);
    expect(s.video).toMatchObject({ playing: true, positionMs: 4000, since: T0 + 9000 });
    // It ends itself once the clip has run: 16 more seconds, plus a moment.
    expect(nextAlarmAt(s)).toBe(T0 + 9000 + 16_000 + 1000);
    expect(onAlarm(s, T0 + 20_000)).toBe(false);
    expect(onAlarm(s, T0 + 26_000)).toBe(true);
    expect(s.video).toBeNull();
    runAction(s, HOST, "video.play", { videoId: vid }, T0 + 30_000);
    runAction(s, HOST, "video.restart", {}, T0 + 31_000);
    expect(s.video!.seq).toBeGreaterThan(seq);
    runAction(s, HOST, "video.skip", {}, T0 + 32_000);
    expect(s.video).toBeNull();
  });

  it("starts a quiz's or poll's clip only when it first goes on the TV", () => {
    const s = setup(2);
    drawTeams(s);
    const vid = withClip(s, "vid1", null);
    const { id } = runAction(s, HOST, "activity.create", { name: "Quiz", format: "quiz", kind: "team" }, T0).data as { id: string };
    runAction(s, HOST, "quiz.question.save", { activityId: id, question: { type: "truefalse", prompt: "Snow is cold", correctIndex: 0 } }, T0);
    runAction(s, HOST, "activity.video", { activityId: id, videoId: vid }, T0);
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    expect(s.video?.videoId).toBe(vid);
    // No duration known: no alarm; the host skips it.
    expect(nextAlarmAt(s)).toBeNull();
    runAction(s, HOST, "video.skip", {}, T0);
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    expect(s.video).toBeNull();
  });

  it("deletes a clip everywhere it's used", () => {
    const s = setup(1);
    const vid = withClip(s);
    const { id } = runAction(s, HOST, "activity.create", { name: "Game", kind: "team", scoring: "judged" }, T0).data as { id: string };
    runAction(s, HOST, "activity.video", { activityId: id, videoId: vid }, T0);
    runAction(s, HOST, "video.play", { videoId: vid }, T0);
    const r = runAction(s, HOST, "video.delete", { id: vid }, T0);
    expect(r.deleteVideos).toEqual([vid]);
    expect(s.video).toBeNull();
    expect(s.activities[0].videoId).toBeNull();
    expect(() => runAction(s, HOST, "activity.video", { activityId: id, videoId: vid }, T0)).toThrow(/no longer exists/);
  });
});

describe("the House", () => {
  function houseRound(s: ServerState, opts: Record<string, unknown> = {}) {
    const { id } = runAction(s, HOST, "activity.create", { name: "Paper planes", kind: "team", scoring: "judged" }, T0).data as { id: string };
    runAction(s, HOST, "house.settings", { activityId: id, enabled: true, direction: "high", teamPoints: 4, housePoints: 6, ...opts }, T0);
    return id;
  }

  it("locks in a secret score that never reaches the TV or phones before the face-off", () => {
    const s = setup(6);
    drawTeams(s);
    const id = houseRound(s);
    runAction(s, HOST, "house.score", { activityId: id, score: 987654 }, T0);
    expect(() => runAction(s, HOST, "house.score", { activityId: id, score: 1 }, T0)).toThrow(/locked/);
    expect(() => runAction(s, HOST, "house.settings", { activityId: id, enabled: true, direction: "low" }, T0)).toThrow(/locked/);
    expect(publicJson(s)).not.toContain("987654");
    expect(stageView(s, T0).activities.find((a) => a.id === id)).toBeUndefined();
    expect(hostView(s, [], T0).house[id].houseScore).toBe(987654);
    expect(hostView(s, [], T0).activities.find((a) => a.id === id)!.house).toMatchObject({ locked: true, settled: false });
  });

  it("pays every team that beats the House, and the House wins ties", () => {
    const s = setup(6);
    drawTeams(s);
    const id = houseRound(s);
    const [t1, t2, t3] = s.teams;
    runAction(s, HOST, "house.score", { activityId: id, score: 10 }, T0);
    runAction(s, HOST, "house.teamScore", { activityId: id, teamId: t1.id, score: 12 }, T0);
    runAction(s, HOST, "house.teamScore", { activityId: id, teamId: t2.id, score: 10 }, T0);
    runAction(s, HOST, "house.teamScore", { activityId: id, teamId: t3.id, score: 3 }, T0);
    runAction(s, HOST, "house.reveal", { activityId: id }, T0);
    const r = stageView(s, T0).houseReveal!;
    expect(r).toMatchObject({ houseScore: 10, houseWins: false });
    expect(r.rows.map((x) => [x.teamId, x.beat])).toEqual([[t1.id, true], [t2.id, false], [t3.id, false]]);
    const live = hostView(s, [], T0).liveTotals;
    expect([live[t1.id], live[t2.id], live[t3.id]]).toEqual([4, 0, 0]);
    expect(hostView(s, [], T0).liveHouseTotal).toBe(0);
  });

  it("takes the points when nobody beats it, and sits on the leaderboard without ever winning", () => {
    const s = setup(4);
    drawTeams(s);
    const id = houseRound(s, { direction: "low" });
    const [t1, t2] = s.teams;
    runAction(s, HOST, "house.score", { activityId: id, score: 30 }, T0);
    runAction(s, HOST, "house.teamScore", { activityId: id, teamId: t1.id, score: 31 }, T0);
    runAction(s, HOST, "house.teamScore", { activityId: id, teamId: t2.id, score: 30 }, T0);
    runAction(s, HOST, "house.reveal", { activityId: id }, T0);
    expect(stageView(s, T0).houseReveal!.houseWins).toBe(true);
    expect(hostView(s, [], T0).liveHouseTotal).toBe(6);
    // Hidden until the next reveal, then on the board, never a winner.
    expect(stageView(s, T0).standings).toBeNull();
    runAction(s, HOST, "score.adjust", { teamId: t1.id, points: 2, reason: "Style" }, T0);
    runAction(s, HOST, "standings.final", {}, T0 + 1);
    const st = stageView(s, T0).standings!;
    expect(st.house).toEqual({ points: 6, prevPoints: null });
    expect(st.rows[0]).toMatchObject({ teamId: t1.id, rank: 1, points: 2 });
    expect(st.rows.some((r) => r.teamId === "house")).toBe(false);
  });

  it("settles quiz rounds on the points each team earned, and re-settling voids the old points", () => {
    const s = setup(4);
    drawTeams(s);
    const { id } = runAction(s, HOST, "activity.create", { name: "Quiz", format: "quiz", kind: "team", perCorrect: 1 }, T0).data as { id: string };
    runAction(s, HOST, "house.settings", { activityId: id, enabled: true, direction: "high", teamPoints: 3, housePoints: 3 }, T0);
    runAction(s, HOST, "quiz.question.save", { activityId: id, question: { type: "truefalse", prompt: "Snow is cold", correctIndex: 0 } }, T0);
    runAction(s, HOST, "house.score", { activityId: id, score: 0 }, T0);
    expect(() => runAction(s, HOST, "house.teamScore", { activityId: id, teamId: s.teams[0].id, score: 1 }, T0)).toThrow(/points earned/);
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    const t1 = s.teams[0];
    runAction(s, { role: "player", playerId: t1.memberIds[0] }, "quiz.answer", { questionId: s.activities[0].questions![0].id, value: 0 }, T0 + 1);
    runAction(s, HOST, "quiz.reveal", {}, T0 + 2);
    runAction(s, HOST, "house.reveal", { activityId: id }, T0 + 3);
    expect(stageView(s, T0).houseReveal!.rows.find((r) => r.teamId === t1.id)).toMatchObject({ score: 1, beat: true });
    runAction(s, HOST, "house.reveal", { activityId: id }, T0 + 4);
    expect(s.ledger.filter((e) => e.reason === "Beat the House" && !e.voided)).toHaveLength(1);
    expect(s.ledger.filter((e) => e.reason === "Beat the House" && e.voided)).toHaveLength(1);
  });

  it("forgets rehearsal House scores when starting fresh, but keeps the settings", () => {
    const s = setup(2);
    const id = houseRound(s);
    runAction(s, HOST, "house.score", { activityId: id, score: 5 }, T0);
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.activities[0].house).toMatchObject({ houseScore: null, teamPoints: 4, settled: false });
  });
});

describe("Friendsmas memories", () => {
  it("keeps a slideshow of past photos for the TV, and deletes pictures that are removed", () => {
    const s = setup(1);
    runAction(s, HOST, "memories.add", { imageId: "memory0001", caption: "2024 in the pool" }, T0);
    runAction(s, HOST, "memories.add", { imageId: "memory0002" }, T0);
    const [a, b] = s.memories;
    runAction(s, HOST, "memories.move", { id: b.id, direction: "up" }, T0);
    runAction(s, HOST, "memories.update", { id: b.id, caption: "Pavlova disaster, 2025" }, T0);
    expect(stageView(s, T0).memories.map((m) => m.caption)).toEqual(["Pavlova disaster, 2025", "2024 in the pool"]);
    expect(runAction(s, HOST, "memories.remove", { id: a.id }, T0).deleteImages).toEqual(["memory0001"]);
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.memories).toHaveLength(1);
  });
});

describe("starting fresh after the guest link has gone out", () => {
  it("keeps real guests, their answers and photos, and everything the host made, while clearing teams and points", () => {
    const s = setup(4);
    runAction(s, as(s, 0), "player.answers", answers("Trifle", "dessert"), T0);
    s.players[0].photo = 3;
    runAction(s, HOST, "guest.addTest", { count: 2 }, T0);
    runAction(s, HOST, "agenda.save", { items: [{ time: "12:00", item: "Arrivals" }] }, T0);
    runAction(s, HOST, "memories.add", { imageId: "memory0001" }, T0);
    const { id } = runAction(s, HOST, "activity.create", { name: "Sole Mates", kind: "individual", scoring: "perCorrect", perCorrect: 1 }, T0).data as { id: string };
    drawTeams(s);
    expect(id).toBeTruthy();
    runAction(s, HOST, "score.adjust", { teamId: s.players[0].teamId, points: 2, reason: "Sole Mates" }, T0);
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.players.map((p) => p.name)).toEqual(["Guest 1", "Guest 2", "Guest 3", "Guest 4"]);
    expect(s.players[0]).toMatchObject({ photo: 3, teamId: null, status: "joined" });
    expect(s.players[0].answers!.dish).toBe("Trifle");
    expect(s.players[0].token).toBeTruthy();
    expect(s.teams).toEqual([]);
    expect(s.ledger).toEqual([]);
    expect(s.activities.map((a) => a.name)).toEqual(["Sole Mates"]);
    expect(s.agenda).toHaveLength(1);
    expect(s.memories).toHaveLength(1);
    // Ticking "also remove every guest" is the only way the guests go.
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH", clearGuests: true }, T0);
    expect(s.players).toEqual([]);
  });
});
