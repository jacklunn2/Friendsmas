// The TV's welcome screen (Block 4): the menu everyone's bringing, the photo
// slideshow, the trophy, and the QR code to join. It updates live as guests
// arrive and answer the questionnaire.

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { DISH_CATEGORIES, DISH_CATEGORY_LABEL, imageUrl, type Memory, type PastWinner, type StageView } from "../../../shared/types";
import { Avatar, playerMap, Wordmark } from "../ui";

const PHOTO_MS = 6_000;

/** Steps through the photos, one every few seconds. */
function usePhotoIndex(count: number) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (count < 2) return;
    const t = setInterval(() => setI((x) => x + 1), PHOTO_MS);
    return () => clearInterval(t);
  }, [count]);
  return count ? i % count : 0;
}

interface Slide {
  id: string;
  imageId: string;
  caption: string;
  winner: boolean;
}

/** Memories with past winners mixed in: a winner after every two memories. */
function slidesFrom(memories: Memory[], winners: PastWinner[]): Slide[] {
  const m = memories.map((x) => ({ ...x, winner: false }));
  const w = winners.map((x) => ({ ...x, winner: true }));
  if (!m.length || !w.length) return [...m, ...w];
  const out: Slide[] = [];
  let wi = 0;
  m.forEach((x, i) => {
    out.push(x);
    if (i % 2 === 1) {
      const x = w[wi % w.length];
      wi++;
      out.push({ ...x, id: `${x.id}-${i}` });
    }
  });
  // Every winner appears at least once a lap.
  while (wi < w.length) out.push(w[wi++]);
  return out;
}

function Slideshow({ slides, index, code }: { slides: Slide[]; index: number; code: string }) {
  const s = slides[index];
  const next = slides[(index + 1) % slides.length];
  return (
    <div className={`memories${s.winner ? " memories--winner" : ""}`}>
      {/* Only past winners get a title; memories speak for themselves. */}
      {s.winner && (
        <h2 key={`title-${s.id}`} className="welcome__title memories__title">
          Hall of Fame
        </h2>
      )}
      <figure key={s.id} className="memories__frame">
        <div className={`memories__stage${s.caption ? " has-caption" : ""}`}>
          <div className="memories__print">
            <div className="memories__mat">
              <div className="memories__window">
                <img className="memories__photo" src={imageUrl(s.imageId, code)} alt={s.caption || (s.winner ? "Past Friendsmas winners" : "A Friendsmas memory")} />
              </div>
            </div>
            {s.caption && <figcaption className="memories__caption">{s.caption}</figcaption>}
          </div>
        </div>
      </figure>
      {/* The next photo, loading quietly so the change is instant. */}
      {slides.length > 1 && <img hidden alt="" src={imageUrl(next.imageId, code)} />}
    </div>
  );
}

const CATEGORY_ICON: Record<string, string> = { main: "🍗", side: "🥔", dessert: "🍮", drinks: "🍷", other: "🧀" };

export function Welcome({ view, trophyUrl }: { view: StageView; trophyUrl: string | null }) {
  const players = useMemo(() => playerMap(view.players), [view.players]);
  const joinUrl = `${location.origin}/e/${view.eventCode}`;
  const [qr, setQr] = useState("");
  useEffect(() => {
    QRCode.toString(joinUrl, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#10241e", light: "#00000000" } })
      .then(setQr)
      .catch(() => setQr(""));
  }, [joinUrl]);

  const joined = view.players.filter((p) => p.status === "joined" || p.status === "left");
  const expected = view.players.filter((p) => p.status === "expected");
  const menu = view.menu.filter((m) => players.has(m.playerId));
  const groups = DISH_CATEGORIES.map((c) => ({ c, items: menu.filter((m) => m.category === c) })).filter((g) => g.items.length);
  const dense = menu.length > 12;
  const slides = useMemo(() => slidesFrom(view.memories, view.prize.pastWinners), [view.memories, view.prize.pastWinners]);
  const photo = usePhotoIndex(slides.length);
  const photos = slides.length > 0;

  return (
    <section className={`scene welcome${trophyUrl ? " welcome--trophy" : ""}${photos ? " welcome--photos" : ""}`}>
      <header className="welcome__head">
        <Wordmark className="wordmark--stage welcome__wordmark" />
      </header>

      {photos && (
        <div className="welcome__photos">
          <Slideshow slides={slides} index={photo} code={view.eventCode} />
        </div>
      )}
      <div className={`welcome__menu${dense ? " is-dense" : ""}`}>
        <h2 className="welcome__title">Today's menu</h2>
        {groups.length ? (
          <div className="welcome__groups">
            {groups.map(({ c, items }) => (
              <section key={c} className="welcome__group">
                <h3 className="welcome__group-title">
                  <span aria-hidden>{CATEGORY_ICON[c]}</span> {DISH_CATEGORY_LABEL[c]}
                </h3>
                <ul className="welcome__dishes">
                  {items.map((m) => {
                    const p = players.get(m.playerId)!;
                    const cooks = [p, ...m.withIds.map((id) => players.get(id)).filter((x) => !!x)];
                    return (
                      <li key={m.playerId} className="welcome__dish">
                        <span className="welcome__dish-cooks">
                          {cooks.map((c) => (
                            <Avatar key={c!.id} player={c!} className="welcome__dish-photo" />
                          ))}
                        </span>
                        <span className="welcome__dish-text">
                          <span className="welcome__dish-name">{m.dish}</span>
                          <span className="welcome__dish-by">
                            {cooks.map((c) => c!.name).join(" & ")}
                            {m.dietary && <span className="welcome__dish-diet"> · {m.dietary}</span>}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="welcome__empty">The menu fills in as everyone tells us what they're bringing.</p>
        )}
      </div>

      <aside className="welcome__side">
        <div className="welcome__bottom">
          {trophyUrl && (
            <figure className="welcome__trophy">
              <img src={trophyUrl} alt="The Friendsmas trophy" />
              <figcaption>Up for grabs</figcaption>
            </figure>
          )}
        <div className="welcome__join">
          <div className="welcome__qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR code for the join link" role="img" />
          <p className="welcome__join-text">
            Scan to join
            <span className="welcome__url">{joinUrl.replace(/^https?:\/\//, "")}</span>
          </p>
        </div>
        </div>
      </aside>

      <footer className="welcome__here">
        <span className="welcome__count">
          {joined.length === 0 ? "Waiting for the first guest" : `${joined.length} here${expected.length ? `, ${expected.length} on the way` : ""}`}
        </span>
        <ul className="welcome__faces">
          {joined.map((p) => (
            <li key={p.id} className="welcome__face" title={p.name}>
              <Avatar player={p} className="welcome__face-photo" />
              <span className="welcome__face-name">{p.name}</span>
            </li>
          ))}
        </ul>
      </footer>
    </section>
  );
}
