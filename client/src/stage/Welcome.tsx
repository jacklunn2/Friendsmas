// The TV's welcome screen (Block 4): the menu everyone's bringing, the day's
// agenda, the trophy, and the QR code to join. It updates live as guests
// arrive and answer the questionnaire.

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { DISH_CATEGORIES, DISH_CATEGORY_LABEL, imageUrl, type Memory, type StageView } from "../../../shared/types";
import { Avatar, playerMap, Wordmark } from "../ui";

const MENU_MS = 20_000;
const PHOTO_MS = 6_000;
const PHOTOS_PER_TURN = 4;

/**
 * The left of the welcome screen takes turns: the menu, then a few photos from
 * past Friendsmases, then the menu again. With only one of them, it stays put.
 */
function useTurns(hasMenu: boolean, photoCount: number) {
  const [page, setPage] = useState<"menu" | "memories">(hasMenu || !photoCount ? "menu" : "memories");
  const [photo, setPhoto] = useState(0);
  useEffect(() => {
    if (!photoCount) {
      setPage("menu");
      return;
    }
    if (!hasMenu) {
      setPage("memories");
      const t = setInterval(() => setPhoto((i) => i + 1), PHOTO_MS);
      return () => clearInterval(t);
    }
    if (page === "menu") {
      const t = setTimeout(() => setPage("memories"), MENU_MS);
      return () => clearTimeout(t);
    }
    let shown = 0;
    const t = setInterval(() => {
      shown++;
      if (shown >= Math.min(PHOTOS_PER_TURN, photoCount)) setPage("menu");
      setPhoto((i) => i + 1);
    }, PHOTO_MS);
    return () => clearInterval(t);
  }, [page, hasMenu, photoCount]);
  return { page, photo: photoCount ? photo % photoCount : 0 };
}

function Memories({ memories, index, code }: { memories: Memory[]; index: number; code: string }) {
  const m = memories[index];
  return (
    <div className="memories">
      <h2 className="welcome__title">Friendsmas memories</h2>
      <figure key={m.id} className="memories__frame">
        <img className="memories__photo" src={imageUrl(m.imageId, code)} alt={m.caption || "A Friendsmas memory"} />
        {m.caption && <figcaption className="memories__caption">{m.caption}</figcaption>}
      </figure>
      {/* The next photo, loading quietly so the change is instant. */}
      {memories.length > 1 && <img hidden alt="" src={imageUrl(memories[(index + 1) % memories.length].imageId, code)} />}
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
  const { page, photo } = useTurns(menu.length > 0, view.memories.length);

  return (
    <section className={`scene welcome${trophyUrl ? " welcome--trophy" : ""}`}>
      <header className="welcome__head">
        <p className="welcome__kicker">Welcome to</p>
        <Wordmark className="wordmark--stage welcome__wordmark" />
      </header>

      {page === "memories" && view.memories.length ? (
        <div className="welcome__menu">
          <Memories memories={view.memories} index={photo} code={view.eventCode} />
        </div>
      ) : (
      <div key="menu" className={`welcome__menu welcome__menu--fade${dense ? " is-dense" : ""}`}>
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
                    return (
                      <li key={m.playerId} className="welcome__dish">
                        <Avatar player={p} className="welcome__dish-photo" />
                        <span className="welcome__dish-text">
                          <span className="welcome__dish-name">{m.dish}</span>
                          <span className="welcome__dish-by">
                            {p.name}
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
      )}

      <aside className="welcome__side">
        {view.agenda.length > 0 && (
          <div className="welcome__agenda">
            <h2 className="welcome__title">Today</h2>
            <ol className="agenda">
              {view.agenda.map((a) => (
                <li key={a.id} className="agenda__row">
                  <span className="agenda__time">{a.time}</span>
                  <span className="agenda__item">{a.item}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
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
