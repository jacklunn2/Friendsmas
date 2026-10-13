import { describe, expect, it } from "vitest";
import { FINAL_REVEAL_MS, SPIN_MS } from "../shared/types";
import { runAction, type Actor } from "../worker/logic";
import { rank } from "../worker/scoring";
import { freshState, migrate, type ServerState } from "../worker/state";
import { hostView, playerView, stageView } from "../worker/views";

const HOST: Actor = { role: "host", playerId: null };
const T0 = 1_700_000_000_000;

/** An event with n guests drawn into teams, ready to score. */
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

function activity(s: ServerState, fields: Record<string, unknown>): string {
  const r = runAction(s, HOST, "activity.create", { name: "Charades", kind: "team", scoring: "placement", placements: [5, 3, 1], ...fields }, T0);
  return (r.data as { id: string }).id;
}

const award = (s: ServerState, p: Record<string, unknown>) =>
  (runAction(s, HOST, "score.award", p, T0).data as { entryId: string }).entryId;

describe("ranks", () => {
  const teams = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
    { id: "d", order: 3 },
  ];
  it("shares a rank between tied teams", () => {
    const r = rank({ a: 5, b: 9, c: 5, d: 1 }, teams);
    expect(r.map((x) => [x.teamId, x.rank, x.tied])).toEqual([
      ["b", 1, false],
      ["a", 2, true],
      ["c", 2, true],
      ["d", 4, false],
    ]);
  });
});

describe("awarding points", () => {
  it("adds every point to a team, and to the guest who earned it", () => {
    const s = ready();
    const [t1, t2] = s.teams;
    const id = activity(s, { kind: "individual" });
    award(s, { activityId: id, teamId: t1.id, playerId: t1.memberIds[0], placement: 1 });
    award(s, { activityId: id, teamId: t1.id, playerId: t1.memberIds[1], placement: 3 });
    award(s, { activityId: id, teamId: t2.id, playerId: t2.memberIds[0], placement: 2 });
    const host = hostView(s, [], T0);
    expect(host.liveTotals[t1.id]).toBe(6);
    expect(host.liveTotals[t2.id]).toBe(3);
  });

  it("needs a guest for individual activities, and that guest must be on the team", () => {
    const s = ready();
    const [t1, t2] = s.teams;
    const id = activity(s, { kind: "individual" });
    expect(() => award(s, { activityId: id, teamId: t1.id, placement: 1 })).toThrow(/who earned/);
    expect(() => award(s, { activityId: id, teamId: t1.id, playerId: t2.memberIds[0], placement: 1 })).toThrow(/isn't on/);
  });

  it("gives a team one place per activity", () => {
    const s = ready();
    const t1 = s.teams[0];
    const id = activity(s, {});
    award(s, { activityId: id, teamId: t1.id, placement: 1 });
    award(s, { activityId: id, teamId: t1.id, placement: 2 });
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(3);
    expect(s.ledger.filter((e) => !e.voided)).toHaveLength(1);
  });

  it("counts correct answers and judged points", () => {
    const s = ready();
    const t1 = s.teams[0];
    const quiz = activity(s, { name: "Quiz", scoring: "perCorrect", perCorrect: 2 });
    award(s, { activityId: quiz, teamId: t1.id });
    award(s, { activityId: quiz, teamId: t1.id });
    const judged = activity(s, { name: "Costumes", scoring: "judged" });
    award(s, { activityId: judged, teamId: t1.id, points: 7 });
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(11);
    expect(() => award(s, { activityId: judged, teamId: t1.id, points: 0 })).toThrow(/some points/);
  });

  it("needs a reason for bonuses and penalties", () => {
    const s = ready();
    const t1 = s.teams[0];
    expect(() => runAction(s, HOST, "score.adjust", { teamId: t1.id, points: 3 }, T0)).toThrow(/reason/);
    runAction(s, HOST, "score.adjust", { teamId: t1.id, points: 3, reason: "Best costume" }, T0);
    runAction(s, HOST, "score.adjust", { teamId: t1.id, points: -1, reason: "Phone at dinner" }, T0);
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(2);
    expect(s.ledger.map((e) => e.kind)).toEqual(["bonus", "penalty"]);
  });

  it("voids instead of deleting, and can restore", () => {
    const s = ready();
    const t1 = s.teams[0];
    const id = activity(s, {});
    const e = award(s, { activityId: id, teamId: t1.id, placement: 1 });
    runAction(s, HOST, "score.void", { entryId: e }, T0);
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(0);
    expect(s.ledger).toHaveLength(1);
    runAction(s, HOST, "score.restore", { entryId: e }, T0);
    expect(hostView(s, [], T0).liveTotals[t1.id]).toBe(5);
  });

  it("won't change an activity's scoring once points exist", () => {
    const s = ready();
    const id = activity(s, {});
    award(s, { activityId: id, teamId: s.teams[0].id, placement: 1 });
    expect(() =>
      runAction(s, HOST, "activity.update", { id, name: "Charades", kind: "team", scoring: "judged" }, T0),
    ).toThrow(/can't change/);
    expect(() => runAction(s, HOST, "activity.delete", { id }, T0)).toThrow(/Void them/);
  });
});

describe("reveals", () => {
  it("keeps new points off the TV and phones until revealed", () => {
    const s = ready();
    const t1 = s.teams[0];
    const id = activity(s, {});
    award(s, { activityId: id, teamId: t1.id, placement: 1 });
    expect(stageView(s, T0).standings).toBeNull();
    expect(playerView(s, t1.memberIds[0], T0).standings).toBeNull();
    expect(hostView(s, [], T0).standingsStale).toBe(true);

    runAction(s, HOST, "standings.reveal", {}, T0);
    const shown = stageView(s, T0).standings!;
    expect(shown.rows[0]).toMatchObject({ teamId: t1.id, points: 5, rank: 1 });
    expect(hostView(s, [], T0).standingsStale).toBe(false);

    // More points: the leaderboard on the TV doesn't move until the next reveal.
    award(s, { activityId: id, teamId: s.teams[1].id, placement: 1 });
    expect(stageView(s, T0).standings!.rows.find((r) => r.teamId === s.teams[1].id)!.points).toBe(0);
  });

  it("shows an activity's results without moving the leaderboard", () => {
    const s = ready();
    const [t1, t2] = s.teams;
    const id = activity(s, {});
    award(s, { activityId: id, teamId: t1.id, placement: 2 });
    award(s, { activityId: id, teamId: t2.id, placement: 1 });
    runAction(s, HOST, "results.show", { activityId: id }, T0);
    const res = stageView(s, T0).results!;
    expect(res.rows.map((r) => [r.teamId, r.points])).toEqual([
      [t2.id, 5],
      [t1.id, 3],
      [s.teams[2].id, 0],
    ]);
    expect(stageView(s, T0).standings).toBeNull();
  });

  it("tracks movement and each guest's share", () => {
    const s = ready();
    const [t1, t2] = s.teams;
    const id = activity(s, { kind: "individual" });
    award(s, { activityId: id, teamId: t1.id, playerId: t1.memberIds[0], placement: 1 });
    runAction(s, HOST, "standings.reveal", {}, T0);
    const id2 = activity(s, { name: "Round 2", kind: "individual" });
    award(s, { activityId: id2, teamId: t2.id, playerId: t2.memberIds[1], placement: 1 });
    award(s, { activityId: id2, teamId: t2.id, playerId: t2.memberIds[0], placement: 2 });
    runAction(s, HOST, "standings.reveal", {}, T0 + 10);
    const rows = stageView(s, T0).standings!.rows;
    expect(rows[0]).toMatchObject({ teamId: t2.id, points: 8, rank: 1, prevPoints: 0, prevRank: 2 });
    expect(rows[1]).toMatchObject({ teamId: t1.id, points: 5, rank: 2, prevRank: 1 });
    expect(playerView(s, t2.memberIds[1], T0).myPoints).toBe(5);
    expect(playerView(s, t1.memberIds[1], T0).myPoints).toBe(0);
  });

  it("freezes the leaderboard during the blackout, then reveals the finale", () => {
    const s = ready();
    const id = activity(s, {});
    award(s, { activityId: id, teamId: s.teams[0].id, placement: 1 });
    runAction(s, HOST, "standings.blackout", { on: true }, T0);
    expect(() => runAction(s, HOST, "standings.reveal", {}, T0)).toThrow(/blackout/);
    runAction(s, HOST, "standings.final", {}, T0);
    const final = stageView(s, T0);
    expect(final.standings!.final).toBe(true);
    expect(final.stage.screen).toBe("final");
    expect(final.blackout).toBe(false);
  });

  it("only shows guests the activity that's on the TV", () => {
    const s = ready();
    const a = activity(s, { name: "Secret plan" });
    activity(s, { name: "Later" });
    expect(stageView(s, T0).activities).toHaveLength(0);
    expect(hostView(s, [], T0).activities).toHaveLength(2);
    runAction(s, HOST, "stage.show", { screen: "activity", activityId: a }, T0);
    expect(playerView(s, s.teams[0].memberIds[0], T0).activities.map((x) => x.name)).toEqual(["Secret plan"]);
  });
});

describe("rehearsing", () => {
  it("locks the draw once points exist", () => {
    const s = ready();
    const id = activity(s, {});
    award(s, { activityId: id, teamId: s.teams[0].id, placement: 1 });
    expect(() => runAction(s, HOST, "draw.reset", { confirm: "RESET" }, T0)).toThrow(/Start fresh/);
  });

  it("starts fresh but keeps the guest link and planned activities", () => {
    const s = ready();
    const code = s.eventCode;
    const id = activity(s, {});
    award(s, { activityId: id, teamId: s.teams[0].id, placement: 1 });
    runAction(s, HOST, "standings.reveal", {}, T0);
    expect(() => runAction(s, HOST, "event.startFresh", { confirm: "yes" }, T0)).toThrow(/START FRESH/);
    const r = runAction(s, HOST, "event.startFresh", { confirm: "START FRESH" }, T0);
    expect(s.eventCode).toBe(code);
    expect(s.draw.phase).toBe("draft");
    expect(s.teams).toHaveLength(0);
    expect(s.ledger).toHaveLength(0);
    expect(s.snapshots).toHaveLength(0);
    expect(s.activities).toHaveLength(1);
    expect(s.players.every((p) => p.teamId === null && p.status === "joined")).toBe(true);
    expect(r.deletePhotos).toEqual([]);

    runAction(s, HOST, "event.startFresh", { confirm: "START FRESH", clearGuests: true }, T0);
    expect(s.players).toHaveLength(0);
  });

  it("upgrades an event saved before scoring existed", () => {
    const old = freshState(T0) as Partial<ServerState>;
    delete old.ledger;
    delete old.activities;
    delete old.stage;
    const s = migrate(old as ServerState);
    expect(s.ledger).toEqual([]);
    expect(s.stage.screen).toBe("teams");
  });
});
