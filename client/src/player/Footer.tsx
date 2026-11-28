// The bar along the bottom of every guest's phone, for the whole game:
// their photo and nickname, their food and secret facts, and their secret
// mission. Each opens as a sheet over whatever is on screen, so a guest can
// check them mid-quiz without losing their place.

import { useState } from "react";
import { DISH_CATEGORY_LABEL, type PlayerView } from "../../../shared/types";
import { Avatar } from "../ui";
import { MissionLayer, RumbledAlert } from "./Mission";
import { NameForm, PhotoStep } from "./Profile";
import { QuestionnaireForm } from "./Questionnaire";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;
type Sheet = "me" | "food" | null;

export function PhoneFooter({ view, send, getToken }: { view: PlayerView; send: Send; getToken: () => string | null }) {
  const me = view.me!;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [missionOpen, setMissionOpen] = useState(false);
  const mission = view.myMission;

  return (
    <>
      {sheet && (
        <div className="sheet" role="dialog" aria-modal="true" aria-label={sheet === "me" ? "You" : "Your food and facts"}>
          <div className="sheet__body">
            <button className="sheet__close" onClick={() => setSheet(null)}>
              Close ✕
            </button>
            {sheet === "me" ? <MeSheet view={view} send={send} getToken={getToken} /> : <FoodSheet view={view} send={send} />}
          </div>
        </div>
      )}
      {mission && <MissionLayer mission={mission} send={send} open={missionOpen} setOpen={setMissionOpen} />}
      {mission && <RumbledAlert mission={mission} code={view.eventCode} playerId={me.id} />}

      <nav className="phone-footer" aria-label="You">
        <button className={`phone-footer__item${sheet === "me" ? " is-active" : ""}`} onClick={() => setSheet(sheet === "me" ? null : "me")}>
          <Avatar player={me} className="phone-footer__photo" />
          <span className="phone-footer__label">{me.name}</span>
        </button>
        <button className={`phone-footer__item${sheet === "food" ? " is-active" : ""}`} onClick={() => setSheet(sheet === "food" ? null : "food")}>
          <span className="phone-footer__icon" aria-hidden>
            🍽️
          </span>
          <span className="phone-footer__label">{view.myQuestionnaire ? "Food & facts" : "Answer questions"}</span>
          {!view.myQuestionnaire && <span className="phone-footer__dot" aria-label="Not done yet" />}
        </button>
        {mission && (
          <button
            className={`phone-footer__item phone-footer__item--mission${!mission.seen ? " is-new" : ""}`}
            onClick={() => {
              setSheet(null);
              setMissionOpen(true);
            }}
          >
            <span className="phone-footer__icon" aria-hidden>
              🕵️
            </span>
            <span className="phone-footer__label">Mission</span>
            {!mission.seen && <span className="phone-footer__dot" aria-label="New" />}
          </button>
        )}
      </nav>
    </>
  );
}

function MeSheet({ view, send, getToken }: { view: PlayerView; send: Send; getToken: () => string | null }) {
  const me = view.me!;
  const [editingName, setEditingName] = useState(false);
  return (
    <>
      {editingName ? (
        <NameForm me={me} send={send} onDone={() => setEditingName(false)} />
      ) : (
        <section className="phone__card sheet__me">
          <p className="phone__muted">Your nickname</p>
          <p className="sheet__name">{me.name}</p>
          <button className="btn btn--ghost btn--small" onClick={() => setEditingName(true)}>
            Change my nickname
          </button>
        </section>
      )}
      <section className="phone__card">
        <PhotoStep me={me} getToken={getToken} send={send} />
      </section>
    </>
  );
}

function FoodSheet({ view, send }: { view: PlayerView; send: Send }) {
  const q = view.myQuestionnaire;
  const [editing, setEditing] = useState(!q);
  if (editing || !q) return <QuestionnaireForm view={view} send={send} onDone={() => setEditing(false)} />;
  return (
    <section className="phone__card food-sheet">
      <h2 className="phone__title">Your food</h2>
      {q.dishes.map((d) => (
        <p key={d.id} className="food-sheet__dish">
          {d.dish} <span className="tag">{DISH_CATEGORY_LABEL[d.category]}</span>
          {d.dietary && <span className="phone__muted"> {d.dietary}</span>}
        </p>
      ))}
      {q.sharedWith && <p className="phone__muted">With {view.players.find((p) => p.id === q.sharedWith)?.name ?? "someone"}</p>}
      <h2 className="phone__title">Your secret facts</h2>
      <p className="phone__muted">Only you and the host can see these, until one turns up in "Who wrote this?".</p>
      <ol className="food-sheet__facts">
        {q.facts.map((f) => (
          <li key={f.id}>{f.text}</li>
        ))}
      </ol>
      <button className="btn btn--secondary btn--block" onClick={() => setEditing(true)}>
        Change my answers
      </button>
    </section>
  );
}
