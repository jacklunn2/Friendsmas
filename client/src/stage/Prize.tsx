// The grand prize on the TV (Block 4): a dramatic unveiling of the trophy
// before the finale, and the hall of fame: past winners as a slowly panning
// slideshow of wanted posters.

import { useEffect, useState } from "react";
import { imageUrl, type StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";

const STINGS = [
  "Previous champions. Still insufferable about it.",
  "Wanted: for crimes against modesty.",
  "Their names are etched in history. And on a group chat they won't stop mentioning.",
  "Last seen: refusing to give the trophy back.",
  "Reward: eternal glory (and a mince pie).",
];

export function GrandPrize({ view }: { view: StageView }) {
  const url = view.prize.trophyImageId ? imageUrl(view.prize.trophyImageId, view.eventCode) : null;
  useEffect(() => {
    if (!audioOn()) return;
    sfx.drumroll(3.6);
    const t = setTimeout(() => sfx.finale(), 4000);
    return () => clearTimeout(t);
  }, []);
  return (
    <section className="scene prize" aria-label="The Grand Prize">
      <div className="prize__beam prize__beam--left" aria-hidden />
      <div className="prize__beam prize__beam--right" aria-hidden />
      <p className="prize__kicker">Ladies and gentlemen… the moment you've all been waiting for</p>
      <div className="prize__stage">
        <div className="prize__rays" aria-hidden />
        {url && <img className="prize__trophy" src={url} alt="The Friendsmas trophy" />}
        <div className="prize__sparkles" aria-hidden>
          {Array.from({ length: 18 }, (_, i) => (
            <span key={i} style={{ left: `${(i * 37) % 100}%`, top: `${(i * 53) % 100}%`, animationDelay: `${4 + (i % 6) * 0.35}s` }} />
          ))}
        </div>
      </div>
      <h1 className="prize__title">The Grand Prize</h1>
      <p className="prize__sub">
        One team takes it home. Forever.*
        <span className="prize__small">*Until next Christmas.</span>
      </p>
    </section>
  );
}

export function HallOfFame({ view }: { view: StageView }) {
  const winners = view.prize.pastWinners;
  const [i, setI] = useState(0);
  useEffect(() => {
    if (winners.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % winners.length), 7000);
    return () => clearInterval(t);
  }, [winners.length]);
  const w = winners[i % Math.max(winners.length, 1)];
  if (!w) return null;
  return (
    <section className="scene gallery">
      <header className="gallery__head">
        <p className="gallery__kicker">The Friendsmas</p>
        <h1 className="gallery__title">Hall of Fame</h1>
        <p key={`sting-${i}`} className="gallery__sting">
          {STINGS[i % STINGS.length]}
        </p>
      </header>
      <figure key={w.id} className="poster">
        <p className="poster__wanted">Wanted</p>
        <p className="poster__for">for winning Friendsmas</p>
        <div className="poster__frame">
          <img className="poster__photo" src={imageUrl(w.imageId, view.eventCode)} alt={w.caption || "Past winners"} />
        </div>
        {w.caption && <figcaption className="poster__caption">{w.caption}</figcaption>}
      </figure>
      {winners.length > 1 && (
        <ol className="gallery__strip" aria-hidden>
          {winners.map((x, j) => (
            <li key={x.id} className={j === i ? "is-current" : ""}>
              <img src={imageUrl(x.imageId, view.eventCode)} alt="" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
