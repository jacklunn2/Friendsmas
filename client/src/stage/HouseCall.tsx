// "Can you beat… THE HOUSE!" When a Beat the House activity goes on the TV,
// the announcer booms it once (after any opening video), and the words slam
// onto the screen in time.

import { useEffect, useState } from "react";
import type { StageView } from "../../../shared/types";
import { announceHouse, audioOn } from "../audio";

/** Activities this TV has already announced, so switching screens doesn't repeat it. */
const announced = new Set<string>();

export function HouseCall({ view, activityId }: { view: StageView; activityId: string | null }) {
  const a = view.activities.find((x) => x.id === activityId);
  const house = !!a?.house;
  const videoPlaying = !!view.video;
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!house || videoPlaying || !activityId) return;
    const first = !announced.has(activityId);
    const timers = [setTimeout(() => setStage(1), 500), setTimeout(() => setStage(2), first ? 2300 : 900)];
    if (first) {
      timers.push(
        setTimeout(() => {
          announced.add(activityId);
          if (audioOn()) announceHouse();
        }, 400),
      );
    } else {
      setStage(2);
    }
    return () => timers.forEach(clearTimeout);
  }, [house, videoPlaying, activityId]);

  if (!house) return null;
  return (
    <div className={`house-call${stage >= 2 ? " is-hit" : ""}`} aria-label="Can you beat the House?">
      <span className={`house-call__ask${stage >= 1 ? " is-in" : ""}`}>Can you beat</span>
      <span className="house-call__house">THE HOUSE?</span>
    </div>
  );
}
