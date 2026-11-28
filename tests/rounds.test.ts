// The run sheet: four quiz rounds and three Beat the House rounds, the
// question types inside a round, and the House scoring in quiz rounds.

import { describe, expect, it } from "vitest";
import { FINAL_REVEAL_MS, HOUSE_ID, SPIN_MS } from "../shared/types";
import { runAction, type Actor } from "../worker/logic";
import { registerVideo } from "../worker/show";
import { freshState, migrate, type ServerState } from "../worker/state";
import { hostView, playerView, stageView } from "../worker/views";

const HOST: Actor = { role: "host", playerId: null };
const T0 = 1_700_000_000_000;
const player = (id: string): Actor => ({ role: "player", playerId: id });

/** Six guests in three teams of two, with the run sheet made. */
function ready(): ServerState {
  const s = freshState(T0);
  runAction(s, HOST, "guest.add", { names: ["Ava", "Ben", "Cleo", "Dev", "Eli", "Fran"].join("\n") }, T0);
  for (const p of s.players) runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: p.id, emoji: "🎅" }, T0);
  migrate(s);
  runAction(s, HOST, "draw.lock", {}, T0);
  let now = T0 + 1000;
  while (s.draw.phase !== "complete") {
    runAction(s, HOST, "draw.spin", { expectedStep: s.draw.step }, now);
    now += SPIN_MS + FINAL_REVEAL_MS;
  }
  return s;
}

const round = (s: ServerState, n: number) => s.runSheet![[0, 2, 4, 6][n - 1]];
const houseSlot = (s: ServerState, n: number) => s.runSheet![[1, 3, 5][n - 1]];

function addQ(s: ServerState, activityId: string, question: Record<string, unknown>): string {
  const r = runAction(s, HOST, "quiz.question.save", { activityId, question }, T0);
  return (r.data as { questionId: string }).questionId;
}

/** Opens question `index`, lets each team answer, and reveals it. */
function play(s: ServerState, activityId: string, index: number, byTeam: Record<string, unknown>, now = T0) {
  runAction(s, HOST, "quiz.start", { activityId }, now);
  runAction(s, HOST, "quiz.open", { index }, now);
  const qid = stageView(s, now).quiz!.question!.id;
  for (const [teamId, value] of Object.entries(byTeam)) {
    const member = s.teams.find((t) => t.id === teamId)!.memberIds[0];
    runAction(s, player(member), "quiz.answer", { questionId: qid, value }, now + 10);
  }
  runAction(s, HOST, "quiz.reveal", {}, now + 20);
  return qid;
}

const roundPoints = (s: ServerState, activityId: string, teamId: string) =>
  s.ledger.filter((e) => !e.voided && e.activityId === activityId && e.teamId === teamId).reduce((n, e) => n + e.points, 0);

describe("the run sheet", () => {
  it("lays out four quiz rounds with a Beat the House round between each", () => {
    const s = ready();
    const sheet = hostView(s, [], T0).runSheet.map((id) => s.activities.find((a) => a.id === id)!);
    expect(sheet.map((a) => a.name)).toEqual(["Round 1", "Beat the House 1", "Round 2", "Beat the House 2", "Round 3", "Beat the House 3", "Round 4"]);
    expect(sheet.map((a) => a.format)).toEqual(["quiz", "live", "quiz", "live", "quiz", "live", "quiz"]);
    expect(sheet.filter((a) => a.house).length).toBe(3);
    expect(sheet.every((a) => a.kind === "team")).toBe(true);
    // Made once: loading again doesn't add more.
    migrate(s);
    expect(s.runSheet).toHaveLength(7);
    expect(s.activities).toHaveLength(7);
  });

  it("keeps each slot's type: rename it, but never remove it or stop playing the House", () => {
    const s = ready();
    const h1 = houseSlot(s, 1);
    expect(() => runAction(s, HOST, "activity.delete", { id: round(s, 1) }, T0)).toThrow(/running order/);
    expect(() => runAction(s, HOST, "house.settings", { activityId: h1, enabled: false }, T0)).toThrow(/always plays against the House/);
    runAction(s, HOST, "activity.update", { id: h1, name: "Frisbee", format: "quiz", kind: "individual", scoring: "placement" }, T0);
    const a = s.activities.find((x) => x.id === h1)!;
    expect(a).toMatchObject({ name: "Frisbee", format: "live", kind: "team" });
    expect(a.house).not.toBeNull();
  });
});

describe("question types in a round", () => {
  it("scores a poll for every team that voted with the majority", () => {
    const s = ready();
    const r1 = round(s, 1);
    const [t1, t2, t3] = s.teams;
    addQ(s, r1, { type: "poll", prompt: "Best Christmas film?", optionsKind: "custom", options: ["Elf", "Home Alone", "Die Hard"], points: 2 });
    play(s, r1, 0, { [t1.id]: "1", [t2.id]: "1", [t3.id]: "0" });
    const reveal = stageView(s, T0).quiz!.reveal!;
    expect(reveal.answer).toBe("Home Alone");
    expect(reveal.counts).toEqual({ "1": 2, "0": 1 });
    expect(roundPoints(s, r1, t1.id)).toBe(2);
    expect(roundPoints(s, r1, t2.id)).toBe(2);
    expect(roundPoints(s, r1, t3.id)).toBe(0);
  });

  it("won't let a team vote for itself in a teams poll", () => {
    const s = ready();
    const r1 = round(s, 1);
    const [t1, t2] = s.teams;
    addQ(s, r1, { type: "poll", prompt: "Best dressed team?", optionsKind: "teams" });
    runAction(s, HOST, "quiz.start", { activityId: r1 }, T0);
    runAction(s, HOST, "quiz.open", { index: 0 }, T0);
    const live = stageView(s, T0).quiz!.question!;
    expect(live.choices!.map((c) => c.key)).toEqual(s.teams.map((t) => t.id));
    expect(() => runAction(s, player(t1.memberIds[0]), "quiz.answer", { questionId: live.id, value: t1.id }, T0)).toThrow(/own team/);
    runAction(s, player(t1.memberIds[0]), "quiz.answer", { questionId: live.id, value: t2.id }, T0);
  });

  it("asks who wrote a secret fact: right guesses score, and the writer's team can't", () => {
    const s = ready();
    const writer = s.players[0];
    runAction(s, player(writer.id), "player.answers", { dish: "Trifle", category: "dessert", dietary: "", facts: ["I once met a famous goat"] }, T0);
    const factId = writer.answers!.facts[0].id;
    const r1 = round(s, 1);
    addQ(s, r1, { type: "whowrote", factId, points: 3 });
    const mine = s.teams.find((t) => t.memberIds.includes(writer.id))!;
    const others = s.teams.filter((t) => t !== mine);
    runAction(s, HOST, "quiz.start", { activityId: r1 }, T0);
    runAction(s, HOST, "quiz.open", { index: 0 }, T0);
    const live = stageView(s, T0).quiz!.question!;
    expect(live.prompt).toBe("I once met a famous goat");
    expect(playerView(s, writer.id, T0).myFactOnTv).toBe(true);
    const qid = live.id;
    runAction(s, player(mine.memberIds.find((id) => id !== writer.id)!), "quiz.answer", { questionId: qid, value: writer.id }, T0);
    runAction(s, player(others[0].memberIds[0]), "quiz.answer", { questionId: qid, value: writer.id }, T0);
    runAction(s, player(others[1].memberIds[0]), "quiz.answer", { questionId: qid, value: others[1].memberIds[0] }, T0);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    expect(stageView(s, T0).quiz!.reveal!.writerId).toBe(writer.id);
    expect(roundPoints(s, r1, others[0].id)).toBe(3);
    expect(roundPoints(s, r1, others[1].id)).toBe(0);
    expect(roundPoints(s, r1, mine.id)).toBe(0);
  });

  it("plays a question's clip when it opens, and gives the answers time after it", () => {
    const s = ready();
    const r1 = round(s, 1);
    registerVideo(s, { id: "clip", name: "Frisbee throw", size: 1000, type: "video/mp4", durationMs: 8000, createdAt: T0 });
    addQ(s, r1, { type: "number", prompt: "How far did it go (m)?", numberAnswer: 23, videoId: "clip", seconds: 20 });
    runAction(s, HOST, "quiz.start", { activityId: r1 }, T0);
    runAction(s, HOST, "quiz.open", { index: 0 }, T0 + 100);
    expect(s.video).toMatchObject({ videoId: "clip", activityId: r1, playing: true });
    expect(s.quiz.endsAt).toBe(T0 + 100 + 8000 + 20_000);
    expect(hostView(s, [], T0).questions[r1][0].videoId).toBe("clip");
    runAction(s, HOST, "video.delete", { id: "clip" }, T0 + 200);
    expect(hostView(s, [], T0).questions[r1][0].videoId).toBeNull();
  });
});

describe("face mash", () => {
  function mash(s: ServerState, extra: Record<string, unknown> = {}) {
    const r1 = round(s, 1);
    addQ(s, r1, { type: "facemash", prompt: "Who's in the mash?", pickNames: ["Jack", "fleur", "Ned"], accepted: [], points: 1, bonus: 2, ...extra });
    runAction(s, HOST, "quiz.start", { activityId: r1 }, T0);
    runAction(s, HOST, "quiz.open", { index: 0 }, T0);
    return { r1, qid: stageView(s, T0).quiz!.question!.id };
  }

  it("ticks names from the list in any order: a point each, plus a bonus for all of them", () => {
    const s = ready();
    const { r1, qid } = mash(s);
    const [t1, t2, t3] = s.teams;
    const live = stageView(s, T0).quiz!.question!.mash!;
    expect(live).toMatchObject({ guests: 3, celebrity: false });
    expect(live.names).toContain("Tallulah");
    const answer = (t: (typeof s.teams)[number], guests: string[]) =>
      runAction(s, player(t.memberIds[0]), "quiz.answer", { questionId: qid, value: { guests, celebrity: "" } }, T0);
    answer(t1, ["Ned", "Fleur", "Jack"]); // all three, another order
    answer(t2, ["jack", "Amy"]); // one right (any case)
    answer(t3, ["Izzy", "Pat", "Amber"]);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    expect(roundPoints(s, r1, t1.id)).toBe(1 + 1 + 1 + 2);
    expect(roundPoints(s, r1, t2.id)).toBe(1);
    expect(roundPoints(s, r1, t3.id)).toBe(0);
    const reveal = stageView(s, T0).quiz!.reveal!;
    expect(reveal.pickNames).toEqual(["Jack", "Fleur", "Ned"]);
    expect(reveal.answer).toBe("Jack + Fleur + Ned");
  });

  it("only takes names from the list, no more than the mash has, and the host can change the list", () => {
    const s = ready();
    const { qid } = mash(s);
    const me = player(s.teams[0].memberIds[0]);
    const send = (guests: string[]) => runAction(s, me, "quiz.answer", { questionId: qid, value: { guests, celebrity: "" } }, T0);
    expect(() => send(["Santa"])).toThrow(/from the list/);
    expect(() => send(["Jack", "Fleur", "Ned", "Amy"])).toThrow(/up to 3/);
    expect(() => send([])).toThrow(/Pick/);
    runAction(s, HOST, "quiz.mashNames", { names: ["Jack", "Fleur", "Ned", "Rudolph", " jack "] }, T0);
    expect(hostView(s, [], T0).mashNames).toEqual(["Jack", "Fleur", "Ned", "Rudolph"]);
    expect(() => addQ(s, round(s, 2), { type: "facemash", pickNames: ["Amy"] })).toThrow(/names list/);
  });

  it("turns face mashes saved the old way (guest ids) into names", () => {
    const s = ready();
    const r1 = s.activities.find((a) => a.id === round(s, 1))!;
    const [a, b] = s.players;
    r1.questions!.push({ id: "old", type: "facemash", prompt: "Old", options: [], correctIndex: 0, numberAnswer: null, accepted: [], imageId: null, points: null, seconds: null, notes: "", fact: "", pickIds: [a.id, b.id] } as never);
    migrate(s);
    expect(r1.questions![0].pickNames).toEqual([a.name, b.name]);
    expect((r1.questions![0] as { pickIds?: unknown }).pickIds).toBeUndefined();
  });

  it("can still include a celebrity, with near misses for the host to check", () => {
    const s = ready();
    const { r1, qid } = mash(s, { pickNames: ["Jack"], accepted: ["Ed Sheeran"] });
    const t1 = s.teams[0];
    runAction(s, player(t1.memberIds[0]), "quiz.answer", { questionId: qid, value: { guests: ["Jack"], celebrity: "Ed Sheran" } }, T0);
    runAction(s, HOST, "quiz.close", {}, T0);
    expect(hostView(s, [], T0).quizAnswers[0].auto).toBe("close");
    runAction(s, HOST, "quiz.reveal", {}, T0);
    expect(roundPoints(s, r1, t1.id)).toBe(1);
    runAction(s, HOST, "quiz.mark", { answererId: t1.id, correct: true }, T0);
    expect(roundPoints(s, r1, t1.id)).toBe(1 + 1 + 2);
  });
});

describe("the House in quiz rounds", () => {
  it("scores the same as the lowest team, and keeps up when marks change", () => {
    const s = ready();
    const r1 = round(s, 1);
    const [t1, t2, t3] = s.teams;
    addQ(s, r1, { type: "choice", prompt: "Q1", options: ["A", "B"], correctIndex: 0, points: 2 });
    addQ(s, r1, { type: "choice", prompt: "Q2", options: ["A", "B"], correctIndex: 0, points: 2 });
    const house = () => roundPoints(s, r1, HOUSE_ID);
    play(s, r1, 0, { [t1.id]: 0, [t2.id]: 0, [t3.id]: 1 });
    // t3 has nothing yet, so neither does the House.
    expect(house()).toBe(0);
    runAction(s, HOST, "quiz.open", {}, T0 + 100);
    const q2 = stageView(s, T0).quiz!.question!.id;
    for (const t of [t1, t2, t3]) runAction(s, player(t.memberIds[0]), "quiz.answer", { questionId: q2, value: 0 }, T0 + 110);
    runAction(s, HOST, "quiz.reveal", {}, T0 + 120);
    // t1 4, t2 4, t3 2: the House matches t3.
    expect(house()).toBe(2);
    // The host marks t3's second answer wrong: t3 has nothing, so the House drops to 0.
    runAction(s, HOST, "quiz.mark", { answererId: t3.id, correct: false }, T0 + 200);
    expect(house()).toBe(0);
    // And back again.
    runAction(s, HOST, "quiz.mark", { answererId: t3.id, correct: null }, T0 + 210);
    expect(house()).toBe(2);
    // Old House entries are voided, never deleted.
    expect(s.ledger.filter((e) => e.teamId === HOUSE_ID && e.voided).length).toBeGreaterThan(0);
  });

  it("puts the round's House score on the results screen and the leaderboard", () => {
    const s = ready();
    const r1 = round(s, 1);
    const [t1, t2, t3] = s.teams;
    addQ(s, r1, { type: "truefalse", prompt: "Snow is cold", correctIndex: 0, points: 5 });
    play(s, r1, 0, { [t1.id]: 0, [t2.id]: 0, [t3.id]: 0 });
    runAction(s, HOST, "results.show", { activityId: r1 }, T0 + 50);
    expect(stageView(s, T0).results!.house).toBe(5);
    runAction(s, HOST, "standings.reveal", {}, T0 + 60);
    const st = stageView(s, T0).standings!;
    // Everyone on 5, the House on 5: the House wins the tie.
    expect(st.house).toMatchObject({ points: 5, rank: 1 });
    expect(st.rows.every((r) => r.rank === 2)).toBe(true);
  });
});
