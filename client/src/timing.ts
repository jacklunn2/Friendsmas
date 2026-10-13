// How long the TV takes to reveal the leaderboard. Phones wait this long
// before showing the new standings, so they never spoil the reveal.

export const ROW_STEP_MS = 1100;
export const FINAL_ROW_STEP_MS = 2000;
export const LEADER_PAUSE_MS = 1300;
export const FINAL_LEADER_PAUSE_MS = 3200;
export const WINNER_DELAY_MS = 2200;

export function rowDelays(count: number, final: boolean): number[] {
  const step = final ? FINAL_ROW_STEP_MS : ROW_STEP_MS;
  const pause = final ? FINAL_LEADER_PAUSE_MS : LEADER_PAUSE_MS;
  // Rows are best first; the bottom row appears first and the leader last.
  return Array.from({ length: count }, (_, i) => {
    const fromBottom = count - 1 - i;
    return i === 0 && count > 1 ? (count - 2) * step + pause : fromBottom * step;
  });
}

export function revealDurationMs(count: number, final: boolean): number {
  const last = Math.max(0, ...rowDelays(count, final));
  return last + 900 + (final ? WINNER_DELAY_MS : 0);
}
