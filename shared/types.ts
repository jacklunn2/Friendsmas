// Types shared by the Worker (server) and the React app (client).

export type PlayerStatus =
  | "expected" // on the guest list, hasn't joined yet
  | "joined" // has claimed their name on a phone
  | "pending" // joined with a new nickname, waiting for host approval
  | "excluded" // not taking part in the draw
  | "left"; // left early; stays on their team

export type OddFallback = "trio" | "solo";
export type RevealMode = "live" | "finale";
export type DrawPhase = "draft" | "locked" | "revealing" | "complete";
export type NamingPhase = "idle" | "open" | "closed";
export type Role = "host" | "stage" | "player";

export type ActivityKind = "team" | "individual";
export type ScoringScheme = "placement" | "perCorrect" | "judged";
export type EntryKind = "award" | "bonus" | "penalty";
export type StageScreen = "teams" | "activity" | "quiz" | "results" | "standings" | "final" | "welcome" | "missions" | "poll" | "prize" | "house";
export type ActivityFormat = "live" | "quiz" | "poll";
export type QuestionType = "choice" | "truefalse" | "number" | "text" | "poll" | "whowrote";
/** Question types where teams pick from a list worked out at the time (guests, teams or the host's options). */
export const VOTE_TYPES: QuestionType[] = ["poll", "whowrote"];
export type QuizPhase = "intro" | "open" | "closed" | "revealed";

export interface PublicPlayer {
  id: string;
  name: string;
  emoji: string;
  status: PlayerStatus;
  /** Only set once this player's team has been revealed to the viewer. */
  teamId: string | null;
  isTest: boolean;
  /** Photo version, or null if the guest hasn't added a photo. See photoUrl(). */
  photo: number | null;
}

export interface PublicTeam {
  id: string;
  order: number;
  colour: string;
  badge: string;
  /** null until the team types a name. Display as "Team N" meanwhile. */
  name: string | null;
  memberCount: number;
  /** Members revealed so far, in reveal order. */
  memberIds: string[];
}

export interface RevealEventView {
  step: number;
  teamId: string;
  playerIds: string[];
  /** The last team is completed without a spin. */
  final: boolean;
}

export interface DrawView {
  phase: DrawPhase;
  revealMode: RevealMode;
  oddFallback: OddFallback | null;
  /** Number of reveal events already shown. */
  step: number;
  totalSteps: number;
  /** True when the next reveal is the final, no-spin one. */
  nextIsFinal: boolean;
  lastEvent: RevealEventView | null;
  /** Players still on the wheel, sorted by name. */
  pool: string[];
  /** True when this viewer is not shown results until the draw completes. */
  hidden: boolean;
}

export interface NamingView {
  phase: NamingPhase;
  deadline: number | null;
}

export interface ActivityView {
  id: string;
  name: string;
  /** "live": you score it as it's played. "quiz": questions answered on phones and marked automatically. */
  format: ActivityFormat;
  kind: ActivityKind;
  scoring: ScoringScheme;
  /** Points for 1st, 2nd, 3rd… when scoring is "placement". */
  placements: number[];
  /** Points per correct answer when scoring is "perCorrect". */
  perCorrect: number;
  description: string;
  /** Default length of the on-screen timer, or 0 for none. */
  timerSeconds: number;
  resultsShown: boolean;
  /** Quiz only: bonus for the fastest correct answer to each question (0 = off). */
  speedBonus: number;
  /** Quiz only: default seconds per question (0 = no timer). */
  questionSeconds: number;
  questionCount: number;
  /** Poll only: general polls, or "Who wrote this?" with the guests' secret facts. */
  pollKind: PollKind;
  /** "Who wrote this?" only: bonus for the writers who fool the most people. */
  foolBonus: number;
  /** A clip that plays on the TV, with sound, when the activity starts. */
  videoId: string | null;
  /** Clips linked to the activity, played by the host when they reach that point. */
  clips: string[];
  /** A quiz round in the running order: the House scores the same as the lowest team. */
  houseMatchesLowest: boolean;
  /** "Beat the House" settings. The House's score itself is never sent to the TV or phones before the reveal. */
  house: HouseSettingsView | null;
}

/** A quiz question as the host edits it. Never sent to guests or the TV. */
export interface QuestionView {
  id: string;
  type: QuestionType;
  prompt: string;
  /** Multiple choice: the options in display order. */
  options: string[];
  /** Multiple choice and true/false: the index of the right option (true = 0, false = 1). */
  correctIndex: number;
  /** Closest number: the right answer. */
  numberAnswer: number | null;
  /** Typed answer: every accepted answer. */
  accepted: string[];
  imageId: string | null;
  /** A clip that plays on the TV when the question opens. */
  videoId: string | null;
  /** Poll: what teams vote between. */
  optionsKind: PollOptionsKind;
  /** "Who wrote this?": the guest's secret fact it uses. */
  factId: string | null;
  /** Overrides the quiz's points per correct answer. */
  points: number | null;
  /** Overrides the quiz's seconds per question; 0 = no timer. */
  seconds: number | null;
  notes: string;
  fact: string;
}

/** The question as guests and the TV see it while it's open: no answer. */
export interface LiveQuestion {
  id: string;
  number: number;
  type: QuestionType;
  prompt: string;
  options: string[];
  /** Polls and "Who wrote this?": what teams pick between. */
  choices: PollOptionView[] | null;
  optionsKind: PollOptionsKind | null;
  imageId: string | null;
  points: number;
}

export interface QuizResult {
  /** A team id (team quizzes) or a guest id (individual quizzes). */
  answererId: string;
  correct: boolean;
  /** What they answered, for closest-number and typed questions. */
  value: string | null;
  points: number;
  fastest: boolean;
}

export interface QuizView {
  activityId: string;
  kind: ActivityKind;
  phase: QuizPhase;
  /** 0-based index of the current question, or -1 before the first. */
  index: number;
  total: number;
  endsAt: number | null;
  question: LiveQuestion | null;
  /** Who has answered the current question. */
  answeredIds: string[];
  /** Only once the answer is revealed. */
  reveal: {
    answer: string;
    correctIndex: number | null;
    results: QuizResult[];
    /** Polls and "Who wrote this?": how many teams picked each choice. */
    counts: Record<string, number> | null;
    /** Polls: the most popular choice(s). */
    winners: string[];
    /** "Who wrote this?": the writer. */
    writerId: string | null;
  } | null;
}

export interface MyQuizAnswer {
  value: string;
  byPlayerId: string;
}

/** The host's view of every answer to the current question, for marking. */
export interface HostQuizAnswer {
  answererId: string;
  value: string;
  byPlayerId: string;
  at: number;
  /** What automatic marking decided. "close" = a near miss to review. */
  auto: "correct" | "close" | "wrong";
  /** The host's decision, if any. */
  override: boolean | null;
  correct: boolean;
}

export interface TimerView {
  /** Set while running. */
  endsAt: number | null;
  /** Set while paused. */
  remainingMs: number | null;
  durationMs: number;
}

export interface StageStateView {
  screen: StageScreen;
  activityId: string | null;
  timer: TimerView | null;
}

export interface StandingsRow {
  teamId: string;
  points: number;
  /** 1-based; tied teams share a rank. */
  rank: number;
  tied: boolean;
  /** Points and rank at the previous reveal, if the team was on it. */
  prevPoints: number | null;
  prevRank: number | null;
}

export interface StandingsView {
  /** Increases with every reveal, so screens can replay the animation. */
  seq: number;
  at: number;
  final: boolean;
  /** Best first. */
  rows: StandingsRow[];
  /** The House's points and place. It wins ties. Null until The House plays. */
  house: { points: number; prevPoints: number | null; rank: number; prevRank: number | null } | null;
}

export interface ResultsView {
  activityId: string;
  /** Points each team earned in the activity, best first. Only revealed points. */
  rows: { teamId: string; points: number; rank: number; earners: { playerId: string; points: number }[] }[];
  /** The House's points in this activity, if it scored. */
  house: number | null;
}

export interface PublicView {
  version: number;
  serverTime: number;
  eventCode: string;
  players: PublicPlayer[];
  teams: PublicTeam[];
  draw: DrawView;
  naming: NamingView;
  intermission: boolean;
  activities: ActivityView[];
  stage: StageStateView;
  /** The last revealed leaderboard, or null before the first reveal. */
  standings: StandingsView | null;
  /** While on, standings are kept secret until the final reveal. */
  blackout: boolean;
  /** Results of the activity on the TV, when the TV is showing results. */
  results: ResultsView | null;
  /** The quiz on the TV, if any. */
  quiz: QuizView | null;
  /** The poll on the TV, if any. */
  poll: PollView | null;
  /** True: guests can type their own nickname and join straight away, without the host's approval. */
  openJoin: boolean;
  /** The day's running order, written by the host, for the welcome screen. */
  agenda: AgendaItem[];
  prize: PrizeView;
  /** A clip playing on the TV, over whatever screen is showing. */
  video: VideoPlayback | null;
  /** The House-vs-teams face-off, while it's on the TV. */
  houseReveal: HouseRevealView | null;
}

export interface AgendaItem {
  id: string;
  time: string;
  item: string;
}
export interface PastWinner {
  id: string;
  imageId: string;
  /** e.g. "2025: The Sprouts (Ava & Ben)" */
  caption: string;
}
export const CAPTION_MAX = 80;
export const MAX_PAST_WINNERS = 30;
/** Photos from past Friendsmases, shown as a slideshow on the welcome screen. */
export const MAX_MEMORIES = 80;

export interface Memory {
  id: string;
  imageId: string;
  caption: string;
}

/** The grand prize: the trophy photo and the hall of fame. */
export interface PrizeView {
  trophyImageId: string | null;
  pastWinners: PastWinner[];
}

// ---------------------------------------------------------------------------
// Videos (Block 4). Stored in the event's own storage, in chunks.

export const VIDEO_MAX_BYTES = 80 * 1024 * 1024;
export const VIDEO_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
/** Each upload request carries one chunk; each chunk is one stored row. */
export const VIDEO_CHUNK_BYTES = 1_500_000;
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
export const VIDEO_NAME_MAX = 60;

export interface VideoInfo {
  id: string;
  name: string;
  size: number;
  type: string;
  /** From the browser that uploaded it; null if it couldn't tell. */
  durationMs: number | null;
  createdAt: number;
}

/** What the TV is playing. Position = positionMs + (now - since) while playing. */
export interface VideoPlayback {
  videoId: string;
  activityId: string | null;
  playing: boolean;
  positionMs: number;
  since: number;
  /** Changes on every play/restart, so the TV knows to start again. */
  seq: number;
}

export const MAX_ACTIVITY_CLIPS = 10;

export function videoUrl(id: string, eventCode: string): string {
  return `/api/video/${id}?c=${eventCode}`;
}

export const AGENDA_TIME_MAX = 12;
export const AGENDA_ITEM_MAX = 60;
export const AGENDA_MAX_ITEMS = 14;

export interface MyTeamView extends PublicTeam {
  /** True when the host rejected the team's name and they may type a new one. */
  canRename: boolean;
}

export interface PlayerView extends PublicView {
  role: "player";
  me: PublicPlayer | null;
  /** This guest's own questionnaire answers, or null if they haven't done it. */
  myQuestionnaire: QuestionnaireView | null;
  /** This guest's secret mission. Never sent to anyone else. */
  myMission: MyMissionView | null;
  myTeam: MyTeamView | null;
  /** This guest's share of their team's points at the last reveal. */
  myPoints: number;
  /** Their vote on the open poll question, as an option key. */
  myPollVote: string | null;
  /** True while the fact on the TV is this guest's own (they sit it out). */
  myFactOnTv: boolean;
  /** Their (or their team's) answer to the open quiz question. */
  myQuizAnswer: MyQuizAnswer | null;
  /** Names on the guest list that can still be claimed. */
  claimable: { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Guest questionnaire (Block 4)

export type DishCategory = "main" | "side" | "dessert" | "drinks" | "other";
export const DISH_CATEGORIES: readonly DishCategory[] = ["main", "side", "dessert", "drinks", "other"];
export const DISH_CATEGORY_LABEL: Record<DishCategory, string> = {
  main: "Mains",
  side: "Sides",
  dessert: "Desserts",
  drinks: "Drinks",
  other: "Other",
};
/** Categories the food list warns about when nobody is bringing one. */
export const EXPECTED_CATEGORIES: readonly DishCategory[] = ["main", "side", "dessert", "drinks"];
export const DISH_MAX = 60;
export const DIETARY_MAX = 120;
export const FACT_MAX = 200;
export const MAX_FACTS = 3;

export interface SecretFact {
  id: string;
  text: string;
}

/** A guest's answers. Facts only ever go to the host and to the guest who wrote them. */
export interface QuestionnaireView {
  dish: string;
  category: DishCategory;
  dietary: string;
  facts: SecretFact[];
  completedAt: number;
}

/** One dish on the TV's welcome menu. */
export interface MenuItem {
  playerId: string;
  dish: string;
  category: DishCategory;
  dietary: string;
}

export interface FoodWarning {
  kind: "duplicate" | "missing";
  message: string;
  /** For duplicates: the guests bringing the same thing. */
  playerIds: string[];
}

// ---------------------------------------------------------------------------
// The House (Block 4)

/** The House's id in the ledger and on the leaderboard. It is never a team and can never win. */
export const HOUSE_ID = "house";
export type HouseDirection = "high" | "low";

export interface HouseSettingsView {
  direction: HouseDirection;
  /** Points each team gets for beating the House. */
  teamPoints: number;
  /** Points the House takes if no team beats it. */
  housePoints: number;
  /** True once the House's score is set (it can't be changed after that). */
  locked: boolean;
  /** True once the face-off has been settled. */
  settled: boolean;
}

/** The host's private view: the House's score and the teams' scores so far. */
export interface HostHouseView {
  houseScore: number | null;
  teamScores: Record<string, number>;
}

/** The face-off on the TV. */
export interface HouseRevealView {
  activityId: string;
  direction: HouseDirection;
  houseScore: number;
  rows: { teamId: string; score: number | null; beat: boolean }[];
  teamPoints: number;
  housePoints: number;
  houseWins: boolean;
}

// ---------------------------------------------------------------------------
// Polls on phones (Block 4)

export type PollKind = "general" | "whowrote";
/** What guests vote between: each other (with photos), the teams, or the host's own options. */
export type PollOptionsKind = "players" | "teams" | "custom";
/** "winner": points to whoever (or whichever team) gets the most votes. "majority": points to everyone who voted with the majority. */
export type PollScoring = "winner" | "majority" | "none";
export const POLL_OPTIONS_KIND_LABEL: Record<PollOptionsKind, string> = { players: "Guests", teams: "Teams", custom: "Your own options" };
export const POLL_SCORING_LABEL: Record<PollScoring, string> = {
  winner: "Points for the winner",
  majority: "Points for voting with the majority",
  none: "Just for fun",
};

/** A poll question as the host edits it. */
export interface PollQuestionView {
  id: string;
  prompt: string;
  optionsKind: PollOptionsKind;
  /** Custom options only. */
  options: string[];
  scoring: PollScoring;
  points: number;
  /** "Who wrote this?": the secret fact this question uses. */
  factId: string | null;
  /** Overrides the activity's seconds per question; 0 = no timer. */
  seconds: number | null;
}

/** One thing to vote for. The key is a guest id, a team id, or the custom option's index. */
export interface PollOptionView {
  key: string;
  label: string;
}

export interface PollView {
  activityId: string;
  pollKind: PollKind;
  phase: QuizPhase;
  index: number;
  total: number;
  endsAt: number | null;
  question: {
    id: string;
    number: number;
    /** For "Who wrote this?", the secret fact (shown anonymously). */
    prompt: string;
    optionsKind: PollOptionsKind;
    options: PollOptionView[];
    scoring: PollScoring;
    points: number;
    /** "Who wrote this?": the writer sits this one out. */
    writerSitsOut: boolean;
  } | null;
  /** Who has voted on the current question. */
  answeredIds: string[];
  /** Only once revealed. */
  reveal: PollReveal | null;
}

export interface PollReveal {
  /** option key → number of votes */
  counts: Record<string, number>;
  /** voter id → option key */
  votes: Record<string, string>;
  /** The option keys with the most votes (several when tied). */
  winners: string[];
  /** "Who wrote this?": who wrote the fact, and who guessed right. */
  writerId: string | null;
  correctIds: string[];
  /** Points each guest earned on this question (voters, or a winning guest). */
  points: Record<string, number>;
}

/** The host's live view of the votes on the open question. */
export interface HostPollVote {
  voterId: string;
  key: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Secret missions (Block 4)

export type MissionStatus = "active" | "completed" | "noticed";
export const MISSION_POINTS = 5;
export const MISSION_MAX = 200;
export const MAX_MISSIONS = 60;

export interface MissionDef {
  id: string;
  text: string;
}

/** A guest's own mission, on their phone only. */
export interface MyMissionView {
  text: string;
  /** "completed" only shows once its points have been revealed on the leaderboard. */
  status: MissionStatus;
  /** False until the guest first taps to reveal it. */
  seen: boolean;
  /** When the host marked it Noticed (null otherwise), so the phone can sound the alarm once. */
  noticedAt: number | null;
}

export interface MissionAssignmentView {
  playerId: string;
  missionId: string;
  text: string;
  status: MissionStatus;
  seen: boolean;
  /** The +5 in the ledger, while completed. */
  entryId: string | null;
}

export interface HostMissionsView {
  list: MissionDef[];
  autoOnJoin: boolean;
  assignments: MissionAssignmentView[];
}

/** The finale reveal of every mission. */
export interface MissionRevealRow {
  playerId: string;
  text: string;
  status: MissionStatus;
}

export interface StageView extends PublicView {
  /** Photos from past Friendsmases, for the welcome screen slideshow. */
  memories: Memory[];
  /** Every mission and how it went, only while the missions reveal is on the TV. */
  missionsReveal: MissionRevealRow[] | null;
  role: "stage";
  /** The food everyone is bringing, for the welcome screen. */
  menu: MenuItem[];
  /** True when this stage was opened from a signed-in control room, so clicking the wheel spins it. */
  canSpin: boolean;
}

export interface HostPlayer extends PublicPlayer {
  /** The host always sees team membership once teams exist. */
  hasDevice: boolean;
  joinedAt: number | null;
  rejoinCode: string | null;
  rejoinExpires: number | null;
}

export interface AuditEntry {
  at: number;
  action: string;
  detail: string;
}

export interface LedgerEntryView {
  id: string;
  at: number;
  teamId: string;
  playerId: string | null;
  activityId: string | null;
  points: number;
  reason: string;
  kind: EntryKind;
  /** 1-based placing, for placement awards. */
  placement: number | null;
  questionId: string | null;
  voided: boolean;
  /** False until the host reveals it (activity results or a standings reveal). */
  revealed: boolean;
}

/** A quiz round holds this many questions. */
export const ROUND_QUESTIONS = 10;

export interface HostView extends PublicView {
  role: "host";
  /** The day's running order: activity ids, quiz rounds and Beat the House rounds alternating. */
  runSheet: string[];
  roster: HostPlayer[];
  audit: AuditEntry[];
  spinCooldownUntil: number | null;
  /** Every score change, newest first. */
  ledger: LedgerEntryView[];
  /** Current totals including points not yet revealed. */
  liveTotals: Record<string, number>;
  /** True when the live totals differ from the last revealed leaderboard. */
  standingsStale: boolean;
  /** Every quiz's questions, by activity. */
  questions: Record<string, QuestionView[]>;
  /** Answers to the current quiz question, for the presenter view. */
  quizAnswers: HostQuizAnswer[];
  /** Ids of questions already revealed, by activity. */
  revealedQuestions: Record<string, string[]>;
  /** Every guest's questionnaire answers, by guest id. Missing = not done yet. */
  questionnaires: Record<string, QuestionnaireView>;
  foodWarnings: FoodWarning[];
  missions: HostMissionsView;
  /** Every poll activity's questions, by activity. */
  polls: Record<string, PollQuestionView[]>;
  /** Votes on the open poll question, for the presenter view. */
  pollVotes: HostPollVote[];
  videos: VideoInfo[];
  /** Beat-the-House activities: the House's secret score and the teams' scores. */
  house: Record<string, HostHouseView>;
  /** The House's total, including points not yet revealed. */
  liveHouseTotal: number;
  memories: Memory[];
}

export type AnyView = PlayerView | StageView | HostView;

// ---------------------------------------------------------------------------
// Messages

export type ServerMessage =
  | { type: "state"; view: AnyView }
  | { type: "ok"; rid: string; data?: unknown }
  | { type: "error"; rid?: string; message: string }
  | { type: "welcome"; rid?: string; token: string; playerId: string }
  | { type: "unauthorized"; message: string };

/** Every client request carries an action name, a request id and a payload. */
export interface ClientRequest {
  a: string;
  rid: string;
  p?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants shared by both sides

/** The day of the event (local date). Before it, phones say "you're all set, see you on the day". */
export const EVENT_DATE = "2026-12-19";
export const EVENT_DATE_LABEL = "Saturday 19 December";

export const SPIN_MS = 8000;
export const FINAL_REVEAL_MS = 5600;
export const NAMING_MS = 120_000;
export const TEAM_NAME_MAX = 24;
export const NAME_MAX = 24;
export const ACTIVITY_NAME_MAX = 40;
export const REASON_MAX = 60;
export const MAX_POINTS = 1000;
export const UNDO_MS = 10_000;
export const QUESTION_MAX = 300;
export const OPTION_MAX = 120;
export const MAX_OPTIONS = 6;
export const IMAGE_MAX_BYTES = 1_500_000;
export const IMAGE_MAX_SIDE = 1600;
export const ANSWER_MAX = 80;

export const TEAM_COLOURS = [
  "#e2445c", // cranberry
  "#f2b544", // brass
  "#5cc4ea", // ice
  "#a77ce8", // plum
  "#f2803f", // tangerine
  "#5fd6a0", // mint
] as const;

export const TEAM_BADGES = ["🎄", "⭐", "🔔", "🎁", "❄️", "🦌"] as const;
export const EXTRA_BADGES = ["🍬", "🧦", "☃️", "🍪", "🎅", "🕯️", "🦘", "🏖️"] as const;

export const AVATARS = [
  "🎅", "🤶", "🧝", "🦌", "⛄", "🐧", "🦘", "🐨",
  "🎄", "⭐", "🔔", "🎁", "🍪", "🥧", "🍤", "🍉",
  "🏖️", "🕶️", "🎸", "🎳", "🦄", "🐙", "🦖", "🌵",
] as const;

export const PHOTO_SIZE = 360;
export const PHOTO_MAX_BYTES = 300_000;

export function photoUrl(p: { id: string; photo: number | null }, eventCode: string): string | null {
  return p.photo ? `/api/photo/${p.id}?v=${p.photo}&c=${eventCode}` : null;
}

export function teamDisplayName(team: { name: string | null; order: number }): string {
  return team.name ?? `Team ${team.order + 1}`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function placeLabel(row: { rank: number; tied: boolean }): string {
  return `${row.tied ? "=" : ""}${ordinal(row.rank)}`;
}

export function formatPoints(n: number): string {
  return `${n} ${Math.abs(n) === 1 ? "pt" : "pts"}`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : "0";
}

/** How an activity is scored, in words, e.g. "1st: 5 points · 2nd: 3 points". */
export function scoringSummary(a: Pick<ActivityView, "scoring" | "placements" | "perCorrect">): string {
  const pts = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;
  if (a.scoring === "placement") return a.placements.map((p, i) => `${ordinal(i + 1)}: ${pts(p)}`).join(" · ");
  if (a.scoring === "perCorrect") return `${pts(a.perCorrect)} for every correct answer`;
  return "Points at the host's discretion";
}

export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export function imageUrl(id: string, eventCode: string): string {
  return `/api/image/${id}?c=${eventCode}`;
}

/** The right answer, in words. */
export function answerText(q: Pick<QuestionView, "type" | "options" | "correctIndex" | "numberAnswer" | "accepted">): string {
  if (q.type === "choice") return `${OPTION_LETTERS[q.correctIndex] ?? "?"}: ${q.options[q.correctIndex] ?? ""}`;
  if (q.type === "truefalse") return q.correctIndex === 0 ? "True" : "False";
  if (q.type === "number") return q.numberAnswer === null ? "" : formatNumber(q.numberAnswer);
  if (q.type === "poll") return "The most popular answer scores";
  if (q.type === "whowrote") return "Whoever wrote it";
  return q.accepted[0] ?? "";
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-AU", { maximumFractionDigits: 6 });
}

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  choice: "Multiple choice",
  truefalse: "True or false",
  number: "Closest to",
  text: "Exact answer",
  poll: "Poll",
  whowrote: "Who wrote this?",
};
