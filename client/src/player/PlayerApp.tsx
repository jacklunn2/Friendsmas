import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  EVENT_DATE,
  EVENT_DATE_LABEL,
  FINAL_REVEAL_MS,
  TEAM_NAME_MAX,
  NAME_MAX,
  SPIN_MS,
  formatPoints,
  placeLabel,
  scoringSummary,
  teamDisplayName,
  type PlayerView,
  type PublicPlayer,
} from "../../../shared/types";
import { revealDurationMs } from "../timing";
import { PhonePoll } from "./PhonePoll";
import { PhoneQuiz } from "./PhoneQuiz";
import { MissionLayer } from "./Mission";
import { QuestionnaireForm } from "./Questionnaire";
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
          <Prep view={view} send={send} getToken={tokenStore.get} code={code} pending />
        ) : (
          <>
            <InGame view={view} send={send} serverNow={serverNow} getToken={tokenStore.get} code={code} />
            {view.myMission && <MissionLayer mission={view.myMission} send={send} />}
          </>
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
// Before the day: questionnaire, photo, then "you're all set"

/** True until the morning of the event, in the guest's own time zone. */
function beforeEventDay(): boolean {
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  return today < EVENT_DATE;
}

/** "Skip for now" on the photo step, remembered on this phone. */
function usePhotoSkip(code: string): [boolean, () => void] {
  const store = useMemo(() => storage(`fm.photoSkipped.${code}`), [code]);
  const [skipped, setSkipped] = useState(() => store.get() === "1");
  return [
    skipped,
    () => {
      store.set("1");
      setSkipped(true);
    },
  ];
}

/** For guests waiting for the host to let them in: the same questionnaire → photo → thank you. */
function Prep({ view, send, getToken, code, pending }: { view: PlayerView; send: Send; getToken: () => string | null; code: string; pending?: boolean }) {
  const me = view.me!;
  const [skipped, skip] = usePhotoSkip(code);
  const [questOpen, setQuestOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  if (questOpen || !view.myQuestionnaire) {
    return <QuestionnaireForm name={me.name} existing={view.myQuestionnaire} send={send} onDone={() => setQuestOpen(false)} />;
  }
  if (photoOpen || (!me.photo && !skipped)) {
    return (
      <section className="phone__card">
        <PhotoStep
          me={me}
          getToken={getToken}
          send={send}
          intro={!me.photo && !skipped}
          onDone={() => {
            skip();
            setPhotoOpen(false);
          }}
        />
      </section>
    );
  }
  return <AllSet view={view} pending={pending} onAnswers={() => setQuestOpen(true)} onPhoto={() => setPhotoOpen(true)} />;
}

function AllSet({ view, pending, onAnswers, onPhoto }: { view: PlayerView; pending?: boolean; onAnswers: () => void; onPhoto: () => void }) {
  const me = view.me!;
  const q = view.myQuestionnaire;
  const early = beforeEventDay();
  return (
    <section className="phone__card all-set">
      <p className="all-set__icon" aria-hidden>
        🎄
      </p>
      <h1 className="phone__title">Thank you, {me.name}!</h1>
      <p>Your answers are in.</p>
      <div className="all-set__card">
        <Avatar player={me} className="all-set__photo" />
        <div>
          {q && (
            <p>
              Bringing <strong>{q.dish}</strong> <span className="phone__muted">({q.category === "other" ? "other" : q.category === "drinks" ? "drinks" : q.category})</span>
            </p>
          )}
          <p className="phone__muted">
            {q?.facts.length ?? 0} secret {q?.facts.length === 1 ? "fact" : "facts"} · {me.photo ? "photo added" : "no photo yet"}
          </p>
        </div>
      </div>
      {pending && <p>Your name wasn't on the guest list, so the host will confirm your spot. Nothing else to do.</p>}
      {early ? (
        <p>
          <strong>You can close this page.</strong> See you on {EVENT_DATE_LABEL}! On the day, open this same link on this phone, or scan the QR code on the TV,
          and you'll go straight in.
        </p>
      ) : (
        <p>{pending ? "Hang tight: the host will let you in shortly." : "You're all set. Keep this page open and watch the TV."}</p>
      )}
      <div className="phone__links">
        <button className="btn btn--ghost btn--small" onClick={onAnswers}>
          Change my answers
        </button>
        <button className="btn btn--ghost btn--small" onClick={onPhoto}>
          {me.photo ? "Change my photo" : "Add my photo"}
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
  const [skipped, skip] = usePhotoSkip(code);
  const [photoOpen, setPhotoOpen] = useState(false);
  const photoPanel = (intro: boolean) => (
    <section className="phone__card">
      <PhotoStep
        me={me}
        getToken={getToken}
        send={send}
        intro={intro}
        onDone={() => {
          skip();
          setPhotoOpen(false);
        }}
      />
    </section>
  );
  const [questOpen, setQuestOpen] = useState(false);
  const photoButton = (
    <div className="phone__links">
      <button className="btn btn--ghost btn--small photo-link" onClick={() => setPhotoOpen(true)}>
        {me.photo ? "Change your photo" : "Add your photo"}
      </button>
      <button className="btn btn--ghost btn--small photo-link" onClick={() => setQuestOpen(true)}>
        {view.myQuestionnaire ? "Your food and facts" : "Answer the questions"}
      </button>
    </div>
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

  // Guests who haven't done the questionnaire are asked to finish it first,
  // unless the draw or a quiz is happening right now.
  const busyMoment = phase === "locked" || phase === "revealing" || holding || (phase === "complete" && (view.stage.screen === "quiz" || view.stage.screen === "poll"));
  if (questOpen || (!view.myQuestionnaire && !busyMoment)) {
    return (
      <QuestionnaireForm
        name={me.name}
        existing={view.myQuestionnaire}
        send={send}
        onDone={() => setQuestOpen(false)}
      />
    );
  }

  if (view.intermission) return <Waiting title="Short break" body="We'll be back in a moment." />;

  if (phase === "draft") {
    if ((!me.photo && !skipped) || photoOpen) return photoPanel(!me.photo && !skipped);
    // Before the day, there's nothing to wait for: thank them and let them go.
    if (beforeEventDay()) {
      return <AllSet view={view} onAnswers={() => setQuestOpen(true)} onPhoto={() => setPhotoOpen(true)} />;
    }
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
      {view.video && <p className="phone__tv">📺 Eyes on the TV</p>}
      {phase === "complete" && <NowPlaying view={view} serverNow={serverNow} />}
      {phase === "complete" && view.stage.screen === "quiz" && <PhoneQuiz view={view} send={send} serverNow={serverNow} />}
      {phase === "complete" && view.stage.screen === "poll" && <PhonePoll view={view} send={send} serverNow={serverNow} />}
      <p className="phone__kicker">
        {team.badge} You're on {teamDisplayName(team)}
      </p>
      <h1 className="phone__title phone__title--team">
        {partners.length ? `With ${partners.map((p) => p.name).join(" and ")}` : "Your partner is still on the wheel…"}
      </h1>
      {stillToCome > 0 && partners.length > 0 && <p>One more teammate to come.</p>}
      {phase === "complete" && <Naming view={view} send={send} serverNow={serverNow} />}
      {phase === "complete" && <MyStandings view={view} serverNow={serverNow} />}
      <TeamCard team={team} players={players} showSeats />
      {photoButton}
    </section>
  );
}

/** The activity on the TV right now, with its timer. */
function NowPlaying({ view, serverNow }: { view: PlayerView; serverNow: () => number }) {
  const a = view.stage.screen === "activity" ? view.activities.find((x) => x.id === view.stage.activityId) : undefined;
  const timer = view.stage.timer;
  useTicker(500, !!timer?.endsAt);

  // A short buzz when a new game starts, so guests look at their phones.
  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (a && a.id !== lastId.current) navigator.vibrate?.(150);
    lastId.current = a?.id ?? null;
  }, [a]);

  if (!a) return null;
  const me = view.me!;
  const partners = (view.myTeam?.memberIds ?? []).filter((id) => id !== me.id).map((id) => view.players.find((p) => p.id === id)?.name).filter(Boolean);
  const left = timer ? (timer.endsAt ? timer.endsAt - serverNow() : (timer.remainingMs ?? timer.durationMs)) : null;
  return (
    <article className="now-playing" aria-labelledby="now-playing-name">
      <div className="now-playing__head">
        <span className="now-playing__kicker">Now playing</span>
        {left !== null && <span className="naming__clock">{left > 0 ? formatClock(left) : "Time's up"}</span>}
      </div>
      <h2 id="now-playing-name" className="now-playing__name">
        {a.name}
      </h2>
      <p className="now-playing__who">
        {a.kind === "team"
          ? partners.length
            ? `Team game: you play with ${partners.join(" and ")}`
            : "Team game"
          : "Individual game: you play on your own, for your team"}
      </p>
      {a.description ? (
        <div className="now-playing__desc">{a.description}</div>
      ) : (
        <p className="phone__muted">The host will explain how to play.</p>
      )}
      <p className="now-playing__scoring">
        <span className="phone__muted">Scoring:</span> {scoringSummary(a)}
      </p>
    </article>
  );
}

/** The team's place and points from the last reveal, held back until the TV has shown it. */
function MyStandings({ view, serverNow }: { view: PlayerView; serverNow: () => number }) {
  const st = view.standings;
  const team = view.myTeam!;
  const doneAt = st ? st.at + revealDurationMs(st.rows.length, st.final) : 0;
  const waiting = !!st && serverNow() < doneAt;
  useTicker(500, waiting);
  // The previous reveal isn't sent, so while the TV reveals, ask guests to watch.
  if (!st) return null;
  if (waiting) {
    return (
      <div className="standings-card standings-card--wait">
        <p className="now-playing__name">{st.final ? "The final results are on the TV!" : "The leaderboard is on the TV!"}</p>
      </div>
    );
  }
  const mine = st.rows.find((r) => r.teamId === team.id);
  const teams = new Map(view.teams.map((t) => [t.id, t]));
  const winners = st.rows.filter((r) => r.rank === 1).map((r) => teams.get(r.teamId)).filter(Boolean);
  const won = mine?.rank === 1;
  return (
    <div className={`standings-card${st.final && won ? " is-winner" : ""}`}>
      {st.final ? (
        <p className="standings-card__headline">
          {won
            ? winners.length > 1
              ? "🏆 You tied for first!"
              : "🏆 Your team won Friendsmas!"
            : `${winners.map((t) => teamDisplayName(t!)).join(" and ")} ${winners.length > 1 ? "tied for first" : "won"}. You finished ${mine ? placeLabel(mine) : "–"}.`}
        </p>
      ) : (
        mine && (
          <p className="standings-card__headline">
            Your team is {placeLabel(mine)} with {formatPoints(mine.points)}
          </p>
        )
      )}
      {mine && mine.points > 0 && (
        <p className="phone__muted">
          You've earned {view.myPoints} of your team's {mine.points}.
        </p>
      )}
      {view.blackout && !st.final && <p className="phone__muted">The leaderboard is frozen until the finale.</p>}
      <ol className="standings-card__list">
        {st.rows.map((r) => {
          const t = teams.get(r.teamId);
          if (!t) return null;
          return (
            <li key={r.teamId} className={`standings-card__row${r.teamId === team.id ? " is-mine" : ""}`} style={teamStyle(t)}>
              <span className="standings-card__place">{placeLabel(r)}</span>
              <span className="standings-card__team">
                {t.badge} {teamDisplayName(t)}
              </span>
              <span className="standings-card__pts">{r.points}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Naming({ view, send, serverNow }: { view: PlayerView; send: Send; serverNow: () => number }) {
  const team = view.myTeam!;
  const open = view.naming.phase === "open";
  const canType = open || team.canRename;
  useTicker(500, open);
  const [name, setName] = useState(team.name ?? "");
  const [editing, setEditing] = useState(!team.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the box in step when a teammate (or the host) changes the name.
  useEffect(() => {
    if (!editing) setName(team.name ?? "");
    if (!team.name) setEditing(true);
  }, [team.name, editing]);

  if (!canType) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await send("team.name", { name });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="naming">
      <div className="naming__head">
        <h2 className="phone__subtitle">{team.canRename ? "Choose a new team name" : "Name your team"}</h2>
        {open && <span className="naming__clock">{formatClock((view.naming.deadline ?? 0) - serverNow())}</span>}
      </div>
      {team.canRename && <p className="phone__muted">The host asked for a different name.</p>}
      {team.name && !editing ? (
        <>
          <p className="naming__chosen">{team.name}</p>
          <p className="phone__muted">Either of you can change it until time's up.</p>
          <button className="btn btn--ghost btn--block" onClick={() => setEditing(true)}>
            Change the name
          </button>
        </>
      ) : (
        <form className="naming__form" onSubmit={submit}>
          <input
            className="input naming__input"
            value={name}
            maxLength={TEAM_NAME_MAX}
            autoCapitalize="words"
            autoComplete="off"
            placeholder="Your team name"
            aria-label="Team name"
            onChange={(e) => setName(e.target.value)}
          />
          <div className="naming__row">
            <span className="phone__muted">{TEAM_NAME_MAX - name.length} characters left</span>
            <button className="btn btn--primary" disabled={busy || !name.trim()}>
              {team.name ? "Save" : "Use this name"}
            </button>
          </div>
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
