// A guest's secret mission (Block 4). It pops up full screen the first time,
// hidden behind a "tap to reveal", and can be opened again from the little
// button in the corner. It never appears on the TV or anyone else's phone.

import { useEffect, useRef, useState } from "react";
import { MISSION_POINTS, type MyMissionView } from "../../../shared/types";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

export function MissionLayer({ mission, send }: { mission: MyMissionView; send: Send }) {
  // Opens by itself when a new mission arrives (or when one is redrawn).
  const [open, setOpen] = useState(!mission.seen);
  const [revealed, setRevealed] = useState(false);
  const lastText = useRef(mission.text);
  useEffect(() => {
    if (mission.text !== lastText.current || !mission.seen) {
      lastText.current = mission.text;
      if (!mission.seen) {
        setOpen(true);
        setRevealed(false);
        navigator.vibrate?.([60, 60, 60]);
      }
    }
  }, [mission.text, mission.seen]);

  const reveal = () => {
    setRevealed(true);
    if (!mission.seen) send("mission.seen").catch(() => {});
  };
  const hide = () => {
    setOpen(false);
    setRevealed(false);
  };

  if (!open) {
    return (
      <button className="mission-fab" onClick={() => setOpen(true)} aria-label="Your secret mission">
        <span aria-hidden>🕵️</span>
        <span className="mission-fab__label">Secret mission</span>
      </button>
    );
  }

  return (
    <div className={`mission${revealed ? " is-revealed" : ""}`} role="dialog" aria-modal="true" aria-label="Your secret mission">
      {!revealed ? (
        <button className="mission__cover" onClick={reveal}>
          <span className="mission__stamp">Top secret</span>
          <span className="mission__title">Top secret mission</span>
          <span className="mission__warning">Do not show anyone else in the room.</span>
          <span className="mission__tap">Tap to reveal</span>
        </button>
      ) : (
        <button className="mission__paper" onClick={hide}>
          <span className="mission__kicker">Your mission, should you choose to accept it</span>
          <span className="mission__text">{mission.text}</span>
          {mission.status === "completed" && <span className="mission__result is-done">Mission accomplished! +{MISSION_POINTS} for your team</span>}
          {mission.status === "noticed" && <span className="mission__result is-failed">Rumbled! Someone noticed.</span>}
          {mission.status === "active" && <span className="mission__hint">Pull it off without anyone noticing. The host decides if you did.</span>}
          <span className="mission__tap">Tap to hide</span>
        </button>
      )}
    </div>
  );
}
