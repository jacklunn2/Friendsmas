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
      const t = setTimeout(() => reject(new Error("timed out waiting for state")), ms);
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
  await host.req("draw.options", { revealMode: "live", oddFallback: null });
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

  // A new nickname waits for approval
  const kat = await new Client({ role: "player", code }).open();
  await kat.req("player.joinNew", { name: "Kat", emoji: "🐨" });
  await kat.until((v) => v.me?.status === "pending");
  check(!stage.view.players.some((p) => p.name === "Kat"), "pending guests don't appear on the stage");
  const katId = kat.welcome.playerId;
  await host.req("guest.approve", { id: katId });
  await kat.until((v) => v.me?.status === "joined");
  phones.Kat = kat;
  check(true, "host lets a new nickname in");

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
  await reps[0].req("team.reroll");
  await reps[0].until((v) => v.myTeam.rerollUsed);
  await reps[0].req("team.pick", { name: reps[0].view.myTeam.suggestions[2] });
  await reps[1].req("team.pick", { name: reps[1].view.myTeam.suggestions[0] });
  await reps[1].req("team.motto", { motto: "Sleigh first, ask questions later" });
  const wrongPick = await reps[2].req("team.pick", { name: "Not a suggestion" }).catch((e) => e.message);
  check(/suggestions/.test(wrongPick), "teams can only pick from their own suggestions");
  await host.req("naming.close");
  await stage.until((v) => v.naming.phase === "closed");
  check(stage.view.teams.every((t) => t.name), "every team has a name after naming closes");
  check(stage.view.teams.some((t) => t.motto), "mottos reach the stage");
  console.log("  Teams:");
  for (const t of stage.view.teams) {
    const members = t.memberIds.map((id) => stage.view.players.find((p) => p.id === id).name).join(", ");
    console.log(`    ${t.badge} ${t.name}: ${members}${t.motto ? ` — “${t.motto}”` : ""}`);
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
  const acePhone = Object.values(phones).find((c) => c.view.me?.id === ace) ?? avaAgain;
  const aceView = await acePhone.until((v) => v.standings !== null);
  check(aceView.me.id !== ace || aceView.myPoints === 4, "a guest sees their own share of the points");

  await host.req("standings.blackout", { on: true });
  const blocked = await host.req("standings.reveal").catch((e) => e.message);
  check(/blackout/.test(blocked), "the blackout freezes the leaderboard");
  await host.req("standings.final");
  const fin = await stage.until((v) => v.stage.screen === "final");
  check(fin.standings.final === true && !fin.blackout, "the final results reveal everything");

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
