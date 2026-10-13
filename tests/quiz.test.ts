import { describe, expect, it } from "vitest";
import { FINAL_REVEAL_MS, SPIN_MS } from "../shared/types";
import { nextAlarmAt, onAlarm, runAction, type Actor } from "../worker/logic";
import { autoMark, normalise, parseImport } from "../worker/quiz";
import { freshState, type Question, type ServerState } from "../worker/state";
import { hostView, playerView, stageView } from "../worker/views";

const HOST: Actor = { role: "host", playerId: null };
const T0 = 1_700_000_000_000;

function ready(n = 6): ServerState {
  const s = freshState(T0);
  runAction(s, HOST, "guest.add", { names: Array.from({ length: n }, (_, i) => `Guest ${i + 1}`).join("\n") }, T0);
  for (const p of s.players) runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: p.id, emoji: "🎅" }, T0);
  runAction(s, HOST, "draw.lock", {}, T0);
  let now = T0 + 1000;
  while (s.draw.phase !== "complete") {
    runAction(s, HOST, "draw.spin", { expectedStep: s.draw.step }, now);
    now += SPIN_MS + FINAL_REVEAL_MS;
  }
  return s;
}

function quiz(s: ServerState, fields: Record<string, unknown> = {}): string {
  const r = runAction(s, HOST, "activity.create", { name: "Round 1", format: "quiz", kind: "team", perCorrect: 2, questionSeconds: 20, ...fields }, T0);
  return (r.data as { id: string }).id;
}

function addQ(s: ServerState, activityId: string, question: Record<string, unknown>): string {
  const r = runAction(s, HOST, "quiz.question.save", { activityId, question }, T0);
  return (r.data as { questionId: string }).questionId;
}

const player = (id: string): Actor => ({ role: "player", playerId: id });

describe("marking", () => {
  const text = (accepted: string[]) => ({ type: "text", accepted }) as unknown as Question;
  it("ignores case, punctuation and a leading 'the'", () => {
    expect(normalise("  The Grinch!  ")).toBe("grinch");
    expect(autoMark(text(["The Grinch"]), "grinch", null)).toBe("correct");
    expect(autoMark(text(["Rudolph"]), "rudolf", null)).toBe("close");
    expect(autoMark(text(["Rudolph"]), "Blitzen", null)).toBe("wrong");
    expect(autoMark(text(["Love Actually", "Love, Actually"]), "loveactually", null)).toBe("correct");
  });
});

describe("importing from a spreadsheet", () => {
  it("reads tab-separated rows and works out the type", () => {
    const rows = [
      "Type\tQuestion\tAnswer\tWrong 1\tWrong 2",
      "\tWhich is a reindeer?\tComet\tRupert\tGerald",
      "\tTinsel was first made of real silver\tTrue",
      "number\tHow many ghosts visit Scrooge?\t4",
      "\tWho stole Christmas?\tThe Grinch | Grinch",
    ].join("\n");
    const { questions, errors } = parseImport(rows);
    expect(errors).toEqual([]);
    expect(questions.map((q) => q.type)).toEqual(["choice", "truefalse", "number", "text"]);
    expect(questions[0].options[questions[0].correctIndex]).toBe("Comet");
    expect(questions[1].correctIndex).toBe(0);
    expect(questions[2].numberAnswer).toBe(4);
    expect(questions[3].accepted).toEqual(["The Grinch", "Grinch"]);
  });

  it("reads CSV with quotes, and reports bad rows", () => {
    const { questions } = parseImport('choice,"Pick one, please",Yes,No\n');
    expect(questions[0].prompt).toBe("Pick one, please");
    const bad = parseImport("truefalse,Is it?,Maybe");
    expect(bad.errors[0]).toMatch(/Row 1/);
  });
});

describe("running a quiz", () => {
  it("never sends the answer before it's revealed", () => {
    const s = ready();
    const id = quiz(s);
    addQ(s, id, { type: "choice", prompt: "Pick B", options: ["A", "B", "C"], correctIndex: 1, notes: "secret note" });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    for (const v of [stageView(s, T0), playerView(s, s.teams[0].memberIds[0], T0)]) {
      const json = JSON.stringify(v);
      expect(json).not.toContain("secret note");
      expect(json).not.toContain("correctIndex");
      expect(v.quiz!.reveal).toBeNull();
      expect(v.quiz!.question!.prompt).toBe("Pick B");
    }
    expect(hostView(s, [], T0).questions[id][0].correctIndex).toBe(1);
  });

  it("takes one shared answer per team, scores it at the reveal, and keeps it hidden until the results", () => {
    const s = ready();
    const id = quiz(s);
    const qid = addQ(s, id, { type: "choice", prompt: "Pick B", options: ["A", "B", "C"], correctIndex: 1 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    const [t1, t2] = s.teams;
    runAction(s, player(t1.memberIds[0]), "quiz.answer", { questionId: qid, value: 0 }, T0 + 1000);
    runAction(s, player(t1.memberIds[1]), "quiz.answer", { questionId: qid, value: 1 }, T0 + 2000);
    runAction(s, player(t2.memberIds[0]), "quiz.answer", { questionId: qid, value: 2 }, T0 + 3000);
    // Partners see the team's answer.
    expect(playerView(s, t1.memberIds[0], T0).myQuizAnswer).toEqual({ value: "1", byPlayerId: t1.memberIds[1] });
    expect(stageView(s, T0).quiz!.answeredIds.sort()).toEqual([t1.id, t2.id].sort());

    runAction(s, HOST, "quiz.reveal", {}, T0 + 4000);
    const reveal = stageView(s, T0).quiz!.reveal!;
    expect(reveal.answer).toBe("B: B");
    expect(reveal.results.find((r) => r.answererId === t1.id)).toMatchObject({ correct: true, points: 2 });
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(2);
    expect(stageView(s, T0).standings).toBeNull();

    runAction(s, HOST, "results.show", { activityId: id }, T0);
    expect(stageView(s, T0).results!.rows[0]).toMatchObject({ teamId: t1.id, points: 2 });
  });

  it("closes itself when time runs out, and refuses late answers", () => {
    const s = ready();
    const id = quiz(s);
    const qid = addQ(s, id, { type: "truefalse", prompt: "True?", correctIndex: 0, seconds: 10 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    expect(nextAlarmAt(s)).toBe(T0 + 10_000);
    expect(() => runAction(s, player(s.teams[0].memberIds[0]), "quiz.answer", { questionId: qid, value: 0 }, T0 + 11_000)).toThrow(/Time's up/);
    expect(onAlarm(s, T0 + 10_000)).toBe(true);
    expect(s.quiz.phase).toBe("closed");
    expect(nextAlarmAt(s)).toBeNull();
  });

  it("gives closest-number points to every team tied for closest", () => {
    const s = ready();
    const id = quiz(s);
    const qid = addQ(s, id, { type: "number", prompt: "How many?", numberAnswer: 100 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    const [t1, t2, t3] = s.teams;
    runAction(s, player(t1.memberIds[0]), "quiz.answer", { questionId: qid, value: "90" }, T0);
    runAction(s, player(t2.memberIds[0]), "quiz.answer", { questionId: qid, value: "110" }, T0);
    runAction(s, player(t3.memberIds[0]), "quiz.answer", { questionId: qid, value: "1,000" }, T0);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    const totals = hostView(s, [], T0).liveTotals;
    expect([totals[t1.id], totals[t2.id], totals[t3.id]]).toEqual([2, 2, 0]);
  });

  it("flags near misses for the host, who can mark them right after the reveal", () => {
    const s = ready();
    const id = quiz(s);
    const qid = addQ(s, id, { type: "text", prompt: "Red-nosed?", accepted: ["Rudolph"] });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    const t1 = s.teams[0];
    runAction(s, player(t1.memberIds[0]), "quiz.answer", { questionId: qid, value: "Rudolf" }, T0);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    expect(hostView(s, [], T0).quizAnswers[0]).toMatchObject({ auto: "close", correct: false });
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(0);
    runAction(s, HOST, "quiz.mark", { answererId: t1.id, correct: true }, T0);
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(2);
    runAction(s, HOST, "quiz.mark", { answererId: t1.id, correct: null }, T0);
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(0);
  });

  it("credits guests in individual quizzes, with a speed bonus for the fastest", () => {
    const s = ready();
    const id = quiz(s, { kind: "individual", perCorrect: 1, speedBonus: 1 });
    const qid = addQ(s, id, { type: "truefalse", prompt: "True?", correctIndex: 0 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    const [a, b] = s.teams[0].memberIds;
    runAction(s, player(b), "quiz.answer", { questionId: qid, value: 0 }, T0 + 500);
    runAction(s, player(a), "quiz.answer", { questionId: qid, value: 0 }, T0 + 900);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    const live = s.ledger.filter((e) => !e.voided);
    expect(live.filter((e) => e.playerId === b).reduce((n, e) => n + e.points, 0)).toBe(2);
    expect(live.filter((e) => e.playerId === a).reduce((n, e) => n + e.points, 0)).toBe(1);
    expect(hostView(s, [], T0).liveTotals[s.teams[0].id]).toBe(3);
  });

  it("moves through the questions and stops after the last", () => {
    const s = ready();
    const id = quiz(s);
    addQ(s, id, { type: "truefalse", prompt: "One", correctIndex: 0 });
    addQ(s, id, { type: "truefalse", prompt: "Two", correctIndex: 1 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    expect(() => runAction(s, HOST, "quiz.open", {}, T0)).toThrow(/Close/);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    expect(stageView(s, T0).quiz!.question!.prompt).toBe("Two");
    runAction(s, HOST, "quiz.reveal", {}, T0);
    expect(() => runAction(s, HOST, "quiz.open", {}, T0)).toThrow(/last question/);
  });

  it("replays a question from scratch", () => {
    const s = ready();
    const id = quiz(s);
    const qid = addQ(s, id, { type: "truefalse", prompt: "One", correctIndex: 0 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    runAction(s, player(s.teams[0].memberIds[0]), "quiz.answer", { questionId: qid, value: 0 }, T0);
    runAction(s, HOST, "quiz.reveal", {}, T0);
    expect(hostView(s, [], T0).liveTotals[s.teams[0].id]).toBe(2);
    runAction(s, HOST, "quiz.open", { index: 0 }, T0);
    expect(hostView(s, [], T0).liveTotals[s.teams[0].id]).toBe(0);
    expect(stageView(s, T0).quiz!.answeredIds).toEqual([]);
  });

  it("keeps the questions when starting fresh", () => {
    const s = ready();
    const id = quiz(s);
    addQ(s, id, { type: "truefalse", prompt: "One", correctIndex: 0 });
    runAction(s, HOST, "quiz.start", { activityId: id }, T0);
    runAction(s, HOST, "quiz.open", {}, T0);
    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.activities[0].questions).toHaveLength(1);
    expect(s.quiz.activityId).toBeNull();
  });
});
