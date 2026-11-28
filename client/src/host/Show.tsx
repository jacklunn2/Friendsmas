// Control-room panels for the show's extras (Block 4): the welcome screen,
// memories, the grand prize, the hall of fame and videos.

import { useEffect, useRef, useState } from "react";
import {
  CAPTION_MAX,
  MAX_MEMORIES,
  MAX_PAST_WINNERS,
  VIDEO_MAX_BYTES,
  VIDEO_TOTAL_MAX_BYTES,
  imageUrl,
  type ActivityView,
  type HostView,
} from "../../../shared/types";
import { uploadQuizImage } from "../image";
import { useTicker } from "../net";
import { formatClock } from "../ui";
import { formatBytes, uploadVideo } from "../video";
import type { Run } from "./Scoring";

export function WelcomePanel({ view, run }: { view: HostView; run: Run }) {
  const drafting = view.draw.phase === "draft";
  const onTv = view.stage.screen === "welcome" && !drafting;

  return (
    <section className="panel" aria-labelledby="welcome-h">
      <header className="panel__head">
        <h2 id="welcome-h" className="panel__title">
          Welcome screen
        </h2>
        {drafting ? (
          <span className="panel__meta">On the TV until the draw</span>
        ) : (
          <button className="btn btn--small btn--secondary" disabled={onTv} onClick={() => run("stage.show", { screen: "welcome" })}>
            {onTv ? "On the TV" : "Show on the TV"}
          </button>
        )}
      </header>
      <p className="host__muted">
        The TV shows "Friendsmas", the menu from everyone's questionnaire, the photo slideshow, the trophy and the QR code to join.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The grand prize and the hall of fame

/** A button that picks a picture, shrinks it and uploads it. */
function UploadButton({ label, onUploaded, disabled }: { label: string; onUploaded: (imageId: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="upload">
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            onUploaded(await uploadQuizImage(file));
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      <button className="btn btn--small btn--secondary" disabled={busy || disabled} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : label}
      </button>
      {error && <span className="form-error">{error}</span>}
    </span>
  );
}

export function PrizePanel({ view, run }: { view: HostView; run: Run }) {
  const { trophyImageId, pastWinners } = view.prize;
  const drawn = view.draw.phase === "complete";
  return (
    <section className="panel" aria-labelledby="prize-h">
      <header className="panel__head">
        <h2 id="prize-h" className="panel__title">
          The Grand Prize
        </h2>
      </header>
      <p className="host__muted">The trophy shows on the welcome screen and the intermission screen, and gets its own big moment before the finale.</p>
      <div className="prize-edit">
        {trophyImageId ? (
          <img className="prize-edit__trophy" src={imageUrl(trophyImageId, view.eventCode)} alt="The trophy" />
        ) : (
          <div className="prize-edit__trophy prize-edit__trophy--empty">🏆</div>
        )}
        <div className="row__actions prize-edit__actions">
          <UploadButton label={trophyImageId ? "Change the trophy photo" : "Add a trophy photo"} onUploaded={(imageId) => run("prize.trophy", { imageId }, "Trophy photo saved")} />
          {trophyImageId && (
            <button className="btn btn--small btn--ghost" onClick={() => confirm("Remove the trophy photo?") && run("prize.trophy", { imageId: null })}>
              Remove
            </button>
          )}
          <button
            className="btn btn--small btn--ghost btn--finale"
            disabled={!trophyImageId || !drawn || view.stage.screen === "prize"}
            title={drawn ? undefined : "Available once the teams are drawn"}
            onClick={() => run("stage.show", { screen: "prize" })}
          >
            {view.stage.screen === "prize" ? "On the TV" : "Show The Grand Prize on the TV"}
          </button>
        </div>
      </div>

      <div className="row">
        <h3 className="callout__title">Hall of fame ({pastWinners.length})</h3>
        <span className="row__actions">
          <UploadButton
            label="Add past winners"
            disabled={pastWinners.length >= MAX_PAST_WINNERS}
            onUploaded={(imageId) => run("prize.winner.add", { imageId, caption: "" }, "Photo added. Give it a caption.")}
          />
        </span>
      </div>
      {pastWinners.length > 0 ? (
        <ul className="plain-list winners-edit">
          {pastWinners.map((w, i) => (
            <li key={w.id} className="winners-edit__row">
              <img src={imageUrl(w.imageId, view.eventCode)} alt="" />
              <CaptionInput value={w.caption} onSave={(caption) => run("prize.winner.update", { id: w.id, caption })} />
              <span className="row__actions">
                <button className="btn btn--small btn--ghost" disabled={i === 0} onClick={() => run("prize.winner.move", { id: w.id, direction: "up" })} aria-label="Move up">
                  ↑
                </button>
                <button
                  className="btn btn--small btn--ghost"
                  disabled={i === pastWinners.length - 1}
                  onClick={() => run("prize.winner.move", { id: w.id, direction: "down" })}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button className="btn btn--small btn--ghost" onClick={() => confirm("Remove this photo?") && run("prize.winner.remove", { id: w.id })}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="host__muted">Add photos of past winners. They appear in the welcome screen slideshow, in a gold frame under "Hall of Fame".</p>
      )}
    </section>
  );
}

function CaptionInput({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="input input--small"
      value={text}
      maxLength={CAPTION_MAX}
      placeholder={placeholder ?? "e.g. 2025: The Sprouts (Ava & Ben)"}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

// ---------------------------------------------------------------------------
// Videos

export function VideosPanel({ view, run }: { view: HostView; run: Run }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const used = view.videos.reduce((n, v) => n + v.size, 0);
  const usedBy = (id: string) => view.activities.filter((a) => a.videoId === id).map((a) => a.name);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      await uploadVideo(file, setProgress);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="videos-h">
      <header className="panel__head">
        <h2 id="videos-h" className="panel__title">
          Videos
        </h2>
        <span className="panel__meta">
          {formatBytes(used)} of {formatBytes(VIDEO_TOTAL_MAX_BYTES)} used
        </span>
      </header>
      <p className="host__muted">
        Clips up to {Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} MB each (MP4 works best). Attach one to an activity and it plays on the TV, with sound, when the
        activity starts.
      </p>
      <div className="row__actions">
        <input ref={input} type="file" accept="video/mp4,video/webm,video/quicktime,.mov" hidden onChange={(e) => choose(e.target.files?.[0]).then(() => (e.target.value = ""))} />
        <button className="btn btn--small btn--secondary" disabled={progress !== null} onClick={() => input.current?.click()}>
          {progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : "Upload a video"}
        </button>
        {progress !== null && <progress className="upload-progress" value={progress} max={1} />}
      </div>
      {error && <p className="form-error">{error}</p>}
      {view.videos.length > 0 ? (
        <ul className="plain-list videos-edit">
          {view.videos.map((v) => (
            <li key={v.id} className="videos-edit__row">
              <span className="videos-edit__name">
                🎬 {v.name}
                <span className="host__muted">
                  {" "}
                  · {formatBytes(v.size)}
                  {v.durationMs ? ` · ${formatClock(v.durationMs)}` : ""}
                  {usedBy(v.id).length ? ` · opens ${usedBy(v.id).join(", ")}` : ""}
                </span>
              </span>
              <span className="row__actions">
                <button className="btn btn--small btn--secondary" onClick={() => run("video.play", { videoId: v.id })}>
                  Play on the TV
                </button>
                <button
                  className="btn btn--small btn--ghost"
                  onClick={() => {
                    const name = prompt("Name this video", v.name);
                    if (name && name !== v.name) run("video.rename", { id: v.id, name });
                  }}
                >
                  Rename
                </button>
                <button className="btn btn--small btn--ghost" onClick={() => confirm(`Delete ${v.name}?`) && run("video.delete", { id: v.id })}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="host__muted">No videos yet.</p>
      )}
    </section>
  );
}

/** Play, pause, restart and skip, shown at the top of the control room while a clip is on the TV. */
export function VideoBar({ view, run, serverNow }: { view: HostView; run: Run; serverNow: () => number }) {
  const pb = view.video;
  useTicker(500, !!pb?.playing);
  if (!pb) return null;
  const v = view.videos.find((x) => x.id === pb.videoId);
  const at = pb.playing ? pb.positionMs + (serverNow() - pb.since) : pb.positionMs;
  return (
    <div className="video-bar" role="region" aria-label="Video on the TV">
      <span className="video-bar__title">
        🎬 On the TV: <strong>{v?.name ?? "Video"}</strong>
        <span className="host__muted">
          {" "}
          {formatClock(at)}
          {v?.durationMs ? ` / ${formatClock(v.durationMs)}` : ""}
        </span>
      </span>
      <span className="row__actions">
        {pb.playing ? (
          <button className="btn btn--small btn--secondary" onClick={() => run("video.pause")}>
            ❚❚ Pause
          </button>
        ) : (
          <button className="btn btn--small btn--secondary" onClick={() => run("video.resume")}>
            ▶ Play
          </button>
        )}
        <button className="btn btn--small btn--ghost" onClick={() => run("video.restart")}>
          ↺ From the start
        </button>
        <button className="btn btn--small btn--primary" onClick={() => run("video.skip")}>
          Skip ⏭
        </button>
      </span>
    </div>
  );
}

/** Chooses the clip that opens an activity. */
export function ActivityVideoPicker({ activity, view, run }: { activity: ActivityView; view: HostView; run: Run }) {
  if (!view.videos.length && !activity.videoId) return null;
  return (
    <label className="field field--inline video-pick">
      <span className="field__label">Opening video</span>
      <select
        className="input input--small"
        value={activity.videoId ?? ""}
        onChange={(e) => run("activity.video", { activityId: activity.id, videoId: e.target.value || null })}
      >
        <option value="">None</option>
        {view.videos.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Friendsmas memories: past photos for the welcome screen slideshow

export function MemoriesPanel({ view, run }: { view: HostView; run: Run }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memories = view.memories;
  const room = MAX_MEMORIES - memories.length;

  const upload = async (files: File[]) => {
    const list = files.slice(0, room);
    setError(files.length > room ? `Only ${room} more photos fit, so the rest were skipped.` : null);
    setProgress({ done: 0, total: list.length });
    const failed: string[] = [];
    for (const [i, file] of list.entries()) {
      try {
        const imageId = await uploadQuizImage(file);
        await run("memories.add", { imageId, caption: "" });
      } catch {
        failed.push(file.name);
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setProgress(null);
    if (failed.length) setError(`Couldn't add ${failed.join(", ")}. Try a JPEG or PNG.`);
  };

  return (
    <section className="panel" aria-labelledby="memories-h">
      <header className="panel__head">
        <h2 id="memories-h" className="panel__title">
          Friendsmas memories
        </h2>
        <span className="panel__meta">
          {memories.length} of {MAX_MEMORIES} photos
        </span>
      </header>
      <p className="host__muted">
        Photos from past Friendsmases. The welcome screen takes turns between the menu and a slideshow of these. Captions are optional.
      </p>
      <div className="row__actions">
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) upload(files);
          }}
        />
        <button className="btn btn--small btn--secondary" disabled={!!progress || room <= 0} onClick={() => input.current?.click()}>
          {progress ? `Uploading ${progress.done} of ${progress.total}…` : "Add photos"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {memories.length > 0 ? (
        <ul className="plain-list memories-edit">
          {memories.map((m, i) => (
            <li key={m.id} className="winners-edit__row">
              <img src={imageUrl(m.imageId, view.eventCode)} alt="" />
              <CaptionInput value={m.caption} placeholder="e.g. The great pavlova collapse, 2024" onSave={(caption) => run("memories.update", { id: m.id, caption })} />
              <span className="row__actions">
                <button className="btn btn--small btn--ghost" disabled={i === 0} onClick={() => run("memories.move", { id: m.id, direction: "up" })} aria-label="Move up">
                  ↑
                </button>
                <button
                  className="btn btn--small btn--ghost"
                  disabled={i === memories.length - 1}
                  onClick={() => run("memories.move", { id: m.id, direction: "down" })}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button className="btn btn--small btn--ghost" onClick={() => confirm("Remove this photo?") && run("memories.remove", { id: m.id })}>
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="host__muted">No photos yet.</p>
      )}
    </section>
  );
}
