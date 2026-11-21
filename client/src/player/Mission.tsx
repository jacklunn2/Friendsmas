// A guest's secret mission (Block 4). It pops up full screen the first time,
// hidden behind a "tap to reveal", and can be opened again from the little
// button in the corner. It never appears on the TV or anyone else's phone.

import { useEffect, useRef, useState } from "react";
import { MISSION_POINTS, type MyMissionView } from "../../../shared/types";
import { storage } from "../net";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

/** The mission pop-up. The footer's Mission button opens it; it opens by itself for a new mission. */
export function MissionLayer({ mission, send, open, setOpen }: { mission: MyMissionView; send: Send; open: boolean; setOpen: (open: boolean) => void }) {
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
    // setOpen is stable enough; only a new mission should pop it open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mission.text, mission.seen]);

  const reveal = () => {
    setRevealed(true);
    if (!mission.seen) send("mission.seen").catch(() => {});
  };
  const hide = () => {
    setOpen(false);
    setRevealed(false);
  };

  if (!open) return null;

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
          {mission.status === "noticed" && <span className="mission__result is-failed">Mission failed: someone noticed.</span>}
          {mission.status === "active" && <span className="mission__hint">Pull it off without anyone noticing. The host decides if you did.</span>}
          <span className="mission__tap">Tap to hide</span>
        </button>
      )}
    </div>
  );
}

/**
 * When the host marks a guest's mission as Noticed, their phone sounds the
 * alarm: a full-screen "Mission failed" and a buzz, once. If the phone was closed at
 * the time, it shows the next time they open the link.
 */
export function RumbledAlert({ mission, code, playerId }: { mission: MyMissionView; code: string; playerId: string }) {
  const store = storage(`fm.rumbled.${code}.${playerId}`);
  const at = mission.noticedAt;
  const [dismissed, setDismissed] = useState(() => store.get());
  const show = at !== null && dismissed !== String(at);
  useEffect(() => {
    if (show) navigator.vibrate?.([400, 120, 400, 120, 600]);
  }, [show]);
  if (!show) return null;
  return (
    <div className="rumbled" role="alertdialog" aria-modal="true" aria-label="You failed your secret mission">
      <button
        className="rumbled__body"
        onClick={() => {
          store.set(String(at));
          setDismissed(String(at));
        }}
      >
        <span className="rumbled__siren" aria-hidden>
          🚨
        </span>
        <span className="rumbled__title">Mission failed</span>
        <span className="rumbled__text">Someone noticed your secret mission, so it doesn't count. No points this time.</span>
        <span className="rumbled__mission">"{mission.text}"</span>
        <span className="rumbled__tap">Tap to close</span>
      </button>
    </div>
  );
}
