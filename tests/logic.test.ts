import { describe, expect, it } from "vitest";
import { FINAL_REVEAL_MS, SPIN_MS } from "../shared/types";
import { runAction, teamSizes, onAlarm, type Actor } from "../worker/logic";
import { freshState, type ServerState } from "../worker/state";
import { hostView, playerView, stageView } from "../worker/views";

const HOST: Actor = { role: "host", playerId: null };
const T0 = 1_700_000_000_000;

function setup(n: number, opts: { fallback?: "trio" | "solo" } = {}) {
  const s = freshState(T0);
  runAction(s, HOST, "guest.add", { names: Array.from({ length: n }, (_, i) => `Guest ${i + 1}`).join("\n") }, T0);
  const tokens: Record<string, string> = {};
  for (const p of s.players) {
    const r = runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: p.id, emoji: "🎅" }, T0);
    tokens[p.id] = r.welcome!.token;
  }
  if (opts.fallback) runAction(s, HOST, "draw.options", { oddFallback: opts.fallback }, T0);
  return { s, tokens };
}

/** Runs every reveal step, respecting the cooldown. */
function revealAll(s: ServerState, start = T0 + 1000) {
  let now = start;
  while (s.draw.phase !== "complete") {
    runAction(s, HOST, "draw.spin", { expectedStep: s.draw.step }, now);
    now += SPIN_MS + FINAL_REVEAL_MS;
  }
  return now;
}

describe("team sizes", () => {
  it("pairs an even number", () => expect(teamSizes(12, null)).toEqual([2, 2, 2, 2, 2, 2]));
  it("refuses an odd number without a fallback", () => expect(teamSizes(11, null)).toBeNull());
  it("makes one trio", () => expect(teamSizes(11, "trio")).toEqual([2, 2, 2, 2, 3]));
  it("makes one solo", () => expect(teamSizes(11, "solo")).toEqual([2, 2, 2, 2, 2, 1]));
});

describe("the draw", () => {
  it("puts every eligible guest on exactly one team", () => {
    const { s } = setup(12);
    runAction(s, HOST, "draw.lock", {}, T0);
    expect(s.teams).toHaveLength(6);
    const all = s.teams.flatMap((t) => t.memberIds);
    expect(new Set(all).size).toBe(12);
    expect(s.teams.every((t) => t.memberIds.length === 2)).toBe(true);
    // 5 teams × 2 spins + 1 final reveal
    expect(s.draw.events).toHaveLength(11);
    expect(s.draw.events.at(-1)!.final).toBe(true);
  });

  it("refuses to lock an odd number until a fallback is chosen", () => {
    const { s } = setup(11);
    expect(() => runAction(s, HOST, "draw.lock", {}, T0)).toThrow(/odd number/);
    runAction(s, HOST, "draw.options", { oddFallback: "trio" }, T0);
    runAction(s, HOST, "draw.lock", {}, T0);
    expect(s.teams.map((t) => t.memberIds.length).sort()).toEqual([2, 2, 2, 2, 3]);
  });

  it("leaves excluded guests out", () => {
    const { s } = setup(12);
    runAction(s, HOST, "guest.exclude", { id: s.players[0].id }, T0);
    runAction(s, HOST, "guest.exclude", { id: s.players[1].id }, T0);
    runAction(s, HOST, "draw.lock", {}, T0);
    expect(s.teams.flatMap((t) => t.memberIds)).not.toContain(s.players[0].id);
    expect(s.teams).toHaveLength(5);
  });

  it("ignores duplicate and stale spins", () => {
    const { s } = setup(6);
    runAction(s, HOST, "draw.lock", {}, T0);
    const first = runAction(s, HOST, "draw.spin", { expectedStep: 0 }, T0 + 1000);
    expect(first.noChange).toBeUndefined();
    expect(s.draw.step).toBe(1);
    // Same expected step again (a double click or second tab)
    expect(runAction(s, HOST, "draw.spin", { expectedStep: 0 }, T0 + 1001).noChange).toBe(true);
    // Right step, but the wheel is still spinning
    expect(runAction(s, HOST, "draw.spin", { expectedStep: 1 }, T0 + 2000).noChange).toBe(true);
    expect(s.draw.step).toBe(1);
    runAction(s, HOST, "draw.spin", { expectedStep: 1 }, T0 + 1000 + SPIN_MS);
    expect(s.draw.step).toBe(2);
  });

  it("never changes the saved teams while revealing", () => {
    const { s } = setup(10);
    runAction(s, HOST, "draw.lock", {}, T0);
    const before = JSON.stringify(s.teams.map((t) => t.memberIds));
    revealAll(s);
    expect(JSON.stringify(s.teams.map((t) => t.memberIds))).toBe(before);
    expect(s.draw.phase).toBe("complete");
  });

  it("can't be locked twice, and reset needs confirmation", () => {
    const { s } = setup(4);
    runAction(s, HOST, "draw.lock", {}, T0);
    expect(() => runAction(s, HOST, "draw.lock", {}, T0)).toThrow();
    expect(() => runAction(s, HOST, "draw.reset", {}, T0)).toThrow(/RESET/);
    runAction(s, HOST, "draw.reset", { confirm: "RESET" }, T0);
    expect(s.draw.phase).toBe("draft");
    expect(s.players.every((p) => p.teamId === null)).toBe(true);
  });
});

describe("what each screen can see", () => {
  it("never sends unrevealed pairings", () => {
    const { s } = setup(8);
    runAction(s, HOST, "draw.lock", {}, T0);
    for (const view of [stageView(s, T0), hostView(s, [], T0), playerView(s, s.players[0].id, T0)]) {
      expect(view.teams.every((t) => t.memberIds.length === 0)).toBe(true);
      expect(view.players.every((p) => p.teamId === null)).toBe(true);
    }
    runAction(s, HOST, "draw.spin", { expectedStep: 0 }, T0 + 1000);
    const revealedId = s.draw.events[0].playerIds[0];
    const stage = stageView(s, T0);
    expect(stage.teams.flatMap((t) => t.memberIds)).toEqual([revealedId]);
    expect(stage.draw.pool).not.toContain(revealedId);
    expect(stage.draw.pool).toHaveLength(7);
  });

  it("hides results from phones in grand-finale mode until the end", () => {
    const { s } = setup(6);
    runAction(s, HOST, "draw.options", { revealMode: "finale" }, T0);
    runAction(s, HOST, "draw.lock", {}, T0);
    runAction(s, HOST, "draw.spin", { expectedStep: 0 }, T0 + 1000);
    const phone = playerView(s, s.draw.events[0].playerIds[0], T0);
    expect(phone.draw.hidden).toBe(true);
    expect(phone.me!.teamId).toBeNull();
    expect(phone.draw.pool).toEqual([]);
    expect(stageView(s, T0).teams.flatMap((t) => t.memberIds)).toHaveLength(1);
    revealAll(s, T0 + 1000 + SPIN_MS);
    expect(playerView(s, s.players[0].id, T0).me!.teamId).not.toBeNull();
  });
});

describe("joining", () => {
  it("lets each name be claimed once", () => {
    const s = freshState(T0);
    runAction(s, HOST, "guest.add", { names: "Sam, Alex" }, T0);
    const sam = s.players[0];
    runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: sam.id, emoji: "🦘" }, T0);
    expect(() =>
      runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: sam.id, emoji: "🦘" }, T0),
    ).toThrow(/already joined/);
  });

  it("moves a guest to a new phone with a rejoin code", () => {
    const { s, tokens } = setup(2);
    const p = s.players[0];
    const { data } = runAction(s, HOST, "guest.rejoinCode", { id: p.id }, T0);
    const code = (data as { code: string }).code;
    const r = runAction(s, { role: "player", playerId: null }, "player.rejoin", { code }, T0 + 1000);
    expect(r.welcome!.playerId).toBe(p.id);
    expect(r.welcome!.token).not.toBe(tokens[p.id]);
    expect(() => runAction(s, { role: "player", playerId: null }, "player.rejoin", { code }, T0 + 2000)).toThrow();
  });

  it("holds new nicknames for approval", () => {
    const s = freshState(T0);
    const r = runAction(s, { role: "player", playerId: null }, "player.joinNew", { name: "Jo", emoji: "🐨" }, T0);
    expect(s.players[0].status).toBe("pending");
    expect(stageView(s, T0).players).toHaveLength(0);
    runAction(s, HOST, "guest.approve", { id: r.welcome!.playerId }, T0);
    expect(s.players[0].status).toBe("joined");
  });
});

describe("after the draw", () => {
  it("adds a late arrival to the smallest team at random", () => {
    const { s } = setup(6);
    runAction(s, HOST, "draw.lock", {}, T0);
    revealAll(s);
    runAction(s, HOST, "guest.add", { names: "Late Lou" }, T0);
    const lou = s.players.at(-1)!;
    runAction(s, { role: "player", playerId: null }, "player.claim", { playerId: lou.id, emoji: "🐧" }, T0);
    runAction(s, HOST, "team.add", { playerId: lou.id, teamId: "random" }, T0);
    expect(lou.teamId).not.toBeNull();
    expect(s.teams.map((t) => t.memberIds.length).sort()).toEqual([2, 2, 3]);
  });

  it("runs team naming and fills in names when time runs out", () => {
    const { s } = setup(4);
    runAction(s, HOST, "draw.lock", {}, T0);
    const end = revealAll(s);
    const r = runAction(s, HOST, "naming.start", {}, end);
    expect(r.alarmAt).toBe(end + 120_000);
    const [a, b] = s.teams;
    const playerA: Actor = { role: "player", playerId: a.memberIds[0] };
    runAction(s, playerA, "team.reroll", {}, end);
    expect(() => runAction(s, playerA, "team.reroll", {}, end)).toThrow(/already used/);
    runAction(s, playerA, "team.pick", { name: a.suggestions[1] }, end);
    expect(a.name).toBe(a.suggestions[1]);
    expect(onAlarm(s, end + 120_000)).toBe(true);
    expect(b.name).toBe(b.suggestions[0]);
    expect(s.naming.phase).toBe("closed");
    // Suggestions never repeat across teams
    const offered = s.offeredNames;
    expect(new Set(offered).size).toBe(offered.length);
  });
});
