// Control-room panels for the show's extras (Block 4): the welcome screen's
// agenda, and later the grand prize, the hall of fame and videos.

import { useEffect, useRef, useState } from "react";
import {
  AGENDA_ITEM_MAX,
  AGENDA_MAX_ITEMS,
  AGENDA_TIME_MAX,
  CAPTION_MAX,
  MAX_PAST_WINNERS,
  imageUrl,
  type AgendaItem,
  type HostView,
} from "../../../shared/types";
import { uploadQuizImage } from "../image";
import type { Run } from "./Scoring";

export function WelcomePanel({ view, run }: { view: HostView; run: Run }) {
  const [rows, setRows] = useState<AgendaItem[]>(view.agenda);
  const [dirty, setDirty] = useState(false);
  // Pick up saves from elsewhere unless there are unsaved edits here.
  useEffect(() => {
    if (!dirty) setRows(view.agenda);
  }, [view.agenda, dirty]);

  const edit = (next: AgendaItem[]) => {
    setRows(next);
    setDirty(true);
  };
  const save = async () => {
    const ok = await run("agenda.save", { items: rows }, "Agenda saved");
    if (ok) setDirty(false);
  };
  const move = (i: number, d: number) => {
    const next = rows.slice();
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r);
    edit(next);
  };
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
        The TV shows the menu from everyone's questionnaire, this agenda, the trophy and the QR code to join.
      </p>
      <div className="agenda-edit">
        {rows.map((r, i) => (
          <div key={r.id || `new-${i}`} className="agenda-edit__row">
            <input
              className="input input--small agenda-edit__time"
              aria-label={`Time for item ${i + 1}`}
              placeholder="12:00"
              maxLength={AGENDA_TIME_MAX}
              value={r.time}
              onChange={(e) => edit(rows.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
            />
            <input
              className="input input--small"
              aria-label={`Item ${i + 1}`}
              placeholder="What's happening"
              maxLength={AGENDA_ITEM_MAX}
              value={r.item}
              onChange={(e) => edit(rows.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))}
            />
            <span className="row__actions">
              <button className="btn btn--small btn--ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button className="btn btn--small btn--ghost" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                ↓
              </button>
              <button className="btn btn--small btn--ghost" onClick={() => edit(rows.filter((_, j) => j !== i))} aria-label="Delete">
                ✕
              </button>
            </span>
          </div>
        ))}
        {!rows.length && <p className="host__muted">No agenda yet. Add the first item.</p>}
      </div>
      <div className="row__actions">
        <button
          className="btn btn--small btn--ghost"
          disabled={rows.length >= AGENDA_MAX_ITEMS}
          onClick={() => edit([...rows, { id: "", time: "", item: "" }])}
        >
          Add an item
        </button>
        <button className="btn btn--small btn--primary" disabled={!dirty} onClick={save}>
          Save the agenda
        </button>
        {dirty && (
          <button className="btn btn--small btn--ghost" onClick={() => setDirty(false)}>
            Discard changes
          </button>
        )}
      </div>
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
          <button
            className="btn btn--small btn--ghost"
            disabled={!pastWinners.length || !drawn || view.stage.screen === "gallery"}
            onClick={() => run("stage.show", { screen: "gallery" })}
          >
            {view.stage.screen === "gallery" ? "On the TV" : "Show on the TV"}
          </button>
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
        <p className="host__muted">Add photos of past winners for a slideshow of wanted posters on the TV.</p>
      )}
    </section>
  );
}

function CaptionInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="input input--small"
      value={text}
      maxLength={CAPTION_MAX}
      placeholder="e.g. 2025: The Sprouts (Ava & Ben)"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}
