import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MOTTO_MAX, NAME_MAX, SPIN_MS, FINAL_REVEAL_MS, teamDisplayName, type PlayerView, type PublicPlayer } from "../../../shared/types";
import { storage, useRoom, useTicker } from "../net";
import { prepareSelfie, uploadSelfie } from "../photo";
import { Avatar, AvatarPicker, ConnectionBanner, EventCodeContext, formatClock, playerMap, TeamCard, teamStyle, Wordmark } from "../ui";

export function PlayerApp({ code }: { code: string }) {
  const tokenStore = useMemo(() => storage(`fm.player.${code}`), [code]);
  const { view, status, unauthorized, send, serverNow } = useRoom<PlayerView>({
    role: "player",
    code,
    getToken: tokenStore.get,
    onWelcome: (token) => tokenStore.set(token),
  });

  // If the host unlinked this phone, forget the old token.
  useEffect(() => {
    if (view && !view.me && tokenStore.get()) tokenStore.set(null);
  }, [view, tokenStore]);

  if (unauthorized) {
    return (
      <Shell>
        <h1 className="phone__title">Hmm, that link didn't work</h1>
        <p>{unauthorized}</p>
      </Shell>
    );
  }
  if (!view) {
    return (
      <Shell>
        <p className="phone__muted">Connecting…</p>
      </Shell>
    );
  }

  return (
    <EventCodeContext.Provider value={code}>
      <Shell>
        <ConnectionBanner status={status} />
        {!view.me ? (
          <Join view={view} send={send} />
        ) : view.me.status === "pending" ? (
          <>
            <Waiting title={`Hi ${view.me.name} ${view.me.emoji}`} body="The host will let you in shortly. Keep this page open." />
            <section className="phone__card">
              <PhotoStep me={view.me} getToken={tokenStore.get} send={send} />
            </section>
          </>
        ) : (
          <InGame view={view} send={send} serverNow={serverNow} getToken={tokenStore.get} code={code} />
        )}
      </Shell>
    </EventCodeContext.Provider>
  );
}

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="phone">
      <Wordmark className="wordmark--phone" />
      {children}
    </main>
  );
}

function Waiting({ title, body }: { title: string; body: string }) {
  return (
    <section className="phone__card">
      <h1 className="phone__title">{title}</h1>
      <p>{body}</p>
    </section>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Joining

function Join({ view, send }: { view: PlayerView; send: Send }) {
  const [mode, setMode] = useState<"list" | "new" | "code">(view.claimable.length ? "list" : "new");
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [emoji, setEmoji] = useState("🎅");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await send(action, payload);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (chosen || mode === "new") {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (chosen) run("player.claim", { playerId: chosen.id, emoji });
      else run("player.joinNew", { name, emoji });
    };
    return (
      <form className="phone__card" onSubmit={submit}>
        {chosen ? (
          <h1 className="phone__title">Hi {chosen.name}! Pick your avatar</h1>
        ) : (
          <>
            <h1 className="phone__title">Join with a nickname</h1>
            <label className="field">
              <span className="field__label">Your name</span>
              <input
                className="input"
                value={name}
                maxLength={NAME_MAX}
                autoComplete="given-name"
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <p className="phone__muted">The host will approve you before you appear.</p>
            <span className="field__label">Your avatar</span>
          </>
        )}
        <AvatarPicker value={emoji} onChange={setEmoji} />
        <ErrorText error={error} />
        <button className="btn btn--primary btn--block" disabled={busy || (!chosen && !name.trim())}>
          {busy ? "Joining…" : `Join as ${emoji}`}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--block"
          onClick={() => {
            setChosen(null);
            setMode("list");
            setError(null);
          }}
        >
          Back
        </button>
      </form>
    );
  }

  if (mode === "code") {
    return (
      <form
        className="phone__card"
        onSubmit={(e) => {
          e.preventDefault();
          run("player.rejoin", { code });
        }}
      >
        <h1 className="phone__title">Rejoin on this phone</h1>
        <p>Ask the host for a 4-digit rejoin code.</p>
        <label className="field">
          <span className="field__label">Rejoin code</span>
          <input
            className="input input--code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
          />
        </label>
        <ErrorText error={error} />
        <button className="btn btn--primary btn--block" disabled={busy || code.length !== 4}>
          Rejoin
        </button>
        <button type="button" className="btn btn--ghost btn--block" onClick={() => setMode("list")}>
          Back
        </button>
      </form>
    );
  }

  return (
    <section className="phone__card">
      <h1 className="phone__title">Who are you?</h1>
      {view.claimable.length ? (
        <ul className="name-list">
          {view.claimable.map((c) => (
            <li key={c.id}>
              <button className="name-list__item" onClick={() => setChosen(c)}>
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>Everyone on the guest list has joined.</p>
      )}
      <div className="phone__alt">
        <button className="btn btn--ghost" onClick={() => setMode("new")}>
          I'm not on the list
        </button>
        <button className="btn btn--ghost" onClick={() => setMode("code")}>
          I have a rejoin code
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// In the game

interface InGameProps {
  view: PlayerView;
  send: Send;
  serverNow: () => number;
  getToken: () => string | null;
  code: string;
}

function InGame({ view, send, serverNow, getToken, code }: InGameProps) {
  const me = view.me!;
  // Guests are asked for a photo straight after joining; "Skip for now" is remembered.
  const skipStore = useMemo(() => storage(`fm.photoSkipped.${code}`), [code]);
  const [skipped, setSkipped] = useState(() => skipStore.get() === "1");
  const [photoOpen, setPhotoOpen] = useState(false);
  const photoPanel = (intro: boolean) => (
    <section className="phone__card">
      <PhotoStep
        me={me}
        getToken={getToken}
        send={send}
        intro={intro}
        onDone={() => {
          skipStore.set("1");
          setSkipped(true);
          setPhotoOpen(false);
        }}
      />
    </section>
  );
  const photoButton = (
    <button className="btn btn--ghost btn--small photo-link" onClick={() => setPhotoOpen(true)}>
      {me.photo ? "Change your photo" : "Add your photo"}
    </button>
  );
  const players = useMemo(() => playerMap(view.players), [view.players]);

  // Phones wait for the wheel on the TV to stop before showing a result.
  // Once on a team, only reveals that touch that team cause a pause.
  const [holdUntil, setHoldUntil] = useState(0);
  const lastStep = useRef<number | null>(null);
  const prevTeamId = useRef<string | null>(me.teamId);
  useEffect(() => {
    const step = view.draw.step;
    const ev = view.draw.lastEvent;
    if (lastStep.current !== null && step === lastStep.current + 1 && ev) {
      const involved = !prevTeamId.current || ev.playerIds.includes(me.id) || ev.teamId === prevTeamId.current;
      if (involved) setHoldUntil(Date.now() + (ev.final ? FINAL_REVEAL_MS - 400 : SPIN_MS - 3000));
    }
    lastStep.current = step;
    prevTeamId.current = me.teamId;
  }, [view.draw.step, view.draw.lastEvent, me.id, me.teamId]);
  const now = useTicker(250, holdUntil > Date.now());
  const holding = holdUntil > now;

  // Buzz when this phone's owner is drawn.
  const wasOnTeam = useRef(!!me.teamId);
  useEffect(() => {
    if (!holding && me.teamId && !wasOnTeam.current) {
      wasOnTeam.current = true;
      navigator.vibrate?.([120, 80, 120, 80, 300]);
    }
    if (!me.teamId) wasOnTeam.current = false;
  }, [holding, me.teamId]);

  const { phase, hidden } = view.draw;

  if (view.intermission) return <Waiting title="Short break" body="We'll be back in a moment." />;

  if (phase === "draft") {
    if ((!me.photo && !skipped) || photoOpen) return photoPanel(!me.photo && !skipped);
    const joined = view.players.filter((p) => p.status === "joined");
    return (
      <section className="phone__card">
        <h1 className="phone__title">You're in, {me.name}</h1>
        <p>The team draw starts soon. Keep this page open, and watch the TV.</p>
        <h2 className="phone__subtitle">{joined.length} here so far</h2>
        <ul className="chip-list">
          {joined.map((p) => (
            <li key={p.id} className="chip">
              <Avatar player={p} /> {p.name}
            </li>
          ))}
        </ul>
        {photoButton}
      </section>
    );
  }

  if (photoOpen) return photoPanel(false);

  if ((phase === "locked" || phase === "revealing") && hidden) {
    return <Waiting title="Eyes on the TV" body="Teams are being drawn. You'll see yours here when the draw is complete." />;
  }

  if (holding) {
    return (
      <section className="phone__card phone__card--centre">
        <p className="spinning-dot" aria-hidden>
          🎡
        </p>
        <h1 className="phone__title">The wheel is spinning…</h1>
      </section>
    );
  }

  const team = view.myTeam;
  if (!team) {
    if (phase === "complete") {
      return <Waiting title="Almost there" body="The host will add you to a team in a moment." />;
    }
    const left = view.draw.pool.length;
    return (
      <section className="phone__card phone__card--centre">
        <h1 className="phone__title">Not drawn yet</h1>
        <p>{left} names left on the wheel. Watch the TV!</p>
      </section>
    );
  }

  const partners = team.memberIds.filter((id) => id !== me.id).map((id) => players.get(id)!).filter(Boolean);
  const stillToCome = team.memberCount - team.memberIds.length;

  return (
    <section className="phone__team" style={teamStyle(team)}>
      <p className="phone__kicker">
        {team.badge} You're on {teamDisplayName(team)}
      </p>
      <h1 className="phone__title phone__title--team">
        {partners.length ? `With ${partners.map((p) => p.name).join(" and ")}` : "Your partner is still on the wheel…"}
      </h1>
      {stillToCome > 0 && partners.length > 0 && <p>One more teammate to come.</p>}
      {phase === "complete" && <Naming view={view} send={send} serverNow={serverNow} />}
      <TeamCard team={team} players={players} showSeats />
      {photoButton}
    </section>
  );
}

function Naming({ view, send, serverNow }: { view: PlayerView; send: Send; serverNow: () => number }) {
  const team = view.myTeam!;
  const open = view.naming.phase === "open";
  useTicker(500, open);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [motto, setMotto] = useState(team.motto);
  const [mottoSaved, setMottoSaved] = useState(false);

  const run = async (action: string, payload?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await send(action, payload);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open && !team.name) return null;

  return (
    <div className="naming">
      {open && !team.name && (
        <>
          <div className="naming__head">
            <h2 className="phone__subtitle">Choose your team name</h2>
            <span className="naming__clock">{formatClock((view.naming.deadline ?? 0) - serverNow())}</span>
          </div>
          <p className="phone__muted">Either of you can choose. If time runs out, you get the first one.</p>
          <div className="naming__options">
            {team.suggestions.map((s) => (
              <button key={s} className="naming__option" disabled={busy} onClick={() => run("team.pick", { name: s })}>
                {s}
              </button>
            ))}
          </div>
          {!team.rerollUsed && (
            <button className="btn btn--ghost btn--block" disabled={busy} onClick={() => run("team.reroll")}>
              Show three different names (one try only)
            </button>
          )}
        </>
      )}
      {team.name && (
        <form
          className="naming__motto"
          onSubmit={async (e) => {
            e.preventDefault();
            await run("team.motto", { motto });
            setMottoSaved(true);
          }}
        >
          <label className="field">
            <span className="field__label">Team motto (optional)</span>
            <input
              className="input"
              value={motto}
              maxLength={MOTTO_MAX}
              placeholder="Sleigh first, ask questions later"
              onChange={(e) => {
                setMotto(e.target.value);
                setMottoSaved(false);
              }}
            />
          </label>
          <button className="btn btn--secondary" disabled={busy || motto === team.motto}>
            {mottoSaved && motto === team.motto ? "Motto saved" : "Save motto"}
          </button>
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Guest photo

function PhotoStep({
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
