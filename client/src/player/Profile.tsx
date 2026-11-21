// A guest's own profile on their phone: nickname and photo.

import { useEffect, useRef, useState } from "react";
import { NAME_MAX, type PublicPlayer } from "../../../shared/types";
import { prepareSelfie, uploadSelfie } from "../photo";
import { Avatar } from "../ui";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
}

/** A guest changes the name everyone sees. */
export function NameForm({ me, send, onDone }: { me: PublicPlayer; send: Send; onDone: () => void }) {
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="phone__card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await send("player.rename", { name });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="phone__title">Your nickname</h1>
      <p className="phone__muted">This is the name everyone sees: on the TV, the wheel and the leaderboard.</p>
      <label className="field">
        <span className="field__label">Nickname</span>
        <input className="input" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <ErrorText error={error} />
      <button className="btn btn--primary btn--block" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn btn--ghost btn--block" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Guest photo

export function PhotoStep({
  me,
  getToken,
  send,
  intro = false,
  onDone,
}: {
  me: PublicPlayer;
  getToken: () => string | null;
  send: Send;
  intro?: boolean;
  onDone?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const blob = await prepareSelfie(file);
      setPreview({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const upload = async () => {
    const token = getToken();
    if (!preview || !token) return;
    setBusy(true);
    setError(null);
    try {
      await uploadSelfie(preview.blob, token);
      setPreview(null);
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="photo-step">
      <h1 className="phone__title">{intro ? "Add your photo" : me.photo ? "Your photo" : "Add your photo"}</h1>
      <p>It flashes up on the TV when you're drawn, and shows on your team card.</p>
      {preview ? (
        <img className="photo-step__preview avatar--photo" src={preview.url} alt="Your new photo" />
      ) : (
        <Avatar player={me} className="photo-step__preview" />
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => choose(e.target.files?.[0])}
      />
      <div className="photo-step__actions">
        {preview ? (
          <>
            <button className="btn btn--primary btn--block" disabled={busy} onClick={upload}>
              {busy ? "Uploading…" : "Use this photo"}
            </button>
            <button className="btn btn--ghost btn--block" disabled={busy} onClick={() => input.current?.click()}>
              Try a different photo
            </button>
          </>
        ) : (
          <button className="btn btn--primary btn--block" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Getting your photo ready…" : me.photo ? "Take or choose a new photo" : "Take a selfie or choose a photo"}
          </button>
        )}
        {me.photo && !preview && (
          <button
            className="btn btn--ghost btn--block"
            disabled={busy}
            onClick={() => send("player.removePhoto").catch((e) => setError((e as Error).message))}
          >
            Remove my photo
          </button>
        )}
        {onDone && (
          <button className="btn btn--ghost btn--block" disabled={busy} onClick={onDone}>
            {me.photo ? "Done" : intro ? "Skip for now" : "Not now"}
          </button>
        )}
      </div>
      <ErrorText error={error} />
    </div>
  );
}
