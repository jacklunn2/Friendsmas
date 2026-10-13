# Friendsmas

A private, full-day Christmas game show for 10–12 friends: a host control room on a laptop, a stage on the TV, and every guest playing on their phone.

The full product spec lives in the [Friendsmas Product Spec](https://claude.ai/code/artifact/00fe1706-0d45-4ff4-92a7-3ea455094363).

## What's built so far

**Block 1: joining, guest list, team draw and team identities**

- **Joining.** Guests open the private link (or scan the QR code on the TV), tap their name and pick an avatar. Unexpected guests can join with a nickname, and the host lets them in. Phones are remembered, and a 4-digit rejoin code moves a guest to a new phone.
- **Team draw.** The host locks the draw, and the server shuffles everyone into teams with a cryptographically secure random function and saves the result. The wheel on the TV only reveals what was saved, one name per spin, with the last team completed in a final "…which means" moment. Double clicks, a second tab or a refresh can't reroll anything.
- **Odd numbers.** With an odd number of guests, the host must choose between a team of three and a solo player before locking.
- **Reveal modes.** In live mode, each phone buzzes when its owner is drawn. In grand-finale mode, phones wait until every team is drawn.
- **Team identities.** Each team gets a colour and badge, then picks one of three suggested names on their phones within two minutes, with one reroll. The host can edit any name, motto, colour or badge.
- **After the draw.** The host can add late arrivals to a team (or let the app choose one of the smallest teams), move players, mark someone as gone home, or reset the draw with a typed confirmation.
- **Control room.** One big button always does the next step. There's an intermission switch for the TV, and an activity log records every change.
- **Rehearsal.** "Add 6 test guests" fills the guest list for a practice run.

**Block 2: scoring and the leaderboard**

- **Activities.** Plan the day's games in the control room: team or individual, scored by places (for example 5, 3, 1), per correct answer or by your judgement, with optional instructions and a timer for the TV.
- **Team-only points.** Every point belongs to a team and can record which guest earned it. Totals are always added up from the points history, so nothing is counted twice. Undo voids a score; nothing is deleted.
- **Fast scoring.** One tap per team for places, a counter for correct answers, quick +1/+2/+3/+5 for judged games, and bonuses or penalties with a reason. Every award has a 10-second undo.
- **Hidden until revealed.** New points stay off the TV and phones. Show an activity's results, then reveal the standings: the leaderboard fills in from last place up, with each team's gain and movement.
- **Blackout and finale.** Freeze the leaderboard for the last stretch, then reveal the final results, ending with the winners, their photos and confetti. Ties share a place.
- **Phones** show what's playing, the timer, their team's place and their own share of the points, but only after the TV has revealed them.
- **Start fresh** clears a rehearsal (teams, points, reveals and test guests) but keeps your activities and the guest link. Once real points exist, the draw can't be reset.

**Block 3: the quiz engine**

- **Quizzes are activities.** Choose "Quiz on phones" when adding an activity, then set team or individual answers, points per correct answer, seconds per question and an optional speed bonus.
- **Question editor** in the control room: multiple choice (2–6 options), true or false, closest number and typed answers (several accepted spellings), each with an optional picture for the TV, its own points and time, notes for you and a fun fact. Reorder, edit or delete at any time.
- **Spreadsheet import.** Paste rows from Google Sheets or Excel (or a CSV) with the columns Type, Question, Answer, Wrong answers 1–5, Seconds, Points, Notes, Fun fact. There's a template to download.
- **Running it.** The big button steps through: open a question, close answers (or let the timer do it), reveal the answer, next question, then show the round results. The TV shows the question, picture, options, countdown and who's answered; the reveal shows the answer and who got it.
- **Phones** show the question and answer buttons. In team quizzes, partners share one answer and see each other's choice; the last answer in counts.
- **Marking is automatic.** Typed answers ignore case and punctuation; near misses are flagged for you to tick or cross. You can overrule any mark, even after the reveal. Closest-number points go to every team tied for closest.
- **Presenter view** shows the answer, your notes, the fun fact, every answer as it comes in, and the next question. Questions and answers never reach guests' phones or the TV until you open and reveal them.

## Screens

| Address | Who uses it |
| --- | --- |
| `/host` | You, on the laptop (needs the host password) |
| `/stage?c=<event code>` | The TV. Open it with **Launch stage** in the control room |
| `/e/<event code>` | Guests' phones. Use **Copy guest link** in the control room |

## How it works

- `worker/` is the server: a Cloudflare Worker with one Durable Object (`EventRoom`) that holds the whole event. It handles one action at a time, so nothing can collide.
- `worker/logic.ts` holds every game rule as plain functions. `worker/views.ts` decides what each screen may see; unrevealed draw results never leave the server.
- `client/` is the React app for all three screens. `shared/types.ts` is shared by both sides.
- Sound is synthesised in the browser and only plays on the stage.

## Deploying to Cloudflare (one-time setup)

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to **Workers & Pages → Create → Import a repository**, connect GitHub and choose `jacklunn2/friendsmas`.
2. Use these build settings:
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
3. After the first deploy, open the Worker's **Settings → Variables and Secrets**, add a **Secret** called `HOST_PASSWORD` with a password of your choice, and redeploy.
4. Visit `https://friendsmas.<your-subdomain>.workers.dev/host` and sign in.

From then on, every push to `main` deploys automatically.

## Developing locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then set a local HOST_PASSWORD
npm run dev                      # http://localhost:5173/host
```

Checks:

```bash
npm test                                             # game-rule tests
npm run typecheck
node scripts/simulate.mjs http://localhost:5173 <password>   # full rehearsal: host, stage, 12 phones, scoring and a quiz
```

The rehearsal script starts the local event fresh and clears its guest list and activities, so only run it against your local server, never the live one.
