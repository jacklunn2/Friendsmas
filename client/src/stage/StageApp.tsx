import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { FINAL_REVEAL_MS, SPIN_MS, teamDisplayName, type RevealEventView, type StageView } from "../../../shared/types";
import { audioOn, enableAudio, sfx } from "../audio";
import { storage, useRoom, useTicker } from "../net";
import { Avatar, ConnectionBanner, EventCodeContext, formatClock, playerMap, TeamCard, teamStyle, Wordmark } from "../ui";
import { QuizStage } from "./QuizStage";
import { ActivityIntro, ActivityResults, Standings } from "./Scoreboard";
import { Wheel } from "./Wheel";

// Timing of one reveal inside the server's spin cooldown.
const CELEBRATE_MS = 2600;
const WHEEL_MS = SPIN_MS - CELEBRATE_MS - 600;
const FINAL_MS = FINAL_REVEAL_MS - 400;

type Anim =
  | { kind: "spin"; event: RevealEventView; phase: "spinning" | "landed" }
  | { kind: "final"; event: RevealEventView };

export function StageApp({ code }: { code: string }) {
  // On the host's laptop the control-room sign-in is shared, which lets
  // the wheel itself be clicked to spin. Guests' browsers don't have it.
  const getToken = useCallback(() => storage("fm.hostToken").get(), []);
  const { view, status, unauthorized, serverNow, send } = useRoom<StageView>({ role: "stage", code, getToken });
  const [started, setStarted] = useState(false);

  // The stage plays each reveal before showing the new state, so the TV
  // always shows the wheel landing before the team card fills in.
  const [shown, setShown] = useState<StageView | null>(null);
  const [anim, setAnim] = useState<Anim | null>(null);
  const latest = useRef<StageView | null>(null);
  const shownRef = useRef<StageView | null>(null);
  shownRef.current = shown;
  const animRef = useRef<Anim | null>(null);
  animRef.current = anim;

  const apply = useCallback((next: StageView) => {
    const prev = shownRef.current;
    const ev = next.draw.lastEvent;
    if (prev && ev && next.draw.step === prev.draw.step + 1 && prev.draw.phase !== "draft") {
      if (ev.final) {
        setAnim({ kind: "final", event: ev });
        if (audioOn()) sfx.drumroll(FINAL_MS / 1000 - 1.2);
      } else {
        setAnim({ kind: "spin", event: ev, phase: "spinning" });
      }
      return;
    }
    setShown(next);
  }, []);

  useEffect(() => {
    if (!view) return;
    latest.current = view;
    if (!animRef.current) apply(view);
  }, [view, apply]);

  const finishAnim = useCallback(() => {
    setAnim(null);
    const next = latest.current;
    if (!next) return;
    setShown(next);
    // If more steps arrived during the animation (rare), jump straight to them.
  }, []);

  // Final reveal and post-landing celebration timers.
  useEffect(() => {
    if (!anim) return;
    if (anim.kind === "final") {
      const t1 = setTimeout(() => audioOn() && sfx.finale(), FINAL_MS - 1300);
      const t2 = setTimeout(finishAnim, FINAL_MS);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
    if (anim.phase === "landed") {
      const t = setTimeout(finishAnim, CELEBRATE_MS);
      return () => clearTimeout(t);
    }
  }, [anim, finishAnim]);

  // Joining chime.
  const joinedCount = shown?.players.filter((p) => p.status === "joined").length ?? 0;
  const prevJoined = useRef(joinedCount);
  useEffect(() => {
    if (joinedCount > prevJoined.current && audioOn()) sfx.chime();
    prevJoined.current = joinedCount;
  }, [joinedCount]);

  const canSpinNow =
    !!shown?.canSpin && !anim && (shown.draw.phase === "locked" || shown.draw.phase === "revealing") && !shown.intermission;
  const spinNow = useCallback(() => {
    const step = latest.current?.draw.step;
    if (step === undefined) return;
    send("draw.spin", { expectedStep: step }).catch(() => {});
  }, [send]);

  // A presentation clicker or the keyboard can spin too.
  useEffect(() => {
    if (!canSpinNow || !started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        spinNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSpinNow, started, spinNow]);

  const start = async () => {
    await enableAudio();
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // fullscreen is optional
    }
    setStarted(true);
  };

  if (unauthorized) {
    return (
      <main className="stage stage--message">
        <Wordmark className="wordmark--stage" />
        <p className="stage__lede">{unauthorized}</p>
      </main>
    );
  }

  if (!shown) {
    return (
      <main className="stage stage--message">
        <Wordmark className="wordmark--stage" />
        <p className="stage__lede">Setting the stage…</p>
      </main>
    );
  }

  return (
    <EventCodeContext.Provider value={shown.eventCode}>
    <main className="stage">
      <ConnectionBanner status={status} />
      {!started && (
        <button className="stage-start" onClick={start}>
          <span className="stage-start__title">Start the stage</span>
          <span className="stage-start__hint">Turns on sound and goes full screen. Do this once, before guests arrive.</span>
        </button>
      )}
      <StageScene view={shown} anim={anim} serverNow={serverNow} onSpin={canSpinNow ? spinNow : undefined} onLanded={() => {
        if (audioOn()) sfx.fanfare();
        setAnim((a) => (a && a.kind === "spin" ? { ...a, phase: "landed" } : a));
      }} />
    </main>
    </EventCodeContext.Provider>
  );
}

interface SceneProps {
  onSpin?: () => void;
  view: StageView;
  anim: Anim | null;
  serverNow: () => number;
  onLanded: () => void;
}

function StageScene({ view, anim, serverNow, onLanded, onSpin }: SceneProps) {
  if (view.intermission) return <Intermission />;
  const { phase } = view.draw;
  if (phase === "draft") return <Arrivals view={view} />;
  if (phase !== "complete" || anim) return <Draw view={view} anim={anim} onLanded={onLanded} onSpin={onSpin} />;
  switch (view.stage.screen) {
    case "activity":
      return <ActivityIntro key={view.stage.activityId} view={view} serverNow={serverNow} />;
    case "quiz":
      return view.quiz ? <QuizStage key={`${view.quiz.activityId}-${view.quiz.question?.id ?? "intro"}`} view={view} serverNow={serverNow} /> : <Teams view={view} serverNow={serverNow} />;
    case "results":
      return view.results ? <ActivityResults key={view.results.activityId} view={view} /> : <Teams view={view} serverNow={serverNow} />;
    case "standings":
    case "final":
      return view.standings ? (
        <Standings key={`${view.standings.seq}-${view.stage.screen}`} view={view} />
      ) : (
        <Teams view={view} serverNow={serverNow} />
      );
    default:
      return <Teams view={view} serverNow={serverNow} />;
  }
}

function Intermission() {
  return (
    <section className="scene scene--centre">
      <Wordmark className="wordmark--stage" />
      <p className="stage__lede">Back in a moment</p>
    </section>
  );
}

function Arrivals({ view }: { view: StageView }) {
  const joinUrl = `${location.origin}/e/${view.eventCode}`;
  const [qr, setQr] = useState("");
  useEffect(() => {
    QRCode.toString(joinUrl, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#10241e", light: "#00000000" } })
      .then(setQr)
      .catch(() => setQr(""));
  }, [joinUrl]);
  const joined = view.players.filter((p) => p.status === "joined");
  const expected = view.players.filter((p) => p.status === "expected");
  const display = joinUrl.replace(/^https?:\/\//, "");

  return (
    <section className="scene arrivals">
      <div className="arrivals__invite">
        <Wordmark className="wordmark--stage" />
        <p className="stage__lede">Scan to join the game</p>
        <div className="arrivals__qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR code for the join link" role="img" />
        <p className="arrivals__url">{display}</p>
      </div>
      <div className="arrivals__guests">
        <h2 className="stage__heading">
          {joined.length === 0 ? "Waiting for the first guest" : `${joined.length} here${expected.length ? `, ${expected.length} on the way` : ""}`}
        </h2>
        <ul className="arrivals__list">
          {joined.map((p) => (
            <li key={p.id} className="arrivals__guest">
              <Avatar player={p} className="arrivals__avatar" /> {p.name}
            </li>
          ))}
          {expected.map((p) => (
            <li key={p.id} className="arrivals__guest arrivals__guest--expected">
              {p.name}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Draw({ view, anim, onLanded, onSpin }: { view: StageView; anim: Anim | null; onLanded: () => void; onSpin?: () => void }) {
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const wheelNames = view.draw.pool.map((id) => {
    const p = players.get(id);
    return { id, name: p?.name ?? "?", emoji: p?.emoji ?? "" };
  });
  const spinTarget = anim?.kind === "spin" ? anim.event.playerIds[0] : null;
  const landed = anim?.kind === "spin" && anim.phase === "landed";
  const lastId = view.draw.lastEvent && !view.draw.lastEvent.final ? view.draw.lastEvent.playerIds[0] : null;
  const winner = spinTarget ? players.get(spinTarget) : null;
  const winnerTeam = anim ? view.teams.find((t) => t.id === anim.event.teamId) : null;

  return (
    <section className="scene draw">
      <div className="draw__wheel">
        <Wheel
          names={wheelNames}
          spin={anim?.kind === "spin" ? { targetId: anim.event.playerIds[0], key: anim.event.step } : null}
          durationMs={WHEEL_MS}
          winnerId={landed ? spinTarget : null}
          onTick={() => audioOn() && sfx.tick()}
          onLanded={onLanded}
          onHubClick={onSpin}
        />
        {landed && winner && winnerTeam && (
          <div className="draw__callout" style={teamStyle(winnerTeam)}>
            <Avatar player={winner} className="draw__callout-photo" />
            <span className="draw__callout-name">{winner.name}</span>
            <span className="draw__callout-team">
              joins {winnerTeam.badge} {teamDisplayName(winnerTeam)}
            </span>
          </div>
        )}
        {anim?.kind === "final" && winnerTeam && (
          <FinalReveal event={anim.event} teamName={teamDisplayName(winnerTeam)} badge={winnerTeam.badge} players={players} colour={winnerTeam.colour} />
        )}
        {!anim && view.draw.step === 0 && <p className="draw__prompt">The draw is locked. Let's spin.</p>}
      </div>
      <div className="draw__teams">
        {view.teams.map((t) => (
          <TeamCard key={t.id} team={t} players={players} showSeats highlightId={lastId} />
        ))}
      </div>
    </section>
  );
}

function FinalReveal({
  event,
  teamName,
  badge,
  players,
  colour,
}: {
  event: RevealEventView;
  teamName: string;
  badge: string;
  colour: string;
  players: ReturnType<typeof playerMap>;
}) {
  const [named, setNamed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setNamed(true), FINAL_MS - 2600);
    return () => clearTimeout(t);
  }, []);
  const names = event.playerIds.map((id) => players.get(id)).filter(Boolean);
  return (
    <div className="final-reveal" style={teamStyle({ colour })}>
      {!named ? (
        <p className="final-reveal__suspense">…which means</p>
      ) : (
        <>
          <div className="final-reveal__photos">
            {names.map((p) => (
              <Avatar key={p!.id} player={p!} className="final-reveal__photo" />
            ))}
          </div>
          <p className="final-reveal__names">{names.map((p) => p!.name).join(names.length > 2 ? ", " : " & ")}</p>
          <p className="final-reveal__team">
            are {badge} {teamName}
          </p>
        </>
      )}
    </div>
  );
}

function Teams({ view, serverNow }: { view: StageView; serverNow: () => number }) {
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const naming = view.naming;
  useTicker(250, naming.phase === "open");
  const left = naming.deadline ? naming.deadline - serverNow() : 0;
  return (
    <section className="scene teams-scene">
      <header className="teams-scene__head">
        {naming.phase === "open" ? (
          <>
            <h2 className="stage__heading">Pick your team name on your phone</h2>
            <p className="countdown" aria-live="off">
              {formatClock(left)}
            </p>
          </>
        ) : (
          <h2 className="stage__heading stage__heading--big">Meet the teams</h2>
        )}
      </header>
      <div className={`teams-grid teams-grid--${Math.min(view.teams.length, 7)}`}>
        {view.teams.map((t) => (
          <TeamCard key={t.id} team={t} players={players} size="lg" />
        ))}
      </div>
    </section>
  );
}
