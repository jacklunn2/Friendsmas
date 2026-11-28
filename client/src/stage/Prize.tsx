// The grand prize on the TV (Block 4): a dramatic unveiling of the trophy
// before the finale. (Past winners appear in the welcome screen's slideshow.)

import { useEffect } from "react";
import { imageUrl, type StageView } from "../../../shared/types";
import { audioOn, sfx } from "../audio";

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
