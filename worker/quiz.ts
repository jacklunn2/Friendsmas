// The quiz: a question bank on each quiz activity, a live question flow
// (open → closed → revealed), answers from phones, and automatic marking.
//
// Guests and the TV only ever see the question that's open, and only see its
// answer once it's revealed. Marking writes ordinary ledger entries, which stay
// hidden until the host shows the round's results.

import {
  ANSWER_MAX,
  MAX_OPTIONS,
  MAX_POINTS,
  OPTION_MAX,
  QUESTION_MAX,
  answerText,
  formatNumber,
  teamDisplayName,
  VOTE_TYPES,
  MAX_MASH_GUESTS,
  type HostQuizAnswer,
  type MashAnswer,
  type PollOptionsKind,
  type PollOptionView,
  type QuestionType,
  type QuestionView,
  type QuizResult,
  type QuizView,
} from "../shared/types";
import { findPlayer, findTeam, int, requireComplete, UserError, type Actor, type Handler, type Payload } from "./common";
import { allFacts } from "./guests";
import { shuffle } from "./random";
import { playClip, startActivityVideo } from "./show";
import { newId, type Activity, type Question, type QuizAnswer, type ServerState } from "./state";

const MAX_QUESTIONS = 100;
const NOTES_MAX = 500;
const MAX_SECONDS = 600;
const GRACE_MS = 600;

// ---------------------------------------------------------------------------
// Lookups

function findQuiz(s: ServerState, id: unknown): Activity & { questions: Question[] } {
  const a = s.activities.find((x) => x.id === id);
  if (!a) throw new UserError("That quiz no longer exists.");
  if (a.format !== "quiz") throw new UserError(`${a.name} isn't a quiz.`);
  a.questions ??= [];
  return a as Activity & { questions: Question[] };
}

function currentQuiz(s: ServerState) {
  if (!s.quiz.activityId || s.stage.screen !== "quiz") throw new UserError("Start a quiz on the TV first.");
  return findQuiz(s, s.quiz.activityId);
}

function currentQuestion(s: ServerState): { quiz: Activity & { questions: Question[] }; q: Question } {
  const quiz = currentQuiz(s);
  const q = quiz.questions[s.quiz.index];
  if (!q) throw new UserError("There's no question open.");
  return { quiz, q };
}

function answersFor(s: ServerState, activityId: string, questionId: string): Record<string, QuizAnswer> {
  return s.quiz.answers[activityId]?.[questionId] ?? {};
}

export function pointsFor(quiz: Activity, q: Question): number {
  return q.points ?? quiz.perCorrect;
}

export function secondsFor(quiz: Activity, q: Question): number {
  return q.seconds ?? quiz.questionSeconds ?? 30;
}

// ---------------------------------------------------------------------------
// Polls and "Who wrote this?" inside a round

/** Guests who can be picked or can play: on a team and not waiting for approval. */
function guestsInPlay(s: ServerState) {
  return s.players
    .filter((p) => p.teamId && p.status !== "pending" && s.teams.some((t) => t.id === p.teamId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function factFor(s: ServerState, q: Question) {
  return q.type === "whowrote" && q.factId ? (allFacts(s).find((f) => f.id === q.factId) ?? null) : null;
}

/** What teams pick between on a poll or "Who wrote this?" question. */
export function choicesFor(s: ServerState, q: Question): PollOptionView[] {
  if (q.type === "whowrote") return guestsInPlay(s).map((p) => ({ key: p.id, label: p.name }));
  if (q.type !== "poll") return [];
  const kind = q.optionsKind ?? "custom";
  if (kind === "teams") return s.teams.map((t) => ({ key: t.id, label: teamDisplayName(t) }));
  if (kind === "players") return guestsInPlay(s).map((p) => ({ key: p.id, label: p.name }));
  return q.options.map((label, i) => ({ key: String(i), label }));
}

/** What marking needs to know about all the answers at once. */
export interface MarkContext {
  closest: number | null;
  /** Polls: the most popular choice(s). */
  winners: string[];
  counts: Record<string, number>;
  /** "Who wrote this?": the writer and their team (which can't score on its own fact). */
  writerId: string | null;
  writerTeamId: string | null;
}

function markContext(s: ServerState, q: Question, answers: Record<string, QuizAnswer>): MarkContext {
  const counts: Record<string, number> = {};
  if (VOTE_TYPES.includes(q.type)) for (const a of Object.values(answers)) counts[a.value] = (counts[a.value] ?? 0) + 1;
  const top = Math.max(0, ...Object.values(counts));
  const writer = factFor(s, q);
  return {
    closest: closestDistance(q, answers),
    winners: q.type === "poll" && top > 0 ? Object.keys(counts).filter((k) => counts[k] === top) : [],
    counts,
    writerId: writer?.playerId ?? null,
    writerTeamId: writer ? (s.players.find((p) => p.id === writer.playerId)?.teamId ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Face mash: guests picked from a list, in any order, plus a typed celebrity

/** Reads a stored face mash answer. */
export function parseMash(value: string): MashAnswer {
  try {
    const v = JSON.parse(value) as Partial<MashAnswer>;
    return {
      guests: Array.isArray(v.guests) ? v.guests.filter((g): g is string => typeof g === "string") : [],
      celebrity: typeof v.celebrity === "string" ? v.celebrity : "",
    };
  } catch {
    return { guests: [], celebrity: "" };
  }
}

/** How many of the guests are right (any order, each counted once), and how the celebrity was marked. */
export function mashMark(q: Question, value: string): { guestsRight: number; celebrity: "correct" | "close" | "wrong" | null } {
  const a = parseMash(value);
  const want = new Set(q.pickIds ?? []);
  const guestsRight = new Set(a.guests.filter((g) => want.has(g))).size;
  const celebrity = q.accepted.length ? autoMark({ ...q, type: "text" }, a.celebrity, null) : null;
  return { guestsRight, celebrity };
}

// ---------------------------------------------------------------------------
// Marking

/** Lower case, no punctuation or accents, no leading "the/a/an". */
export function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Automatic marking of one answer, before any host decision. */
export function autoMark(
  q: Question,
  value: string,
  closestDistance: number | null,
  votes?: { ctx: MarkContext; answererTeamId: string | null },
): "correct" | "close" | "wrong" {
  if (q.type === "choice" || q.type === "truefalse") return Number(value) === q.correctIndex ? "correct" : "wrong";
  if (q.type === "poll") return votes?.ctx.winners.includes(value) ? "correct" : "wrong";
  if (q.type === "whowrote") {
    if (!votes?.ctx.writerId || votes.answererTeamId === votes.ctx.writerTeamId) return "wrong";
    return value === votes.ctx.writerId ? "correct" : "wrong";
  }
  if (q.type === "number") {
    if (q.numberAnswer === null || closestDistance === null) return "wrong";
    return Math.abs(Number(value) - q.numberAnswer) === closestDistance ? "correct" : "wrong";
  }
  const given = normalise(value);
  if (!given) return "wrong";
  let close = false;
  for (const ok of q.accepted) {
    const target = normalise(ok);
    if (!target) continue;
    if (given === target || given.replace(/ /g, "") === target.replace(/ /g, "")) return "correct";
    const allowed = target.length <= 4 ? 0 : target.length <= 8 ? 1 : 2;
    if (distance(given, target) <= allowed + 1) close = true;
  }
  return close ? "close" : "wrong";
}

function closestDistance(q: Question, answers: Record<string, QuizAnswer>): number | null {
  if (q.type !== "number" || q.numberAnswer === null) return null;
  const ds = Object.values(answers)
    .map((a) => Math.abs(Number(a.value) - q.numberAnswer!))
    .filter((d) => Number.isFinite(d));
  return ds.length ? Math.min(...ds) : null;
}

/** Every answer to a question with its marking, oldest first. */
export function markAnswers(s: ServerState, quiz: Activity, q: Question): HostQuizAnswer[] {
  const answers = answersFor(s, quiz.id, q.id);
  const ctx = markContext(s, q, answers);
  const overrides = s.quiz.overrides[q.id] ?? {};
  const teamOf = (answererId: string) => (quiz.kind === "team" ? answererId : (s.players.find((p) => p.id === answererId)?.teamId ?? null));
  const base = pointsFor(quiz, q);
  return Object.entries(answers)
    .map(([answererId, a]) => {
      if (q.type === "facemash") {
        // The host's override decides the celebrity; picked guests can't be misspelled.
        const m = mashMark(q, a.value);
        const override = answererId in overrides ? overrides[answererId] : null;
        const celebRight = m.celebrity === null ? null : (override ?? m.celebrity === "correct");
        const guests = q.pickIds?.length ?? 0;
        const total = guests + (m.celebrity === null ? 0 : 1);
        const right = m.guestsRight + (celebRight ? 1 : 0);
        const points = right * base + (total > 0 && right === total ? (q.bonus ?? 0) : 0);
        const auto: "correct" | "close" | "wrong" = m.celebrity === "close" ? "close" : right === total ? "correct" : "wrong";
        const detail = `${m.guestsRight} of ${guests} ${guests === 1 ? "friend" : "friends"}${celebRight === null ? "" : celebRight ? ", celebrity right" : ", celebrity wrong"}`;
        return { answererId, value: a.value, byPlayerId: a.by, at: a.at, auto, override, correct: points > 0, points, detail };
      }
      const auto = autoMark(q, a.value, ctx.closest, { ctx, answererTeamId: teamOf(answererId) });
      const override = answererId in overrides ? overrides[answererId] : null;
      return {
        answererId,
        value: a.value,
        byPlayerId: a.by,
        at: a.at,
        auto,
        override,
        correct: override ?? auto === "correct",
        points: (override ?? auto === "correct") ? base : 0,
        detail: null,
      };
    })
    .sort((a, b) => a.at - b.at);
}

/** Replaces this question's points in the ledger with fresh ones from the current marking. */
function grade(s: ServerState, quiz: Activity, q: Question, now: number): void {
  for (const e of s.ledger) {
    if (!e.voided && e.questionId === q.id) {
      e.voided = true;
      e.voidedAt = now;
    }
  }
  const marked = markAnswers(s, quiz, q).filter((m) => m.correct);
  const number = quiz.questions!.indexOf(q) + 1;
  const pts = pointsFor(quiz, q);
  if (q.type === "facemash") {
    for (const m of marked) {
      const target = recipient(s, quiz, m.answererId);
      if (!target || m.points <= 0) continue;
      s.ledger.push({
        id: newId(s, "e"),
        at: now,
        teamId: target.teamId,
        playerId: target.playerId,
        activityId: quiz.id,
        points: m.points,
        reason: `Q${number}: ${m.detail}`,
        kind: "award",
        placement: null,
        questionId: q.id,
        voided: false,
        voidedAt: null,
        revealed: false,
      });
    }
    return;
  }
  const fastest = quiz.speedBonus && !["number", "poll", "whowrote", "facemash"].includes(q.type) ? marked[0] : undefined;
  for (const m of marked) {
    const target = recipient(s, quiz, m.answererId);
    if (!target) continue;
    const push = (points: number, reason: string) =>
      s.ledger.push({
        id: newId(s, "e"),
        at: now,
        teamId: target.teamId,
        playerId: target.playerId,
        activityId: quiz.id,
        points,
        reason,
        kind: "award",
        placement: null,
        questionId: q.id,
        voided: false,
        voidedAt: null,
        revealed: false,
      });
    const why = q.type === "number" ? "closest" : q.type === "poll" ? "voted with the majority" : q.type === "whowrote" ? "guessed the writer" : "correct";
    push(pts, `Q${number}: ${why}`);
    if (fastest === m) push(quiz.speedBonus!, `Q${number}: fastest correct answer`);
  }
}

/** Where an answerer's points go: the team, and the guest in individual quizzes. */
function recipient(s: ServerState, quiz: Activity, answererId: string): { teamId: string; playerId: string | null } | null {
  if (quiz.kind === "team") return s.teams.some((t) => t.id === answererId) ? { teamId: answererId, playerId: null } : null;
  const p = s.players.find((x) => x.id === answererId);
  return p?.teamId ? { teamId: p.teamId, playerId: p.id } : null;
}

// ---------------------------------------------------------------------------
// Question editing

function cleanLine(v: unknown, max: number, label: string, required = false): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new UserError(`${label} must be text.`);
  const t = v.trim().replace(/[ \t]+/g, " ");
  if (required && !t) throw new UserError(`Enter ${label.toLowerCase()}.`);
  if (t.length > max) throw new UserError(`${label} must be ${max} characters or fewer.`);
  return t;
}

function parseNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const t = v.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Validates a question from the editor or an import. Pass the state to check facts and videos exist. */
export function questionFields(p: Payload, s?: ServerState): Omit<Question, "id" | "imageId"> {
  const type = p.type as QuestionType;
  if (!["choice", "truefalse", "number", "text", "poll", "whowrote", "facemash"].includes(type)) throw new UserError("Choose a question type.");
  // "Who wrote this?" shows the fact itself, so the question line is optional.
  const prompt =
    cleanLine(p.prompt, QUESTION_MAX, "The question", type !== "whowrote" && type !== "facemash") ||
    (type === "whowrote" ? "Who wrote this?" : type === "facemash" ? "Who's in this face mash?" : "");
  let options: string[] = [];
  let correctIndex = 0;
  let numberAnswer: number | null = null;
  let accepted: string[] = [];
  let optionsKind: PollOptionsKind = "custom";
  let factId: string | null = null;
  let pickIds: string[] = [];
  let bonus: number | null = null;
  let answerImageId: string | null = null;
  if (type === "facemash") {
    pickIds = [...new Set((Array.isArray(p.pickIds) ? p.pickIds : []).filter((x): x is string => typeof x === "string"))];
    if (!pickIds.length) throw new UserError("Choose the guests in the face mash.");
    if (pickIds.length > MAX_MASH_GUESTS) throw new UserError(`A face mash can have up to ${MAX_MASH_GUESTS} guests.`);
    if (s && pickIds.some((id) => !s.players.some((pl) => pl.id === id))) throw new UserError("One of those guests is no longer on the guest list.");
    accepted = (Array.isArray(p.accepted) ? p.accepted : []).map((o) => cleanLine(o, ANSWER_MAX, "The celebrity")).filter(Boolean);
    bonus = p.bonus === null || p.bonus === undefined || p.bonus === "" ? null : int(p, "bonus", { min: 0, max: MAX_POINTS, label: "the bonus" });
    if (p.answerImageId !== null && p.answerImageId !== undefined && p.answerImageId !== "") {
      if (typeof p.answerImageId !== "string") throw new UserError("That answer photo didn't upload properly. Try again.");
      answerImageId = p.answerImageId;
    }
  } else if (type === "poll") {
    optionsKind = p.optionsKind as PollOptionsKind;
    if (!["players", "teams", "custom"].includes(optionsKind)) throw new UserError("Choose what teams vote for.");
    if (optionsKind === "custom") {
      options = (Array.isArray(p.options) ? p.options : []).map((o, i) => cleanLine(o, OPTION_MAX, `Option ${i + 1}`)).filter(Boolean);
      if (options.length < 2) throw new UserError("Give at least two options.");
      if (options.length > MAX_OPTIONS) throw new UserError(`Give at most ${MAX_OPTIONS} options.`);
    }
  } else if (type === "whowrote") {
    if (typeof p.factId !== "string" || (s && !allFacts(s).some((f) => f.id === p.factId))) throw new UserError("Choose one of the guests' secret facts.");
    factId = p.factId;
  } else if (type === "choice") {
    options = (Array.isArray(p.options) ? p.options : []).map((o, i) => cleanLine(o, OPTION_MAX, `Option ${i + 1}`)).filter(Boolean);
    if (options.length < 2) throw new UserError("Give at least two options.");
    if (options.length > MAX_OPTIONS) throw new UserError(`Give at most ${MAX_OPTIONS} options.`);
    correctIndex = int(p, "correctIndex", { min: 0, max: options.length - 1, label: "the right option" });
  } else if (type === "truefalse") {
    options = ["True", "False"];
    correctIndex = int(p, "correctIndex", { min: 0, max: 1, label: "the right answer" });
  } else if (type === "number") {
    numberAnswer = parseNumber(p.numberAnswer);
    if (numberAnswer === null) throw new UserError("Enter the right answer as a number.");
  } else {
    accepted = (Array.isArray(p.accepted) ? p.accepted : []).map((o) => cleanLine(o, ANSWER_MAX, "An accepted answer")).filter(Boolean);
    if (!accepted.length) throw new UserError("Enter at least one accepted answer.");
  }
  const points = p.points === null || p.points === undefined || p.points === "" ? null : int(p, "points", { min: 0, max: MAX_POINTS, label: "the points" });
  const seconds = p.seconds === null || p.seconds === undefined || p.seconds === "" ? null : int(p, "seconds", { min: 0, max: MAX_SECONDS, label: "the time limit" });
  const notes = cleanLine(p.notes, NOTES_MAX, "Host notes");
  const fact = cleanLine(p.fact, NOTES_MAX, "The fun fact");
  let videoId: string | null = null;
  if (p.videoId !== null && p.videoId !== undefined && p.videoId !== "") {
    if (typeof p.videoId !== "string" || (s && !s.videos.some((v) => v.id === p.videoId))) throw new UserError("That video no longer exists.");
    videoId = p.videoId;
  }
  return { type, prompt, options, correctIndex, numberAnswer, accepted, points, seconds, notes, fact, videoId, optionsKind, factId, pickIds, bonus, answerImageId };
}

/**
 * Reads questions pasted from a spreadsheet (tabs) or a CSV file. Columns:
 * Type, Question, Answer, Wrong answer 1–5, Seconds, Points, Notes, Fun fact.
 * The type can be left blank: it's worked out from the answers.
 */
export function parseImport(raw: string): { questions: Omit<Question, "id" | "imageId">[]; errors: string[] } {
  const rows = splitRows(raw);
  const questions: Omit<Question, "id" | "imageId">[] = [];
  const errors: string[] = [];
  rows.forEach((cells, i) => {
    const line = i + 1;
    const c = cells.map((x) => x.trim());
    if (c.every((x) => !x)) return;
    if (i === 0 && /^type$/i.test(c[0]) && /question/i.test(c[1] ?? "")) return;
    const [typeRaw = "", prompt = "", answer = "", w1 = "", w2 = "", w3 = "", w4 = "", w5 = "", seconds = "", points = "", notes = "", fact = ""] = c;
    const wrongs = [w1, w2, w3, w4, w5].filter(Boolean);
    let type = typeRaw.toLowerCase().replace(/[^a-z]/g, "");
    const map: Record<string, QuestionType> = {
      choice: "choice", multiplechoice: "choice", mc: "choice",
      truefalse: "truefalse", tf: "truefalse", trueorfalse: "truefalse",
      number: "number", closestnumber: "number", closest: "number", numeric: "number",
      text: "text", typed: "text", typedanswer: "text", word: "text", exact: "text", exactanswer: "text",
      poll: "poll", vote: "poll",
    };
    let qType: QuestionType | undefined = map[type];
    if (!type) {
      if (wrongs.length) qType = "choice";
      else if (/^(true|false)$/i.test(answer)) qType = "truefalse";
      else if (parseNumber(answer) !== null) qType = "number";
      else qType = "text";
    }
    if (!qType) {
      errors.push(`Row ${line}: "${typeRaw}" isn't a question type. Use choice, truefalse, number, text or poll.`);
      return;
    }
    try {
      const payload: Payload = { type: qType, prompt, notes, fact };
      if (qType === "poll") {
        payload.optionsKind = "custom";
        payload.options = [answer, ...wrongs];
      } else if (qType === "choice") {
        const options = shuffle([answer, ...wrongs]);
        payload.options = options;
        payload.correctIndex = options.indexOf(answer);
      } else if (qType === "truefalse") {
        if (!/^(true|false)$/i.test(answer)) throw new UserError("the answer must be True or False.");
        payload.correctIndex = /^true$/i.test(answer) ? 0 : 1;
      } else if (qType === "number") {
        payload.numberAnswer = answer;
      } else {
        payload.accepted = answer.split(/\s*[|/]\s*/);
      }
      if (seconds) payload.seconds = parseNumber(seconds) ?? seconds;
      if (points) payload.points = parseNumber(points) ?? points;
      questions.push(questionFields(payload));
    } catch (e) {
      errors.push(`Row ${line}: ${(e as Error).message.replace(/^\w/, (m) => m.toLowerCase())}`);
    }
  });
  return { questions, errors };
}

/** Splits tab-separated or comma-separated text into rows, honouring quotes. */
function splitRows(raw: string): string[][] {
  const text = raw.replace(/\r\n?/g, "\n");
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  const sep = firstLine.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function questionUsed(s: ServerState, quizId: string, qid: string): boolean {
  return Object.keys(answersFor(s, quizId, qid)).length > 0 || s.quiz.revealed.includes(qid);
}

// ---------------------------------------------------------------------------
// Opening, closing and revealing

function openQuestion(s: ServerState, quiz: Activity & { questions: Question[] }, index: number, now: number): void {
  const q = quiz.questions[index];
  if (!q) throw new UserError("That question doesn't exist.");
  if (q.type === "whowrote" && !factFor(s, q)) throw new UserError("That secret fact has been removed. Choose another for this question.");
  if (q.type === "poll" && choicesFor(s, q).length < 2) throw new UserError("There aren't enough choices for this poll yet.");
  // Replaying a question starts it from scratch.
  if (questionUsed(s, quiz.id, q.id)) {
    if (s.quiz.answers[quiz.id]) delete s.quiz.answers[quiz.id][q.id];
    delete s.quiz.overrides[q.id];
    s.quiz.revealed = s.quiz.revealed.filter((x) => x !== q.id);
    for (const e of s.ledger) {
      if (!e.voided && e.questionId === q.id) {
        e.voided = true;
        e.voidedAt = now;
      }
    }
  }
  const secs = secondsFor(quiz, q);
  s.quiz.index = index;
  s.quiz.phase = "open";
  s.quiz.openedAt = now;
  // A question's clip plays first; the clock allows for it.
  if (s.video?.activityId === quiz.id) s.video = null;
  const clip = q.videoId ? s.videos.find((v) => v.id === q.videoId) : undefined;
  if (clip) playClip(s, clip.id, quiz.id, now);
  s.quiz.endsAt = secs > 0 ? now + (clip?.durationMs ?? 0) + secs * 1000 : null;
}

function closeQuestion(s: ServerState): void {
  s.quiz.phase = "closed";
  s.quiz.endsAt = null;
}

/** Called by the Durable Object alarm. Closes the question when time runs out. */
export function quizAlarm(s: ServerState, now: number): boolean {
  if (s.quiz.phase === "open" && s.quiz.endsAt !== null && now >= s.quiz.endsAt - 250) {
    closeQuestion(s);
    return true;
  }
  return false;
}

export const quizHost: Record<string, Handler> = {
  "quiz.question.save": (s, _a, p, now) => {
    const quiz = findQuiz(s, p.activityId);
    const fields = questionFields((p.question ?? {}) as Payload, s);
    const imageId = typeof (p.question as Payload)?.imageId === "string" ? ((p.question as Payload).imageId as string) : null;
    if (p.questionId) {
      const q = quiz.questions.find((x) => x.id === p.questionId);
      if (!q) throw new UserError("That question no longer exists.");
      const oldImages = [q.imageId, q.answerImageId ?? null];
      Object.assign(q, fields, { imageId });
      if (s.quiz.revealed.includes(q.id)) grade(s, quiz, q, now);
      const gone = oldImages.filter((x): x is string => !!x && x !== q.imageId && x !== q.answerImageId);
      return {
        data: { questionId: q.id },
        audit: ["quiz.question.edit", `${quiz.name}: edited Q${quiz.questions.indexOf(q) + 1}`],
        deleteImages: gone.length ? gone : undefined,
      };
    }
    if (quiz.questions.length >= MAX_QUESTIONS) throw new UserError(`A quiz can have up to ${MAX_QUESTIONS} questions.`);
    const q: Question = { id: newId(s, "q"), imageId, ...fields };
    quiz.questions.push(q);
    return { data: { questionId: q.id }, audit: ["quiz.question.add", `${quiz.name}: added Q${quiz.questions.length}`] };
  },

  "quiz.question.delete": (s, _a, p) => {
    const quiz = findQuiz(s, p.activityId);
    const q = quiz.questions.find((x) => x.id === p.questionId);
    if (!q) throw new UserError("That question no longer exists.");
    if (s.quiz.activityId === quiz.id && quiz.questions[s.quiz.index]?.id === q.id && s.quiz.phase !== "revealed") {
      throw new UserError("That question is on the TV right now.");
    }
    if (s.ledger.some((e) => !e.voided && e.questionId === q.id)) {
      throw new UserError("Points have been awarded for this question. Replay it or void its points first.");
    }
    const i = quiz.questions.indexOf(q);
    quiz.questions.splice(i, 1);
    if (s.quiz.activityId === quiz.id && s.quiz.index >= i && s.quiz.index > -1) s.quiz.index--;
    const images = [q.imageId, q.answerImageId ?? null].filter((x): x is string => !!x);
    return { audit: ["quiz.question.delete", `${quiz.name}: removed Q${i + 1}`], deleteImages: images.length ? images : undefined };
  },

  "quiz.question.move": (s, _a, p) => {
    const quiz = findQuiz(s, p.activityId);
    if (s.quiz.activityId === quiz.id && s.stage.screen === "quiz") throw new UserError("Questions can't be reordered while this quiz is on the TV.");
    const i = quiz.questions.findIndex((x) => x.id === p.questionId);
    if (i < 0) throw new UserError("That question no longer exists.");
    const j = i + (p.direction === "up" ? -1 : 1);
    if (j < 0 || j >= quiz.questions.length) return { noChange: true };
    [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
    return {};
  },

  "quiz.import": (s, _a, p) => {
    const quiz = findQuiz(s, p.activityId);
    if (typeof p.text !== "string" || !p.text.trim()) throw new UserError("Paste some questions first.");
    if (p.text.length > 200_000) throw new UserError("That's too much to import at once.");
    const { questions, errors } = parseImport(p.text);
    if (errors.length) throw new UserError(`Nothing was imported. Fix these and try again:\n${errors.slice(0, 8).join("\n")}${errors.length > 8 ? `\n…and ${errors.length - 8} more` : ""}`);
    if (!questions.length) throw new UserError("No questions found. Check the columns and try again.");
    if (quiz.questions.length + questions.length > MAX_QUESTIONS) throw new UserError(`A quiz can have up to ${MAX_QUESTIONS} questions.`);
    for (const q of questions) quiz.questions.push({ id: newId(s, "q"), imageId: null, ...q });
    return { data: { added: questions.length }, audit: ["quiz.import", `${quiz.name}: imported ${questions.length} questions`] };
  },

  /** Puts a quiz on the TV, ready for its first unplayed question. */
  "quiz.start": (s, _a, p, now) => {
    requireComplete(s);
    const quiz = findQuiz(s, p.activityId);
    if (!quiz.questions.length) throw new UserError(`${quiz.name} has no questions yet.`);
    // Coming back to the quiz already in progress carries on where it was.
    if (s.quiz.activityId !== quiz.id) {
      s.quiz.activityId = quiz.id;
      const firstUnplayed = quiz.questions.findIndex((q) => !s.quiz.revealed.includes(q.id));
      if (firstUnplayed === 0) {
        s.quiz.index = -1;
        s.quiz.phase = "intro";
      } else {
        s.quiz.index = (firstUnplayed === -1 ? quiz.questions.length : firstUnplayed) - 1;
        s.quiz.phase = "revealed";
      }
      s.quiz.endsAt = null;
    }
    const wasOn = s.stage.screen === "quiz" && s.stage.activityId === quiz.id;
    s.stage = { screen: "quiz", activityId: quiz.id, timer: null };
    if (!wasOn) startActivityVideo(s, quiz.id, now);
    return { audit: ["quiz.start", `${quiz.name} on the TV`] };
  },

  /** Opens the next question (or a chosen one). */
  "quiz.open": (s, _a, p, now) => {
    const quiz = currentQuiz(s);
    if (s.quiz.phase === "open") throw new UserError("Close the current question first.");
    const index = p.index === undefined ? s.quiz.index + 1 : int(p, "index", { min: 0, max: quiz.questions.length - 1, label: "the question" });
    if (p.index === undefined && s.quiz.phase !== "revealed" && s.quiz.phase !== "intro") {
      throw new UserError("Reveal the answer before moving on.");
    }
    if (index >= quiz.questions.length) throw new UserError("That was the last question. Show the round results.");
    openQuestion(s, quiz, index, now);
    return { audit: ["quiz.open", `${quiz.name}: Q${index + 1} open`] };
  },

  "quiz.close": (s) => {
    const { quiz } = currentQuestion(s);
    if (s.quiz.phase !== "open") throw new UserError("That question isn't open.");
    closeQuestion(s);
    return { audit: ["quiz.close", `${quiz.name}: Q${s.quiz.index + 1} closed`] };
  },

  /** Gives more time after closing. */
  "quiz.reopen": (s, _a, p, now) => {
    const { quiz } = currentQuestion(s);
    if (s.quiz.phase !== "closed") throw new UserError("Only a closed question can be reopened.");
    const extra = p.seconds === undefined ? 15 : int(p, "seconds", { min: 5, max: MAX_SECONDS, label: "the extra time" });
    s.quiz.phase = "open";
    s.quiz.endsAt = now + extra * 1000;
    return { audit: ["quiz.reopen", `${quiz.name}: Q${s.quiz.index + 1} reopened`] };
  },

  "quiz.reveal": (s, _a, _p, now) => {
    const { quiz, q } = currentQuestion(s);
    if (s.quiz.phase === "open") closeQuestion(s);
    if (s.quiz.phase !== "closed") throw new UserError("That answer is already revealed.");
    s.quiz.phase = "revealed";
    if (!s.quiz.revealed.includes(q.id)) s.quiz.revealed.push(q.id);
    if (q.videoId && s.video?.videoId === q.videoId) s.video = null;
    grade(s, quiz, q, now);
    return { audit: ["quiz.reveal", `${quiz.name}: Q${s.quiz.index + 1} answer revealed`] };
  },

  /** Marks an answer right or wrong by hand (null = back to automatic). */
  "quiz.mark": (s, _a, p, now) => {
    const { quiz, q } = currentQuestion(s);
    if (typeof p.answererId !== "string") throw new UserError("Choose an answer to mark.");
    if (!(p.answererId in answersFor(s, quiz.id, q.id))) throw new UserError("That answer no longer exists.");
    const overrides = (s.quiz.overrides[q.id] ??= {});
    if (p.correct === null) delete overrides[p.answererId];
    else overrides[p.answererId] = p.correct === true;
    if (s.quiz.phase === "revealed") grade(s, quiz, q, now);
    return { audit: ["quiz.mark", `${quiz.name}: Q${s.quiz.index + 1} marked by hand`] };
  },
};

export const quizPlayer: Record<string, Handler> = {
  "quiz.answer": (s, actor: Actor, p, now) => {
    if (!actor.playerId) throw new UserError("Join the event first.");
    const me = findPlayer(s, actor.playerId);
    const { quiz, q } = currentQuestion(s);
    if (s.quiz.phase !== "open" || (s.quiz.endsAt !== null && now > s.quiz.endsAt + GRACE_MS)) {
      throw new UserError("Time's up for this question.");
    }
    if (p.questionId !== q.id) throw new UserError("That question has closed.");
    if (!me.teamId) throw new UserError("You're not on a team yet.");
    findTeam(s, me.teamId);
    let value: string;
    if (q.type === "facemash") {
      const v = (p.value ?? {}) as Partial<MashAnswer>;
      const inPlay = new Set(guestsInPlay(s).map((x) => x.id));
      const guests = [...new Set(Array.isArray(v.guests) ? v.guests : [])];
      if (guests.some((g) => typeof g !== "string" || !inPlay.has(g))) throw new UserError("Pick guests from the list.");
      if (guests.length > (q.pickIds?.length ?? 0)) throw new UserError(`Pick up to ${q.pickIds?.length ?? 0} guests.`);
      const celebrity = q.accepted.length ? cleanLine(v.celebrity, ANSWER_MAX, "The celebrity") : "";
      if (!guests.length && !celebrity) throw new UserError("Pick a guest or name the celebrity first.");
      value = JSON.stringify({ guests, celebrity });
    } else if (q.type === "poll" || q.type === "whowrote") {
      if (typeof p.value !== "string" || !choicesFor(s, q).some((c) => c.key === p.value)) throw new UserError("Choose one of the options.");
      if (q.type === "poll" && q.optionsKind === "teams" && p.value === me.teamId) throw new UserError("You can't vote for your own team.");
      value = p.value;
    } else if (q.type === "choice" || q.type === "truefalse") {
      value = String(int(p, "value", { min: 0, max: q.options.length - 1, label: "your answer" }));
    } else if (q.type === "number") {
      const n = parseNumber(p.value);
      if (n === null) throw new UserError("Enter a number.");
      value = String(n);
    } else {
      value = cleanLine(p.value, ANSWER_MAX, "Your answer", true);
    }
    const answererId = quiz.kind === "team" ? me.teamId : me.id;
    const byQuestion = ((s.quiz.answers[quiz.id] ??= {})[q.id] ??= {});
    const prev = byQuestion[answererId];
    // The time of the first answer counts for the speed bonus, unless it changes.
    byQuestion[answererId] = { value, by: me.id, at: prev && prev.value === value ? prev.at : now };
    return {};
  },
};

// ---------------------------------------------------------------------------
// Views

export function quizView(s: ServerState, revealAnswers: boolean): QuizView | null {
  if (s.stage.screen !== "quiz" || !s.quiz.activityId) return null;
  const quiz = s.activities.find((a) => a.id === s.quiz.activityId);
  if (!quiz || quiz.format !== "quiz") return null;
  const questions = quiz.questions ?? [];
  const q = questions[s.quiz.index];
  const live = s.quiz.phase !== "intro" && q;
  const answers = live ? answersFor(s, quiz.id, q.id) : {};
  const revealed = live && s.quiz.phase === "revealed" && revealAnswers;
  const voting = live && VOTE_TYPES.includes(q.type);
  const choices = voting ? choicesFor(s, q) : null;
  const label = (key: string) => choices?.find((c) => c.key === key)?.label ?? "";
  let reveal: QuizView["reveal"] = null;
  if (revealed) {
    const marked = markAnswers(s, quiz, q);
    const ctx = markContext(s, q, answers);
    const fastest = quiz.speedBonus && !["number", "poll", "whowrote"].includes(q.type) ? marked.find((m) => m.correct) : undefined;
    const results: QuizResult[] = marked.map((m) => ({
      answererId: m.answererId,
      correct: m.correct,
      value:
        q.type === "number"
          ? formatNumber(Number(m.value))
          : q.type === "text"
            ? m.value
            : q.type === "facemash"
              ? m.detail
              : voting
                ? label(m.value)
                : null,
      points: q.type === "facemash" ? m.points : m.correct ? pointsFor(quiz, q) + (fastest === m ? quiz.speedBonus! : 0) : 0,
      fastest: fastest === m,
    }));
    const answer =
      q.type === "poll"
        ? ctx.winners.length
          ? ctx.winners.map(label).join(" & ")
          : "No votes"
        : q.type === "whowrote"
          ? (s.players.find((p) => p.id === ctx.writerId)?.name ?? "A guest")
          : q.type === "facemash"
            ? [...(q.pickIds ?? []).map((id) => s.players.find((p) => p.id === id)?.name ?? "A guest"), ...(q.accepted[0] ? [q.accepted[0]] : [])].join(" + ")
            : answerText(q);
    reveal = {
      answer,
      correctIndex: q.type === "choice" || q.type === "truefalse" ? q.correctIndex : null,
      results,
      counts: voting ? ctx.counts : null,
      winners: ctx.winners,
      writerId: q.type === "whowrote" ? ctx.writerId : null,
      pickIds: q.type === "facemash" ? [...(q.pickIds ?? [])] : [],
      answerImageId: q.type === "facemash" ? (q.answerImageId ?? null) : null,
    };
  }
  return {
    activityId: quiz.id,
    kind: quiz.kind,
    phase: s.quiz.phase,
    index: s.quiz.index,
    total: questions.length,
    endsAt: s.quiz.phase === "open" ? s.quiz.endsAt : null,
    question: live
      ? {
          id: q.id,
          number: s.quiz.index + 1,
          type: q.type,
          prompt: q.type === "whowrote" ? (factFor(s, q)?.text ?? "") : q.prompt,
          options: q.options,
          choices,
          optionsKind: q.type === "poll" ? (q.optionsKind ?? "custom") : q.type === "whowrote" ? "players" : null,
          mash: q.type === "facemash" ? { guests: q.pickIds?.length ?? 0, celebrity: q.accepted.length > 0 } : null,
          imageId: q.imageId,
          points: pointsFor(quiz, q),
        }
      : null,
    answeredIds: Object.keys(answers),
    reveal,
  };
}

export function questionView(q: Question): QuestionView {
  return {
    ...q,
    options: q.options.slice(),
    accepted: q.accepted.slice(),
    videoId: q.videoId ?? null,
    optionsKind: q.optionsKind ?? "custom",
    factId: q.factId ?? null,
    pickIds: [...(q.pickIds ?? [])],
    bonus: q.bonus ?? null,
    answerImageId: q.answerImageId ?? null,
  };
}

/** Whether this guest wrote the fact in the "Who wrote this?" question that's open. */
export function isMyFactInQuiz(s: ServerState, playerId: string | null): boolean {
  if (!playerId || s.stage.screen !== "quiz" || !s.quiz.activityId || s.quiz.phase === "intro") return false;
  const quiz = s.activities.find((a) => a.id === s.quiz.activityId);
  const q = quiz?.questions?.[s.quiz.index];
  return !!(q && factFor(s, q)?.playerId === playerId);
}

/** The answer a guest's phone should show for the open question. */
export function myQuizAnswer(s: ServerState, playerId: string | null) {
  if (!playerId || s.stage.screen !== "quiz" || !s.quiz.activityId || s.quiz.phase === "intro") return null;
  const quiz = s.activities.find((a) => a.id === s.quiz.activityId);
  const q = quiz?.questions?.[s.quiz.index];
  const me = s.players.find((p) => p.id === playerId);
  if (!quiz || !q || !me) return null;
  const answererId = quiz.kind === "team" ? me.teamId : me.id;
  const a = answererId ? answersFor(s, quiz.id, q.id)[answererId] : undefined;
  return a ? { value: a.value, byPlayerId: a.by } : null;
}

export function hostQuizAnswers(s: ServerState): HostQuizAnswer[] {
  if (!s.quiz.activityId || s.quiz.phase === "intro") return [];
  const quiz = s.activities.find((a) => a.id === s.quiz.activityId);
  const q = quiz?.questions?.[s.quiz.index];
  return quiz && q ? markAnswers(s, quiz, q) : [];
}

/** Images used by a quiz, so they can be deleted with it. */
export function quizImages(a: Activity): string[] {
  return (a.questions ?? []).flatMap((q) => [q.imageId, q.answerImageId ?? null]).filter((x): x is string => !!x);
}
