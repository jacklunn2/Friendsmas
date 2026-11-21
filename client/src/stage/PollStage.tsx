// A poll on the TV (Block 4). While voting is open it shows who has voted;
// the reveal draws the bars, crowns the winner, and for "Who wrote this?"
// unmasks the writer with their photo and how many guessed right.

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { POLL_SCORING_LABEL, signed, teamDisplayName, type StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";
import { useTicker } from "../net";
import { Avatar, formatClock, playerMap, teamStyle } from "../ui";

export function PollStage({ view, serverNow }: { view: StageView; serverNow: () => number }) {
  const pl = view.poll!;
  const a = view.activities.find((x) => x.id === pl.activityId);
  const q = pl.question;
  const open = pl.phase === "open";
  const now = useTicker(200, open && !!pl.endsAt);
  const left = pl.endsAt ? pl.endsAt - serverNow() : null;
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const teams = useMemo(() => new Map(view.teams.map((t) => [t.id, t])), [view.teams]);
  const whowrote = pl.pollKind === "whowrote";

  const lastSec = useRef<number | null>(null);
  useEffect(() => {
    if (!open || left === null || !audioOn()) return;
    const sec = Math.ceil(left / 1000);
    if (sec !== lastSec.current && sec <= 5 && sec > 0) sfx.pip();
    lastSec.current = sec;
  }, [now, open, left]);
  const prevPhase = useRef(pl.phase);
  useEffect(() => {
    if (audioOn()) {
      if (prevPhase.current === "open" && pl.phase === "closed") sfx.buzzer();
      if (prevPhase.current !== "revealed" && pl.phase === "revealed") (whowrote ? sfx.drumroll(1.6) : sfx.fanfare());
    }
    prevPhase.current = pl.phase;
  }, [pl.phase, whowrote]);

  if (!a) return null;

  if (pl.phase === "intro" || !q) {
    return (
      <section className="scene quiz-intro">
        <p className="activity-intro__kind">{whowrote ? `${pl.total} secret facts` : `Poll · ${pl.total} questions`}</p>
        <h1 className="activity-intro__name">{a.name}</h1>
        <p className="quiz-intro__how">
          📱{" "}
          {whowrote
            ? "Each fact was written by someone in this room. Guess who on your phone. If it's yours, keep a straight face."
            : "Vote on your phones. Nobody sees the votes until the reveal."}
        </p>
        {whowrote && a.foolBonus > 0 && <p className="quiz-intro__bonus">+{a.perCorrect} for every right guess · +{a.foolBonus} for the best liar</p>}
      </section>
    );
  }

  const reveal = pl.phase === "revealed" ? pl.reveal : null;
  const voted = new Set(pl.answeredIds);
  const everyone = view.teams.flatMap((t) => t.memberIds).map((id) => players.get(id)).filter((p) => !!p);
  const maxCount = Math.max(1, ...Object.values(reveal?.counts ?? {}));
  const ranked = reveal ? q.options.filter((o) => reveal.counts[o.key]).sort((x, y) => reveal.counts[y.key] - reveal.counts[x.key]) : [];

  return (
    <section className={`scene poll-stage${reveal ? " is-revealed" : ""}`}>
      <header className="quiz-q__head">
        <span className="quiz-q__num">
          {whowrote ? "Who wrote this?" : "Poll"} {q.number} <span className="quiz-q__of">of {pl.total}</span>
        </span>
        <span className={`quiz-q__clock${open && left !== null && left <= 5000 ? " is-low" : ""}`}>
          {open ? (left !== null ? formatClock(left) : "") : pl.phase === "closed" ? "Votes are in" : ""}
        </span>
      </header>

      <h1 className={`poll-stage__prompt${whowrote ? " poll-stage__prompt--fact" : ""}`}>{whowrote ? `“${q.prompt}”` : q.prompt}</h1>
      {!reveal && !whowrote && q.scoring !== "none" && <p className="poll-stage__scoring">{POLL_SCORING_LABEL[q.scoring]}: {q.points}</p>}

      {!reveal ? (
        <ul className="poll-stage__voters">
          {everyone.map((p) => (
            <li key={p!.id} className={`poll-voter${voted.has(p!.id) ? " is-in" : ""}`}>
              <Avatar player={p!} className="poll-voter__photo" />
              <span className="poll-voter__name">{p!.name}</span>
            </li>
          ))}
        </ul>
      ) : whowrote ? (
        <Unmask view={view} reveal={reveal} />
      ) : (
        <ol className="poll-bars">
          {ranked.map((o, i) => {
            const p = players.get(o.key);
            const t = teams.get(o.key);
            const n = reveal.counts[o.key];
            const win = reveal.winners.includes(o.key);
            const voters = Object.entries(reveal.votes).filter(([, k]) => k === o.key).map(([id]) => players.get(id)).filter((x) => !!x);
            return (
              <li
                key={o.key}
                className={`poll-bar${win ? " is-winner" : ""}`}
                style={{ "--w": `${(n / maxCount) * 100}%`, animationDelay: `${(ranked.length - 1 - i) * 350}ms`, ...(t ? teamStyle(t) : {}) } as CSSProperties}
              >
                <span className="poll-bar__who">
                  {p && <Avatar player={p} className="poll-bar__photo" />}
                  {t && <span className="poll-bar__badge">{t.badge}</span>}
                  <span className="poll-bar__name">{t ? teamDisplayName(t) : o.label}</span>
                  {win && <span className="poll-bar__crown" aria-label="Winner">👑</span>}
                </span>
                <span className="poll-bar__track">
                  <span className="poll-bar__fill" />
                  <span className="poll-bar__voters">
                    {voters.map((v) => (
                      <Avatar key={v!.id} player={v!} className="poll-bar__voter" />
                    ))}
                  </span>
                </span>
                <span className="poll-bar__count">{n}</span>
              </li>
            );
          })}
          {!ranked.length && <p className="poll-stage__empty">Nobody voted!</p>}
        </ol>
      )}

      {reveal && Object.keys(reveal.points).length > 0 && !whowrote && (
        <p className="poll-stage__points">
          {q.scoring === "majority" ? "Voted with the majority: " : "Points: "}
          {Object.entries(reveal.points)
            .map(([id, pts]) => `${players.get(id)?.name ?? ""} ${signed(pts)}`)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

function Unmask({ view, reveal }: { view: StageView; reveal: NonNullable<NonNullable<StageView["poll"]>["reveal"]> }) {
  const players = playerMap(view.players);
  const writer = reveal.writerId ? players.get(reveal.writerId) : undefined;
  const total = Object.keys(reveal.votes).length;
  const right = reveal.correctIds.map((id) => players.get(id)).filter((p) => !!p);
  const fooled = total - right.length;
  return (
    <div className="unmask">
      <div className="unmask__writer">
        {writer ? <Avatar player={writer} className="unmask__photo" /> : <span className="unmask__photo">?</span>}
        <p className="unmask__name">It was {writer?.name ?? "a mystery"}!</p>
      </div>
      <div className="unmask__stats">
        <p className="unmask__big">
          {right.length} of {total} guessed right
        </p>
        {right.length > 0 && (
          <ul className="unmask__right">
            {right.map((p) => (
              <li key={p!.id}>
                <Avatar player={p!} className="unmask__right-photo" />
                <span>{p!.name}</span>
              </li>
            ))}
          </ul>
        )}
        {fooled > 0 && <p className="unmask__fooled">{writer?.name ?? "They"} fooled {fooled} {fooled === 1 ? "person" : "people"}</p>}
      </div>
    </div>
  );
}
