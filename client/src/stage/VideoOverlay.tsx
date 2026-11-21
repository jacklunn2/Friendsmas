// A clip playing full screen on the TV, with sound (Block 4). The control room
// drives it: play, pause, restart and skip. The TV keeps itself within half a
// second of where the server says the clip should be.

import { useEffect, useRef, useState } from "react";
import { videoUrl, type StageView, type VideoPlayback } from "../../../shared/types";

export function VideoOverlay({ view, serverNow }: { view: StageView; serverNow: () => number }) {
  const pb = view.video!;
  return <Player key={`${pb.videoId}-${pb.seq}`} pb={pb} code={view.eventCode} serverNow={serverNow} />;
}

function Player({ pb, code, serverNow }: { pb: VideoPlayback; code: string; serverNow: () => number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const target = () => (pb.playing ? pb.positionMs + (serverNow() - pb.since) : pb.positionMs) / 1000;
    const sync = () => {
      const t = target();
      if (Number.isFinite(v.duration) && t >= v.duration) return;
      if (Math.abs(v.currentTime - t) > 0.5) v.currentTime = Math.max(0, t);
    };
    const start = () => {
      sync();
      if (pb.playing) {
        v.play().then(
          () => setBlocked(false),
          () => setBlocked(true),
        );
      } else v.pause();
    };
    if (v.readyState >= 1) start();
    else v.addEventListener("loadedmetadata", start, { once: true });
    const t = setInterval(() => pb.playing && !v.paused && sync(), 2000);
    return () => {
      clearInterval(t);
      v.removeEventListener("loadedmetadata", start);
    };
  }, [pb.playing, pb.positionMs, pb.since, serverNow]);

  return (
    <div className="video-overlay">
      <video ref={ref} className="video-overlay__video" src={videoUrl(pb.videoId, code)} playsInline preload="auto" onEnded={() => setEnded(true)} />
      {blocked && (
        <button className="video-overlay__blocked" onClick={() => ref.current?.play().then(() => setBlocked(false), () => {})}>
          ▶ Click to play the video with sound
        </button>
      )}
      {!pb.playing && !ended && <div className="video-overlay__paused" aria-hidden>❚❚</div>}
    </div>
  );
}
