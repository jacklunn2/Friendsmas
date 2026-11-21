// Polls on phones (Block 4): general polls (vote for a guest, a team or one
// of the host's options) and "Who wrote this?" (guess whose secret fact it
// is). They run on the quiz's question flow (open → closed → revealed), share
// its state in s.quiz, and score through ordinary ledger entries that stay
// hidden until the host shows the round's results.
//
// Votes are secret until the reveal: the TV and phones only learn who has
// voted. Nobody can vote for themselves or their own team, and a fact's writer
// sits that question out.

import {
  MAX_OPTIONS,
  MAX_POINTS,
  OPTION_MAX,
  QUESTION_MAX,
  teamDisplayName,
  type HostPollVote,
  type PollOptionsKind,
  type PollOptionView,
  type PollQuestionView,
  type PollReveal,
  type PollScoring,
  type PollView,
} from "../shared/types";
import { findPlayer, int, requireComplete, UserError, type Actor, type Handler, type Payload } from "./common";
import { allFacts } from "./guests";
import { startActivityVideo } from "./show";
import { newId, type Activity, type LedgerEntry, type PollQuestion, type ServerState } from "./state";

const MAX_POLLS = 60;
const MAX_SECONDS = 600;
const GRACE_MS = 600;

type PollActivity = Activity & { polls: PollQuestion[] };

// ---------------------------------------------------------------------------
// Lookups

function findPoll(s: ServerState, id: unknown): PollActivity {
  const a = s.activities.find((x) => x.id === id);
  if (!a) throw new UserError("That activity no longer exists.");
  if (a.format !== "poll") throw new UserError(`${a.name} isn't a poll.`);
  a.polls ??= [];
  return a as PollActivity;
}

function currentPoll(s: ServerState): PollActivity {
  if (!s.quiz.activityId || s.stage.screen !== "poll") throw new UserError("Start a poll on the TV first.");
  return findPoll(s, s.quiz.activityId);
}

function currentQuestion(s: ServerState): { poll: PollActivity; q: PollQuestion } {
  const poll = currentPoll(s);
  const q = poll.polls[s.quiz.index];
  if (!q) throw new UserError("There's no question open.");
  return { poll, q };
}

function votesFor(s: ServerState, activityId: string, questionId: string) {
  return s.quiz.answers[activityId]?.[questionId] ?? {};
}

function pointsFor(poll: Activity, q: PollQuestion): number {
  return poll.pollKind === "whowrote" ? poll.perCorrect : q.points;
}

function factFor(s: ServerState, q: PollQuestion) {
  return q.factId ? allFacts(s).find((f) => f.id === q.factId) ?? null : null;
}

/** Guests who can take part: on a team and not waiting for approval. */
function voters(s: ServerState) {
  return s.players.filter((p) => p.teamId && p.status !== "pending" && s.teams.some((t) => t.id === p.teamId));
}

/** Everything that can be voted for on a question, before excluding the voter. */
function optionsFor(s: ServerState, q: PollQuestion): PollOptionView[] {
  if (q.optionsKind === "custom") return q.options.map((label, i) => ({ key: String(i), label }));
  if (q.optionsKind === "teams") return s.teams.map((t) => ({ key: t.id, label: teamDisplayName(t) }));
  return voters(s)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ key: p.id, label: p.name }));
}

// ---------------------------------------------------------------------------
// Editing

function pollFields(s: ServerState, poll: Activity, p: Payload): Omit<PollQuestion, "id"> {
  const seconds = p.seconds === null || p.seconds === undefined || p.seconds === "" ? null : int(p, "seconds", { min: 0, max: MAX_SECONDS, label: "the time limit" });
  if (poll.pollKind === "whowrote") {
    if (typeof p.factId !== "string" || !allFacts(s).some((f) => f.id === p.factId)) throw new UserError("Choose one of the guests' secret facts.");
    return { prompt: "", optionsKind: "players", options: [], scoring: "majority", points: 0, factId: p.factId, seconds };
  }
  const prompt = typeof p.prompt === "string" ? p.prompt.trim().replace(/\s+/g, " ") : "";
  if (!prompt) throw new UserError("Enter the poll question.");
  if (prompt.length > QUESTION_MAX) throw new UserError(`The question must be ${QUESTION_MAX} characters or fewer.`);
  const optionsKind = p.optionsKind as PollOptionsKind;
  if (!["players", "teams", "custom"].includes(optionsKind)) throw new UserError("Choose what guests vote for.");
  const scoring = p.scoring as PollScoring;
  if (!["winner", "majority", "none"].includes(scoring)) throw new UserError("Choose how the poll is scored.");
  let options: string[] = [];
  if (optionsKind === "custom") {
    options = (Array.isArray(p.options) ? p.options : [])
      .map((o) => (typeof o === "string" ? o.trim().replace(/\s+/g, " ") : ""))
      .filter(Boolean);
    if (options.length < 2) throw new UserError("Give at least two options.");
    if (options.length > MAX_OPTIONS) throw new UserError(`Give at most ${MAX_OPTIONS} options.`);
    if (options.some((o) => o.length > OPTION_MAX)) throw new UserError(`Options must be ${OPTION_MAX} characters or fewer.`);
    if (scoring === "winner") throw new UserError("Your own options can't win points. Score by majority, or just for fun.");
  }
  const points = scoring === "none" ? 0 : int(p, "points", { min: 1, max: MAX_POINTS, label: "the points" });
  return { prompt, optionsKind, options, scoring, points, factId: null, seconds };
}

function questionUsed(s: ServerState, pollId: string, qid: string): boolean {
  return Object.keys(votesFor(s, pollId, qid)).length > 0 || s.quiz.revealed.includes(qid);
}

// ---------------------------------------------------------------------------
// Scoring

/** Who won a question, and the points it's worth to each guest or team. */
export function tally(s: ServerState, poll: Activity, q: PollQuestion): PollReveal {
  const votes = Object.fromEntries(Object.entries(votesFor(s, poll.id, q.id)).map(([voter, v]) => [voter, v.value]));
  const counts: Record<string, number> = {};
  for (const key of Object.values(votes)) counts[key] = (counts[key] ?? 0) + 1;
  const top = Math.max(0, ...Object.values(counts));
  const winners = top > 0 ? Object.keys(counts).filter((k) => counts[k] === top) : [];
  const points: Record<string, number> = {};
  const pts = pointsFor(poll, q);
  let writerId: string | null = null;
  let correctIds: string[] = [];
  if (poll.pollKind === "whowrote") {
    writerId = factFor(s, q)?.playerId ?? null;
    correctIds = Object.keys(votes).filter((v) => votes[v] === writerId);
    for (const id of correctIds) points[id] = pts;
  } else if (q.scoring === "majority") {
    for (const [voter, key] of Object.entries(votes)) if (winners.includes(key)) points[voter] = pts;
  } else if (q.scoring === "winner" && q.optionsKind === "players") {
    for (const key of winners) points[key] = pts;
  }
  return { counts, votes, winners, writerId, correctIds, points };
}

function push(s: ServerState, now: number, e: Omit<LedgerEntry, "id" | "at" | "voided" | "voidedAt" | "revealed" | "kind" | "placement">) {
  s.ledger.push({ ...e, id: newId(s, "e"), at: now, kind: "award", placement: null, voided: false, voidedAt: null, revealed: false });
}

function voidTagged(s: ServerState, tag: string, now: number) {
  for (const e of s.ledger) {
    if (!e.voided && e.questionId === tag) {
      e.voided = true;
      e.voidedAt = now;
    }
  }
}

/** Replaces a question's points with fresh ones from the votes. */
function grade(s: ServerState, poll: PollActivity, q: PollQuestion, now: number): void {
  voidTagged(s, q.id, now);
  const number = poll.polls.indexOf(q) + 1;
  const t = tally(s, poll, q);
  if (poll.pollKind !== "whowrote" && q.scoring === "winner" && q.optionsKind === "teams") {
    for (const teamId of t.winners) {
      if (s.teams.some((x) => x.id === teamId)) push(s, now, { teamId, playerId: null, activityId: poll.id, points: q.points, reason: `Poll ${number}: most votes`, questionId: q.id });
    }
  }
  for (const [pid, points] of Object.entries(t.points)) {
    const pl = s.players.find((x) => x.id === pid);
    if (!pl?.teamId || !s.teams.some((x) => x.id === pl.teamId)) continue;
    const reason =
      poll.pollKind === "whowrote" ? `Fact ${number}: guessed the writer` : q.scoring === "majority" ? `Poll ${number}: voted with the majority` : `Poll ${number}: most votes`;
    push(s, now, { teamId: pl.teamId, playerId: pl.id, activityId: poll.id, points, reason, questionId: q.id });
  }
  if (poll.pollKind === "whowrote") gradeFoolers(s, poll, now);
}

/** The bonus for the writers who fooled the most people across the round so far. */
export function foolCounts(s: ServerState, poll: PollActivity): Record<string, number> {
  const fooled: Record<string, number> = {};
  for (const q of poll.polls) {
    if (!s.quiz.revealed.includes(q.id)) continue;
    const t = tally(s, poll, q);
    if (!t.writerId) continue;
    const wrong = Object.keys(t.votes).length - t.correctIds.length;
    fooled[t.writerId] = (fooled[t.writerId] ?? 0) + wrong;
  }
  return fooled;
}

function gradeFoolers(s: ServerState, poll: PollActivity, now: number) {
  const tag = `fool:${poll.id}`;
  voidTagged(s, tag, now);
  if (!poll.foolBonus) return;
  const fooled = foolCounts(s, poll);
  const most = Math.max(0, ...Object.values(fooled));
  if (most <= 0) return;
  for (const [pid, n] of Object.entries(fooled)) {
    if (n !== most) continue;
    const pl = s.players.find((x) => x.id === pid);
    if (!pl?.teamId || !s.teams.some((x) => x.id === pl.teamId)) continue;
    push(s, now, { teamId: pl.teamId, playerId: pl.id, activityId: poll.id, points: poll.foolBonus, reason: `Fooled the most people (${n})`, questionId: tag });
  }
}

// ---------------------------------------------------------------------------
// Running

function openQuestion(s: ServerState, poll: PollActivity, index: number, now: number): void {
  const q = poll.polls[index];
  if (!q) throw new UserError("That question doesn't exist.");
  if (poll.pollKind === "whowrote" && !factFor(s, q)) throw new UserError("That secret fact has been removed. Choose another.");
  if (questionUsed(s, poll.id, q.id)) {
    if (s.quiz.answers[poll.id]) delete s.quiz.answers[poll.id][q.id];
    s.quiz.revealed = s.quiz.revealed.filter((x) => x !== q.id);
    voidTagged(s, q.id, now);
    if (poll.pollKind === "whowrote") gradeFoolers(s, poll, now);
  }
  const secs = q.seconds ?? poll.questionSeconds ?? 30;
  s.quiz.index = index;
  s.quiz.phase = "open";
  s.quiz.openedAt = now;
  s.quiz.endsAt = secs > 0 ? now + secs * 1000 : null;
}

export const pollsHost: Record<string, Handler> = {
  "poll.question.save": (s, _a, p) => {
    const poll = findPoll(s, p.activityId);
    const fields = pollFields(s, poll, (p.question ?? {}) as Payload);
    if (p.questionId) {
      const q = poll.polls.find((x) => x.id === p.questionId);
      if (!q) throw new UserError("That question no longer exists.");
      if (questionUsed(s, poll.id, q.id)) throw new UserError("This question has been played. Replay it from the TV controls, or add a new one.");
      Object.assign(q, fields);
      return { data: { questionId: q.id }, audit: ["poll.question.edit", `${poll.name}: edited question ${poll.polls.indexOf(q) + 1}`] };
    }
    if (poll.polls.length >= MAX_POLLS) throw new UserError(`A poll round can have up to ${MAX_POLLS} questions.`);
    if (fields.factId && poll.polls.some((x) => x.factId === fields.factId)) throw new UserError("That fact is already in this round.");
    const q: PollQuestion = { id: newId(s, "q"), ...fields };
    poll.polls.push(q);
    return { data: { questionId: q.id }, audit: ["poll.question.add", `${poll.name}: added question ${poll.polls.length}`] };
  },

  "poll.question.delete": (s, _a, p) => {
    const poll = findPoll(s, p.activityId);
    const q = poll.polls.find((x) => x.id === p.questionId);
    if (!q) throw new UserError("That question no longer exists.");
    if (s.quiz.activityId === poll.id && poll.polls[s.quiz.index]?.id === q.id && s.stage.screen === "poll" && s.quiz.phase !== "revealed") {
      throw new UserError("That question is on the TV right now.");
    }
    if (s.ledger.some((e) => !e.voided && e.questionId === q.id)) throw new UserError("Points have been awarded for this question. Void them first.");
    const i = poll.polls.indexOf(q);
    poll.polls.splice(i, 1);
    if (s.quiz.activityId === poll.id && s.quiz.index >= i && s.quiz.index > -1) s.quiz.index--;
    return { audit: ["poll.question.delete", `${poll.name}: removed question ${i + 1}`] };
  },

  "poll.question.move": (s, _a, p) => {
    const poll = findPoll(s, p.activityId);
    if (s.quiz.activityId === poll.id && s.stage.screen === "poll") throw new UserError("Questions can't be reordered while this poll is on the TV.");
    const i = poll.polls.findIndex((x) => x.id === p.questionId);
    if (i < 0) throw new UserError("That question no longer exists.");
    const j = i + (p.direction === "up" ? -1 : 1);
    if (j < 0 || j >= poll.polls.length) return { noChange: true };
    [poll.polls[i], poll.polls[j]] = [poll.polls[j], poll.polls[i]];
    return {};
  },

  "poll.start": (s, _a, p, now) => {
    requireComplete(s);
    const poll = findPoll(s, p.activityId);
    if (!poll.polls.length) throw new UserError(`${poll.name} has no questions yet.`);
    if (s.quiz.activityId !== poll.id) {
      s.quiz.activityId = poll.id;
      const firstUnplayed = poll.polls.findIndex((q) => !s.quiz.revealed.includes(q.id));
      if (firstUnplayed === 0) {
        s.quiz.index = -1;
        s.quiz.phase = "intro";
      } else {
        s.quiz.index = (firstUnplayed === -1 ? poll.polls.length : firstUnplayed) - 1;
        s.quiz.phase = "revealed";
      }
      s.quiz.endsAt = null;
    }
    const wasOn = s.stage.screen === "poll" && s.stage.activityId === poll.id;
    s.stage = { screen: "poll", activityId: poll.id, timer: null };
    if (!wasOn) startActivityVideo(s, poll.id, now);
    return { audit: ["poll.start", `${poll.name} on the TV`] };
  },

  "poll.open": (s, _a, p, now) => {
    const poll = currentPoll(s);
    if (s.quiz.phase === "open") throw new UserError("Close the current question first.");
    const index = p.index === undefined ? s.quiz.index + 1 : int(p, "index", { min: 0, max: poll.polls.length - 1, label: "the question" });
    if (p.index === undefined && s.quiz.phase !== "revealed" && s.quiz.phase !== "intro") throw new UserError("Reveal the votes before moving on.");
    if (index >= poll.polls.length) throw new UserError("That was the last question. Show the round results.");
    openQuestion(s, poll, index, now);
    return { audit: ["poll.open", `${poll.name}: question ${index + 1} open`] };
  },

  "poll.close": (s) => {
    const { poll } = currentQuestion(s);
    if (s.quiz.phase !== "open") throw new UserError("That question isn't open.");
    s.quiz.phase = "closed";
    s.quiz.endsAt = null;
    return { audit: ["poll.close", `${poll.name}: question ${s.quiz.index + 1} closed`] };
  },

  "poll.reopen": (s, _a, p, now) => {
    const { poll } = currentQuestion(s);
    if (s.quiz.phase !== "closed") throw new UserError("Only a closed question can be reopened.");
    const extra = p.seconds === undefined ? 15 : int(p, "seconds", { min: 5, max: MAX_SECONDS, label: "the extra time" });
    s.quiz.phase = "open";
    s.quiz.endsAt = now + extra * 1000;
    return { audit: ["poll.reopen", `${poll.name}: question ${s.quiz.index + 1} reopened`] };
  },

  "poll.reveal": (s, _a, _p, now) => {
    const { poll, q } = currentQuestion(s);
    if (s.quiz.phase === "open") {
      s.quiz.phase = "closed";
      s.quiz.endsAt = null;
    }
    if (s.quiz.phase !== "closed") throw new UserError("Those votes are already revealed.");
    s.quiz.phase = "revealed";
    if (!s.quiz.revealed.includes(q.id)) s.quiz.revealed.push(q.id);
    grade(s, poll, q, now);
    return { audit: ["poll.reveal", `${poll.name}: question ${s.quiz.index + 1} revealed`] };
  },
};

export const pollsPlayer: Record<string, Handler> = {
  "poll.vote": (s, actor: Actor, p, now) => {
    if (!actor.playerId) throw new UserError("Join the event first.");
    const me = findPlayer(s, actor.playerId);
    const { poll, q } = currentQuestion(s);
    if (s.quiz.phase !== "open" || (s.quiz.endsAt !== null && now > s.quiz.endsAt + GRACE_MS)) throw new UserError("Voting has closed for this question.");
    if (p.questionId !== q.id) throw new UserError("That question has closed.");
    if (!me.teamId) throw new UserError("You're not on a team yet.");
    if (poll.pollKind === "whowrote" && factFor(s, q)?.playerId === me.id) throw new UserError("This one's yours! Sit back and watch.");
    const key = p.key;
    if (typeof key !== "string" || !optionsFor(s, q).some((o) => o.key === key)) throw new UserError("Choose one of the options.");
    if (key === me.id) throw new UserError("You can't vote for yourself.");
    if (q.optionsKind === "teams" && key === me.teamId) throw new UserError("You can't vote for your own team.");
    const byQuestion = ((s.quiz.answers[poll.id] ??= {})[q.id] ??= {});
    byQuestion[me.id] = { value: key, by: me.id, at: now };
    return {};
  },
};

// ---------------------------------------------------------------------------
// Views

export function pollView(s: ServerState): PollView | null {
  if (s.stage.screen !== "poll" || !s.quiz.activityId) return null;
  const poll = s.activities.find((a) => a.id === s.quiz.activityId);
  if (!poll || poll.format !== "poll") return null;
  const polls = poll.polls ?? [];
  const q = polls[s.quiz.index];
  const live = s.quiz.phase !== "intro" && q;
  const fact = live ? factFor(s, q) : null;
  return {
    activityId: poll.id,
    pollKind: poll.pollKind ?? "general",
    phase: s.quiz.phase,
    index: s.quiz.index,
    total: polls.length,
    endsAt: s.quiz.phase === "open" ? s.quiz.endsAt : null,
    question: live
      ? {
          id: q.id,
          number: s.quiz.index + 1,
          prompt: poll.pollKind === "whowrote" ? (fact?.text ?? "") : q.prompt,
          optionsKind: q.optionsKind,
          options: optionsFor(s, q),
          scoring: poll.pollKind === "whowrote" ? "majority" : q.scoring,
          points: pointsFor(poll, q),
          writerSitsOut: poll.pollKind === "whowrote",
        }
      : null,
    answeredIds: live ? Object.keys(votesFor(s, poll.id, q.id)) : [],
    reveal: live && s.quiz.phase === "revealed" ? tally(s, poll, q) : null,
  };
}

/** Whether this guest wrote the fact on the TV right now (their phone says so instead of asking them to vote). */
export function isMyFact(s: ServerState, playerId: string | null): boolean {
  if (!playerId || s.stage.screen !== "poll" || !s.quiz.activityId || s.quiz.phase === "intro") return false;
  const poll = s.activities.find((a) => a.id === s.quiz.activityId);
  const q = poll?.polls?.[s.quiz.index];
  return !!(poll?.pollKind === "whowrote" && q && factFor(s, q)?.playerId === playerId);
}

export function myPollVote(s: ServerState, playerId: string | null): string | null {
  if (!playerId || s.stage.screen !== "poll" || !s.quiz.activityId || s.quiz.phase === "intro") return null;
  const poll = s.activities.find((a) => a.id === s.quiz.activityId);
  const q = poll?.polls?.[s.quiz.index];
  return (poll && q && votesFor(s, poll.id, q.id)[playerId]?.value) ?? null;
}

export function hostPollVotes(s: ServerState): HostPollVote[] {
  if (s.stage.screen !== "poll" || !s.quiz.activityId || s.quiz.phase === "intro") return [];
  const poll = s.activities.find((a) => a.id === s.quiz.activityId);
  const q = poll?.polls?.[s.quiz.index];
  if (!poll || !q) return [];
  return Object.entries(votesFor(s, poll.id, q.id))
    .map(([voterId, v]) => ({ voterId, key: v.value, at: v.at }))
    .sort((a, b) => a.at - b.at);
}

export function pollQuestionView(q: PollQuestion): PollQuestionView {
  return { ...q, options: q.options.slice() };
}

