// End-to-end rehearsal against a running server: a host, a stage and a phone
// for every guest, all over real WebSockets.
//
//   node scripts/simulate.mjs http://127.0.0.1:5173 <host-password>
//
// Requires Node 22+ (built-in WebSocket).

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const PASSWORD = process.argv[3] ?? "test-pass";
const WS_BASE = BASE.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(cond, label) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

class Client {
  constructor(params) {
    this.url = `${WS_BASE}/api/ws?${new URLSearchParams(params)}`;
    this.view = null;
    this.pending = new Map();
    this.seq = 0;
    this.welcome = null;
    this.unauthorized = null;
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") {
          this.view = msg.view;
          resolve(this);
          this.waiters = this.waiters.filter((w) => !w(this.view));
        } else if (msg.type === "ok") {
          this.pending.get(msg.rid)?.resolve(msg.data);
        } else if (msg.type === "welcome") {
          this.welcome = msg;
          this.pending.get(msg.rid)?.resolve(msg);
        } else if (msg.type === "error") {
          this.pending.get(msg.rid)?.reject(new Error(msg.message));
        } else if (msg.type === "unauthorized") {
          this.unauthorized = msg.message;
          resolve(this);
        }
      };
      this.ws.onerror = reject;
    });
  }
  req(a, p = {}) {
    const rid = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.ws.send(JSON.stringify({ a, rid, p }));
    });
  }
  /** Resolves when the next state matching pred arrives (or the current one already matches). */
  until(pred, ms = 5000) {
    if (this.view && pred(this.view)) return Promise.resolve(this.view);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for state: ${pred.toString().slice(0, 160)}`)), ms);
      this.waiters.push((v) => {
        if (!pred(v)) return false;
        clearTimeout(t);
        resolve(v);
        return true;
      });
    });
  }
  close() {
    this.ws.close();
  }
}

async function login(password) {
  const res = await fetch(`${BASE}/api/host/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  // --- Host sign-in
  const bad = await login("wrong");
  check(bad.status === 401, "wrong host password is refused");
  const good = await login(PASSWORD);
  check(good.status === 200 && good.body.token, "host signs in");
  const host = await new Client({ role: "host", token: good.body.token }).open();
  check(host.view?.role === "host", "control room connects");
  const intruder = await new Client({ role: "host", token: "nope" }).open();
  check(!!intruder.unauthorized, "control room refuses a made-up token");

  // Start clean if a previous run left anything behind.
  await host.req("event.startFresh", { confirm: "START FRESH", clearGuests: true });
  for (const a of host.view.activities.slice()) await host.req("activity.delete", { id: a.id }).catch(() => {});
  for (const m of host.view.missions.list.filter((x) => x.text.startsWith("Rehearsal mission"))) await host.req("missions.delete", { id: m.id }).catch(() => {});
  await host.req("draw.options", { revealMode: "live", oddFallback: null });
  await host.req("guest.openJoin", { on: true });
  await host.until((v) => v.roster.length === 0 && v.draw.oddFallback === null && v.activities.length === 0);

  const code = host.view.eventCode;
  const badPhone = await new Client({ role: "player", code: "wrongcode" }).open();
  check(!!badPhone.unauthorized, "a phone with the wrong link is refused");

  // --- Guest list and joining
  const names = ["Ava", "Ben", "Cleo", "Dev", "Eli", "Fran", "Gus", "Hana", "Ivo", "Jess", "Late Lou"];
  await host.req("guest.add", { names: names.join("\n") });
  await host.until((v) => names.every((n) => v.roster.some((p) => p.name === n)));
  check(true, "guest list added");

  const stage = await new Client({ role: "stage", code }).open();

  // Connecting a TV with a 4-digit code
  const pairing = await (await fetch(`${BASE}/api/tv/pair`, { method: "POST" })).json();
  check(/^\d{4}$/.test(pairing.code), `a TV gets a pairing code (${pairing.code})`);
  const wrongCode = await host.req("tv.connect", { code: pairing.code === "0000" ? "0001" : "0000" }).catch((e) => e.message);
  check(/No TV is showing that code/.test(wrongCode), "a wrong TV code is refused");
  const waitingTv = await (await fetch(`${BASE}/api/tv/pair/${pairing.id}`)).json();
  check(waitingTv.status === "waiting", "the TV waits for the host");
  await host.req("tv.connect", { code: pairing.code });
  const connectedTv = await (await fetch(`${BASE}/api/tv/pair/${pairing.id}`)).json();
  check(connectedTv.status === "connected" && connectedTv.eventCode === code, "typing the code sends the TV the stage link");
  const usedTv = await fetch(`${BASE}/api/tv/pair/${pairing.id}`);
  check(usedTv.status === 404, "a pairing code only works once");
  const phones = {};
  for (const name of names.slice(0, 10)) {
    const c = await new Client({ role: "player", code }).open();
    const entry = c.view.claimable.find((x) => x.name === name);
    await c.req("player.claim", { playerId: entry.id, emoji: "🎅" });
    phones[name] = c;
  }
  await stage.until((v) => v.players.filter((p) => p.status === "joined").length === 10);
  check(true, "10 phones joined and the stage sees them");

  // Claiming a taken name fails
  const dupe = await new Client({ role: "player", code }).open();
  const avaId = host.view.roster.find((p) => p.name === "Ava").id;
  const dupeErr = await dupe.req("player.claim", { playerId: avaId, emoji: "🎅" }).catch((e) => e.message);
  check(/already joined/.test(dupeErr), "a name can only be claimed once");

  // A new nickname waits for approval when the host has turned open joining off
  await host.req("guest.openJoin", { on: false });
  const kat = await new Client({ role: "player", code }).open();
  await kat.req("player.joinNew", { name: "Kat", emoji: "🐨" });
  await kat.until((v) => v.me?.status === "pending");
  check(!stage.view.players.some((p) => p.name === "Kat"), "pending guests don't appear on the stage");
  const katId = kat.welcome.playerId;
  await host.req("guest.approve", { id: katId });
  await kat.until((v) => v.me?.status === "joined");
  phones.Kat = kat;
  check(true, "host lets a new nickname in");
  await host.req("guest.openJoin", { on: true });
  const renamed = await kat.req("player.rename", { name: "Ava" }).catch((e) => e.message);
  check(/already called/.test(renamed), "a guest can't take someone else's name");
  await kat.req("player.rename", { name: "Kitty Kat" });
  await stage.until((v) => v.players.some((p) => p.name === "Kitty Kat"));
  await kat.req("player.rename", { name: "Kat" });
  check(true, "a guest changes their own nickname and the TV updates");

  // --- Block 4: the questionnaire (food and secret facts)
  const dishes = [
    ["Roast turkey", "main"], ["Nut roast", "main"], ["Roast potatoes", "side"], ["Pigs in blankets", "side"],
    ["Trifle", "dessert"], ["The trifle", "dessert"], ["Mince pies", "dessert"], ["Mulled wine", "drinks"],
    ["Eggnog", "drinks"], ["Cheese board", "other"], ["Sprouts", "side"],
  ];
  const facts = {};
  for (const [i, [name, c]] of Object.entries(phones).entries()) {
    const [dish, category] = dishes[i];
    facts[name] = [`${name}'s secret: once rehearsed a fact ${i}`];
    await c.req("player.answers", { dish, category, dietary: i === 1 ? "Vegan" : "", facts: facts[name] });
  }
  await host.until((v) => Object.keys(v.questionnaires).length === 11);
  check(true, "every phone filled in the questionnaire");
  await stage.until((v) => v.menu.length === 11);
  check(stage.view.menu.some((m) => m.dish === "Nut roast" && m.dietary === "Vegan"), "the TV gets the menu with dietary notes");
  const leaked = JSON.stringify([stage.view, ...Object.values(phones).map((c) => ({ ...c.view, myQuestionnaire: null }))]);
  check(!leaked.includes("secret: once rehearsed"), "secret facts never reach the TV or other phones");
  check(phones.Ava.view.myQuestionnaire?.facts[0].text === facts.Ava[0], "a guest sees their own facts");
  check(host.view.foodWarnings.some((w) => w.kind === "duplicate" && /Trifle/.test(w.message)), "the control room warns about two trifles");
  const badAnswers = await phones.Ava.req("player.answers", { dish: "Trifle", category: "pudding", facts: ["x"] }).catch((e) => e.message);
  check(/kind of dish/.test(badAnswers), "a made-up dish category is refused");

  // --- Block 4: the welcome screen's agenda
  await host.req("agenda.save", { items: [{ time: "12:00", item: "Arrivals and mulled wine" }, { time: "13:00", item: "The draw" }, { time: "13:30", item: "Lunch" }] });
  await stage.until((v) => v.agenda.length === 3);
  check(stage.view.agenda[1].item === "The draw", "the agenda reaches the welcome screen");

  // --- Block 4: secret missions
  const handed = await host.req("missions.handOut");
  check(handed.given === 11 || handed.short > 0, `missions handed out (${handed.given} given, ${handed.short} short)`);
  if (handed.short) {
    for (let i = 0; i < handed.short; i++) await host.req("missions.add", { text: `Rehearsal mission ${i + 1}` });
    await host.req("missions.handOut");
  }
  await host.until((v) => v.missions.assignments.length === 11);
  const missionIds = host.view.missions.assignments.map((x) => x.missionId);
  check(new Set(missionIds).size === 11, "every guest has a different mission");
  await phones.Ben.until((v) => v.myMission);
  const benMission = phones.Ben.view.myMission.text;
  check(phones.Ben.view.myMission.seen === false, "a new mission pops up unseen");
  const missionLeak = JSON.stringify([stage.view, phones.Cleo.view, phones.Dev.view]);
  check(!missionLeak.includes(benMission), "a mission never reaches the TV or another phone");
  await phones.Ben.req("mission.seen");
  await phones.Ben.until((v) => v.myMission.seen);
  check(true, "the guest taps to reveal their mission");

  // --- Odd number: 11 joined
  const lockErr = await host.req("draw.lock").catch((e) => e.message);
  check(/odd number/.test(lockErr), "locking 11 guests needs an odd-number choice");
  await host.req("draw.options", { oddFallback: "trio" });
  await host.req("draw.lock");
  await stage.until((v) => v.draw.phase === "locked");
  check(stage.view.teams.length === 5, "11 guests make 5 teams");
  check(stage.view.teams.every((t) => t.memberIds.length === 0), "stage gets no members before the reveal");
  check(stage.view.draw.pool.length === 11, "all 11 names are on the wheel");
  check(Object.values(phones).every((c) => c.view.me.teamId === null), "no phone learns its team at lock");

  // --- Spins: a double click only counts once
  const step0 = host.view.draw.step;
  const [r1, r2] = await Promise.all([
    host.req("draw.spin", { expectedStep: step0 }),
    host.req("draw.spin", { expectedStep: step0 }),
  ]);
  await host.until((v) => v.draw.step === step0 + 1);
  check(host.view.draw.step === 1 && (r1?.ignored || r2?.ignored), "double-clicked spin reveals only one name");
  const early = await host.req("draw.spin", { expectedStep: 1 });
  check(early?.ignored === true, "spinning again while the wheel turns is ignored");

  const firstEvent = stage.view.draw.lastEvent;
  const revealedName = stage.view.players.find((p) => p.id === firstEvent.playerIds[0]).name;
  const revealedPhone = Object.entries(phones).find(([n]) => n === revealedName)[1];
  await revealedPhone.until((v) => v.me.teamId !== null);
  const others = Object.entries(phones).filter(([n]) => n !== revealedName);
  check(others.every(([, c]) => c.view.me.teamId === null), "other phones still don't know their teams");
  check(revealedPhone.view.myTeam?.memberIds.length === 1, "the drawn guest sees their team, partner still hidden");

  // Refresh the stage mid-draw: it resumes at the same step.
  const stage2 = await new Client({ role: "stage", code }).open();
  check(stage2.view.draw.step === 1, "a refreshed stage resumes at the current step");
  stage2.close();

  // Reveal the rest, one step at a time
  console.log("  …revealing the remaining steps (about a minute)");
  while (host.view.draw.phase !== "complete") {
    const wait = (host.view.spinCooldownUntil ?? 0) - host.view.serverTime + 150;
    if (wait > 0) await sleep(wait);
    const before = host.view.draw.step;
    const res = await host.req("draw.spin", { expectedStep: before });
    if (res?.ignored) {
      await sleep(400);
      continue;
    }
    await host.until((v) => v.draw.step === before + 1);
  }
  await stage.until((v) => v.draw.phase === "complete");
  const sizes = stage.view.teams.map((t) => t.memberIds.length).sort();
  check(JSON.stringify(sizes) === "[2,2,2,2,3]", `teams are 2,2,2,2,3 (got ${sizes})`);
  const everyone = stage.view.teams.flatMap((t) => t.memberIds);
  check(new Set(everyone).size === 11, "every guest is on exactly one team");
  check(Object.values(phones).every((c) => c.view.me.teamId), "every phone knows its team");

  // --- Late arrival
  const lou = await new Client({ role: "player", code }).open();
  const louEntry = lou.view.claimable.find((x) => x.name === "Late Lou");
  await lou.req("player.claim", { playerId: louEntry.id, emoji: "🐧" });
  await host.until((v) => v.roster.some((p) => p.name === "Late Lou" && p.status === "joined"));
  await host.req("team.add", { playerId: louEntry.id, teamId: "random" });
  await lou.until((v) => v.myTeam !== null);
  check(lou.view.myTeam.memberCount === 3, "late arrival joins one of the smallest teams");

  // --- Naming
  await host.req("naming.start");
  await stage.until((v) => v.naming.phase === "open");
  const teamsByPhone = new Map();
  for (const c of [...Object.values(phones), lou]) {
    if (!teamsByPhone.has(c.view.myTeam.id)) teamsByPhone.set(c.view.myTeam.id, c);
  }
  const reps = [...teamsByPhone.values()];
  const typedNames = ["Rehearsal Reindeer", "Tinsel Trouble", "The Sprouts", "Pudding Club", "Bauble Heads", "Last Team"];
  for (let i = 0; i < reps.length; i++) await reps[i].req("team.name", { name: typedNames[i] });
  const dupeName = await reps[1].req("team.name", { name: "rehearsal reindeer" }).catch((e) => e.message);
  check(/Another team/.test(dupeName), "two teams can't have the same name");
  await host.req("naming.close");
  await stage.until((v) => v.naming.phase === "closed");
  check(stage.view.teams.every((t) => t.name), "every team typed a name");
  await host.req("team.rejectName", { teamId: reps[0].view.myTeam.id });
  await reps[0].until((v) => v.myTeam.canRename);
  await reps[0].req("team.name", { name: "Rehearsal Reindeer II" });
  await stage.until((v) => v.teams.some((t) => t.name === "Rehearsal Reindeer II"));
  check(true, "a rejected team can type a new name after naming closes");
  console.log("  Teams:");
  for (const t of stage.view.teams) {
    const members = t.memberIds.map((id) => stage.view.players.find((p) => p.id === id).name).join(", ");
    console.log(`    ${t.badge} ${t.name}: ${members}`);
  }

  // --- Photos
  const TINY_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDMooorkPtj/9k=", "base64");
  const upload = (token, body, type = "image/jpeg") =>
    fetch(`${BASE}/api/photo`, {
      method: "POST",
      headers: { "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
  check((await upload(null, TINY_JPEG)).status === 401, "a photo upload without a guest's link is refused");
  const notPhoto = await upload(phones.Ben.welcome.token, Buffer.from("not a photo at all, just text padding".repeat(4)));
  check(notPhoto.status === 415, `non-photos are refused (got ${notPhoto.status})`);
  const up = await upload(phones.Ben.welcome.token, TINY_JPEG);
  check(up.status === 200, "a guest uploads a photo");
  const benId = host.view.roster.find((p) => p.name === "Ben").id;
  const benOnStage = await stage.until((v) => v.players.find((p) => p.id === benId)?.photo);
  const photoV = benOnStage.players.find((p) => p.id === benId).photo;
  const okRes = await fetch(`${BASE}/api/photo/${benId}?v=${photoV}&c=${code}`);
  check(okRes.status === 200 && okRes.headers.get("content-type") === "image/jpeg", "the stage can load the photo");
  check((await fetch(`${BASE}/api/photo/${benId}?v=${photoV}&c=wrong`)).status === 404, "the photo needs the event link to load");
  await host.req("guest.removePhoto", { id: benId });
  await stage.until((v) => v.players.find((p) => p.id === benId)?.photo === null);
  check((await fetch(`${BASE}/api/photo/${benId}?v=${photoV}&c=${code}`)).status === 404, "the host can remove a photo");

  // --- Phones and sessions
  const avaToken = phones.Ava.welcome.token;
  phones.Ava.close();
  const avaAgain = await new Client({ role: "player", code, token: avaToken }).open();
  check(avaAgain.view.me?.name === "Ava" && avaAgain.view.myTeam, "a phone reconnects as the same guest with its team");
  await host.req("guest.release", { id: avaAgain.view.me.id });
  await avaAgain.until((v) => v.me === null);
  check(true, "unlinking a phone signs it out immediately");
  const { code: rejoin } = await host.req("guest.rejoinCode", { id: avaId });
  await avaAgain.req("player.rejoin", { code: rejoin });
  await avaAgain.until((v) => v.me?.name === "Ava");
  check(avaAgain.view.myTeam !== null, "a rejoin code puts Ava back on her team");

  const resetErr = await host.req("draw.reset", { confirm: "nope" }).catch((e) => e.message);
  check(/RESET/.test(resetErr), "reset needs the typed confirmation");

  // --- Scoring
  const { id: charades } = await host.req("activity.create", { name: "Charades", kind: "team", scoring: "placement", placements: [5, 3, 1] });
  const { id: speed } = await host.req("activity.create", { name: "Speed round", kind: "individual", scoring: "perCorrect", perCorrect: 2 });
  check(stage.view.activities.length === 0, "planned activities stay off the TV");
  await host.req("stage.show", { screen: "activity", activityId: charades });
  await stage.until((v) => v.stage.screen === "activity" && v.activities.some((a) => a.name === "Charades"));
  check(true, "an activity goes on the TV");

  const teamsNow = host.view.teams;
  const [tA, tB, tC] = teamsNow;
  await host.req("score.award", { activityId: charades, teamId: tA.id, placement: 1 });
  await host.req("score.award", { activityId: charades, teamId: tB.id, placement: 2 });
  const third = await host.req("score.award", { activityId: charades, teamId: tC.id, placement: 3 });
  await host.req("score.void", { entryId: third.entryId });
  const ace = tB.memberIds[0];
  await host.req("score.award", { activityId: speed, teamId: tB.id, playerId: ace });
  await host.req("score.award", { activityId: speed, teamId: tB.id, playerId: ace });
  await host.req("score.adjust", { teamId: tC.id, points: 2, reason: "Best costume" });
  const penErr = await host.req("score.adjust", { teamId: tC.id, points: -1 }).catch((e) => e.message);
  check(/reason/.test(penErr), "a penalty needs a reason");
  await host.until((v) => v.liveTotals[tB.id] === 7);
  check(host.view.liveTotals[tA.id] === 5 && host.view.liveTotals[tB.id] === 7 && host.view.liveTotals[tC.id] === 2, "live totals add up, with the voided score left out");
  check(stage.view.standings === null, "points stay hidden from the TV until revealed");
  const resetLocked = await host.req("draw.reset", { confirm: "RESET" }).catch((e) => e.message);
  check(/Start fresh/.test(resetLocked), "the draw can't be reset once points exist");

  await host.req("results.show", { activityId: charades });
  const res = await stage.until((v) => v.stage.screen === "results");
  check(res.results.rows[0].teamId === tA.id && res.results.rows[0].points === 5, "the activity's results reach the TV");

  await host.req("standings.reveal");
  const board = await stage.until((v) => v.stage.screen === "standings" && v.standings);
  check(board.standings.rows[0].teamId === tB.id && board.standings.rows[0].points === 7, "the leaderboard puts the leader first");
  const acePhone = Object.values(phones).find((c) => c.view.me?.id === ace && c.ws.readyState === 1) ?? avaAgain;
  const aceView = await acePhone.until((v) => v.standings !== null);
  check(aceView.me.id !== ace || aceView.myPoints === 4, "a guest sees their own share of the points");

  // Missions: +5 hidden until the next reveal; noticed voids it.
  const agent = tA.memberIds[0];
  const before = host.view.liveTotals[tA.id];
  await host.req("missions.complete", { playerId: agent });
  await host.until((v) => v.liveTotals[tA.id] === before + 5);
  check(stage.view.standings.rows.find((r) => r.teamId === tA.id).points === before, "a completed mission stays off the leaderboard until the next reveal");
  const caught = tC.memberIds[0];
  await host.req("missions.complete", { playerId: caught });
  await host.req("missions.notice", { playerId: caught });
  await host.until((v) => v.missions.assignments.find((x) => x.playerId === caught)?.status === "noticed");
  check(host.view.ledger.some((e) => e.playerId === caught && e.reason === "Secret mission" && e.voided), "a noticed mission's +5 is voided, not deleted");
  const caughtPhone = Object.values(phones).find((c) => c.view?.me?.id === caught && c.ws.readyState === 1);
  if (caughtPhone) {
    await caughtPhone.until((v) => v.myMission?.status === "noticed" && v.myMission.noticedAt);
    check(true, "the noticed guest's phone gets the alert");
  }

  // --- Block 4: the House
  const { id: planes } = await host.req("activity.create", { name: "Paper planes", kind: "team", scoring: "judged" });
  await host.req("house.settings", { activityId: planes, enabled: true, direction: "high", teamPoints: 4, housePoints: 6 });
  await host.req("house.score", { activityId: planes, score: 123456 });
  const relock = await host.req("house.score", { activityId: planes, score: 1 }).catch((e) => e.message);
  check(/locked/.test(relock), "the House's score can't change once locked in");
  await host.req("stage.show", { screen: "activity", activityId: planes });
  await stage.until((v) => v.stage.activityId === planes);
  const housePeek = JSON.stringify([stage.view, ...Object.values(phones).map((c) => c.view)]);
  check(!housePeek.includes("123456"), "the House's score stays off the TV and phones");
  const [hA, hB, hC] = host.view.teams;
  await host.req("house.teamScore", { activityId: planes, teamId: hA.id, score: 200000 });
  await host.req("house.teamScore", { activityId: planes, teamId: hB.id, score: 123456 });
  await host.req("house.teamScore", { activityId: planes, teamId: hC.id, score: 5 });
  await host.req("house.reveal", { activityId: planes });
  const face = await stage.until((v) => v.stage.screen === "house" && v.houseReveal);
  check(face.houseReveal.houseScore === 123456 && face.houseReveal.rows.filter((r) => r.beat).map((r) => r.teamId).join() === hA.id, "the face-off: one team beats the House, and a tie goes to the House");
  await host.until((v) => v.ledger.some((e) => e.activityId === planes && e.teamId === hA.id && e.points === 4));
  check(true, "beating the House earns the points");

  // --- Quiz
  const { id: quizId } = await host.req("activity.create", { name: "Test quiz", format: "quiz", kind: "team", perCorrect: 2, questionSeconds: 0 });
  const imported = await host.req("quiz.import", {
    activityId: quizId,
    text: ["Type\tQuestion\tAnswer\tWrong 1\tWrong 2", "\tPick the right one\tRight\tWrong\tAlso wrong", "\tSpell the word\tSnowflake"].join("\n"),
  });
  check(imported.added === 2, "questions import from pasted spreadsheet rows");
  await host.req("quiz.start", { activityId: quizId });
  await stage.until((v) => v.stage.screen === "quiz" && v.quiz?.phase === "intro");
  await host.req("quiz.open");
  const q1 = await stage.until((v) => v.quiz?.phase === "open");
  check(!JSON.stringify(q1).includes("correctIndex") && q1.quiz.reveal === null, "the TV gets the question but not the answer");
  const qTeams = host.view.teams;
  const rightIndex = q1.quiz.question.options.indexOf("Right");
  const phoneFor = (pid) => Object.values(phones).find((c) => c.view?.me?.id === pid && c.ws.readyState === 1) ?? (avaAgain.view.me?.id === pid ? avaAgain : null);
  const memberPhone = (t) => t.memberIds.map(phoneFor).find(Boolean);
  const pA = memberPhone(qTeams[0]);
  const pB = memberPhone(qTeams[1]);
  await pA.req("quiz.answer", { questionId: q1.quiz.question.id, value: rightIndex });
  await pB.req("quiz.answer", { questionId: q1.quiz.question.id, value: (rightIndex + 1) % 3 });
  await stage.until((v) => v.quiz.answeredIds.length === 2);
  check(true, "phones answer and the TV sees who's in");
  await host.req("quiz.close");
  const late = await pA.req("quiz.answer", { questionId: q1.quiz.question.id, value: 0 }).catch((e) => e.message);
  check(/Time's up/.test(late), "late answers are refused");
  await host.req("quiz.reveal");
  const qr1 = await stage.until((v) => v.quiz.phase === "revealed");
  check(qr1.quiz.reveal.results.find((x) => x.answererId === qTeams[0].id)?.correct === true, "the right answer is marked right");
  await host.req("quiz.open");
  const q2 = await stage.until((v) => v.quiz.phase === "open" && v.quiz.index === 1);
  await pB.req("quiz.answer", { questionId: q2.quiz.question.id, value: "snowflak" });
  await host.until((v) => v.quizAnswers.length === 1);
  check(host.view.quizAnswers[0].auto === "close", "a near-miss typed answer is flagged for checking");
  await host.req("quiz.mark", { answererId: qTeams[1].id, correct: true });
  await host.req("quiz.reveal");
  await host.until((v) => v.quiz.phase === "revealed");
  await host.req("results.show", { activityId: quizId });
  const qr = await stage.until((v) => v.stage.screen === "results" && v.results?.activityId === quizId);
  check(qr.results.rows.filter((r) => r.points === 2).length === 2, "quiz points reach the round results");

  // --- Block 4: polls on phones
  const livePhones = host.view.roster.filter((p) => p.teamId).map((p) => ({ p, c: phoneFor(p.id) })).filter((x) => x.c);
  const { id: pollId } = await host.req("activity.create", { name: "Superlatives", format: "poll", questionSeconds: 0 });
  await host.req("poll.question.save", { activityId: pollId, question: { prompt: "Most likely to fall asleep first", optionsKind: "players", scoring: "winner", points: 3 } });
  await host.req("poll.start", { activityId: pollId });
  await host.req("poll.open");
  const pq = await stage.until((v) => v.stage.screen === "poll" && v.poll?.phase === "open");
  const sleepy = livePhones[0].p;
  const selfVote = await livePhones[0].c.req("poll.vote", { questionId: pq.poll.question.id, key: sleepy.id }).catch((e) => e.message);
  check(/yourself/.test(selfVote), "nobody can vote for themselves");
  for (const { c } of livePhones.slice(1, 5)) await c.req("poll.vote", { questionId: pq.poll.question.id, key: sleepy.id });
  await livePhones[0].c.req("poll.vote", { questionId: pq.poll.question.id, key: livePhones[1].p.id });
  await stage.until((v) => v.poll.answeredIds.length === 5);
  check(!JSON.stringify(stage.view.poll).includes(`"votes"`) && stage.view.poll.reveal === null, "votes stay hidden from the TV until the reveal");
  await host.req("poll.reveal");
  const pr = await stage.until((v) => v.poll?.phase === "revealed");
  check(pr.poll.reveal.winners[0] === sleepy.id && pr.poll.reveal.counts[sleepy.id] === 4, "the reveal shows the winner and the votes");
  check(host.view.ledger.some((e) => e.activityId === pollId && e.playerId === sleepy.id && e.points === 3 && !e.revealed), "the winner's points wait for the round results");

  const { id: wwtId } = await host.req("activity.create", { name: "Who wrote this?", format: "poll", pollKind: "whowrote", perCorrect: 2, foolBonus: 4, questionSeconds: 0 });
  const factOwner = livePhones[2];
  const ownerFact = host.view.questionnaires[factOwner.p.id].facts[0];
  await host.req("poll.question.save", { activityId: wwtId, question: { factId: ownerFact.id } });
  check(!JSON.stringify(stage.view).includes(ownerFact.text), "a secret fact stays off the TV before its question");
  await host.req("poll.start", { activityId: wwtId });
  await host.req("poll.open");
  const wq = await stage.until((v) => v.poll?.activityId === wwtId && v.poll.phase === "open");
  check(wq.poll.question.prompt === ownerFact.text, "the fact goes up on the TV, anonymously");
  await factOwner.c.until((v) => v.myFactOnTv);
  check(true, "the writer's phone knows it's their fact");
  const ownVote = await factOwner.c.req("poll.vote", { questionId: wq.poll.question.id, key: livePhones[0].p.id }).catch((e) => e.message);
  check(/yours/.test(ownVote), "the writer sits their own fact out");
  await livePhones[0].c.req("poll.vote", { questionId: wq.poll.question.id, key: factOwner.p.id });
  await livePhones[1].c.req("poll.vote", { questionId: wq.poll.question.id, key: livePhones[3].p.id });
  await livePhones[3].c.req("poll.vote", { questionId: wq.poll.question.id, key: livePhones[1].p.id });
  await host.req("poll.reveal");
  const wr = await stage.until((v) => v.poll?.activityId === wwtId && v.poll.phase === "revealed");
  check(wr.poll.reveal.writerId === factOwner.p.id && wr.poll.reveal.correctIds.length === 1, "the reveal unmasks the writer and who guessed right");
  check(host.view.ledger.some((e) => e.activityId === wwtId && e.playerId === factOwner.p.id && e.points === 4), "the writer who fooled the most gets the bonus");

  await host.req("standings.blackout", { on: true });
  const blocked = await host.req("standings.reveal").catch((e) => e.message);
  check(/blackout/.test(blocked), "the blackout freezes the leaderboard");
  await host.req("standings.final");
  const fin = await stage.until((v) => v.stage.screen === "final");
  check(fin.standings.final === true && !fin.blackout, "the final results reveal everything");
  check(fin.standings.house !== null && !fin.standings.rows.some((r) => r.teamId === "house"), "the House is on the final leaderboard but can't win");

  await host.req("stage.show", { screen: "missions" });
  const dossiers = await stage.until((v) => v.stage.screen === "missions" && v.missionsReveal);
  check(dossiers.missionsReveal.length === 11 && dossiers.missionsReveal[0].status === "completed", "the finale reveals every mission, pulled-off ones first");

  // --- Block 4: the grand prize and the hall of fame
  const fakePng = new Uint8Array(400);
  fakePng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const uploadPicture = async () => {
    const r = await fetch(`${BASE}/api/image`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${good.body.token}` }, body: fakePng });
    return (await r.json()).id;
  };
  const noPrize = await host.req("stage.show", { screen: "prize" }).catch((e) => e.message);
  check(/trophy/.test(noPrize) || !!host.view.prize.trophyImageId, "the grand prize needs a trophy photo");
  await host.req("prize.trophy", { imageId: await uploadPicture() });
  await host.req("prize.winner.add", { imageId: await uploadPicture(), caption: "2025: Rehearsal Reindeer" });
  await stage.until((v) => v.prize.trophyImageId && v.prize.pastWinners.some((w) => w.caption === "2025: Rehearsal Reindeer"));
  const trophyRes = await fetch(`${BASE}/api/image/${stage.view.prize.trophyImageId}?c=${code}`);
  check(trophyRes.status === 200, "the TV can load the trophy photo");
  await host.req("stage.show", { screen: "prize" });
  await stage.until((v) => v.stage.screen === "prize");
  await host.req("stage.show", { screen: "gallery" });
  await stage.until((v) => v.stage.screen === "gallery");
  check(true, "The Grand Prize and the hall of fame go on the TV");
  for (const w of host.view.prize.pastWinners.filter((x) => x.caption === "2025: Rehearsal Reindeer")) await host.req("prize.winner.remove", { id: w.id });

  // --- Block 4: videos, uploaded in chunks and streamed with Range requests
  const auth = { authorization: `Bearer ${good.body.token}` };
  const clip = new Uint8Array(3_200_000).map((_, i) => (i * 7) % 251);
  const tooBig = await fetch(`${BASE}/api/video`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "x", type: "video/mp4", size: 200 * 1024 * 1024 }) });
  check(tooBig.status === 400, "a video over 80 MB is refused");
  const notHost = await fetch(`${BASE}/api/video`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", type: "video/mp4", size: 1000 }) });
  check(notHost.status === 401, "only the host can upload videos");
  const begun = await (await fetch(`${BASE}/api/video`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Rehearsal clip", type: "video/mp4", size: clip.length, durationMs: 3000 }) })).json();
  check(begun.chunks === Math.ceil(clip.length / begun.chunkSize), `upload split into ${begun.chunks} chunks`);
  const short = await fetch(`${BASE}/api/video/${begun.id}/chunk/0`, { method: "PUT", headers: auth, body: clip.slice(0, 10) });
  check(short.status === 400, "a chunk of the wrong size is refused");
  const unfinished = await fetch(`${BASE}/api/video/${begun.id}/done`, { method: "POST", headers: auth });
  check(unfinished.status === 400, "an unfinished upload can't be completed");
  for (let i = 0; i < begun.chunks; i++) {
    const r = await fetch(`${BASE}/api/video/${begun.id}/chunk/${i}`, { method: "PUT", headers: auth, body: clip.slice(i * begun.chunkSize, (i + 1) * begun.chunkSize) });
    if (!r.ok) check(false, `chunk ${i} uploaded`);
  }
  const finished = await fetch(`${BASE}/api/video/${begun.id}/done`, { method: "POST", headers: auth });
  check(finished.ok, "the upload completes");
  await host.until((v) => v.videos.some((x) => x.id === begun.id));
  const whole = new Uint8Array(await (await fetch(`${BASE}/api/video/${begun.id}?c=${code}`)).arrayBuffer());
  check(whole.length === clip.length && whole.every((b, i) => b === clip[i]), "the whole clip streams back intact");
  const ranged = await fetch(`${BASE}/api/video/${begun.id}?c=${code}`, { headers: { range: "bytes=1499990-1500009" } });
  const part = new Uint8Array(await ranged.arrayBuffer());
  check(ranged.status === 206 && part.length === 20 && part.every((b, i) => b === clip[1499990 + i]), "a range across two chunks streams correctly");
  const noCode = await fetch(`${BASE}/api/video/${begun.id}`);
  check(noCode.status === 404, "videos need the event link");
  await host.req("activity.video", { activityId: charades, videoId: begun.id });
  await host.req("stage.show", { screen: "activity", activityId: charades });
  await stage.until((v) => v.video?.videoId === begun.id && v.video.playing);
  check(true, "an activity's clip plays on the TV when it starts");
  await host.req("video.pause");
  await stage.until((v) => v.video && !v.video.playing);
  await host.req("video.skip");
  await stage.until((v) => !v.video && v.stage.screen === "activity");
  check(true, "the host pauses and skips the clip");
  await host.req("video.delete", { id: begun.id });
  const gone = await fetch(`${BASE}/api/video/${begun.id}?c=${code}`);
  check(gone.status === 404, "a deleted clip is gone from storage");

  for (const c of [host, stage, intruder, badPhone, dupe, lou, avaAgain, ...Object.values(phones)]) {
    try {
      c.close();
    } catch {}
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
