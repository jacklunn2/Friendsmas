// The guest questionnaire on phones: what you're bringing, and your secret
// facts for "Who wrote this?". The photo comes straight after, on its own step.

import { useState, type FormEvent } from "react";
import {
  DIETARY_MAX,
  DISH_CATEGORIES,
  DISH_CATEGORY_LABEL,
  DISH_MAX,
  FACT_MAX,
  MAX_DISHES,
  MAX_FACTS,
  type DishCategory,
  type PlayerView,
} from "../../../shared/types";
import { Avatar, playerMap } from "../ui";

type Send = <T = unknown>(action: string, payload?: Record<string, unknown>) => Promise<T>;

const CATEGORY_LABEL: Record<DishCategory, string> = { ...DISH_CATEGORY_LABEL, main: "Main", side: "Side", dessert: "Dessert" };

export function QuestionnaireForm({ view, send, onDone }: { view: PlayerView; send: Send; onDone?: () => void }) {
  const existing = view.myQuestionnaire;
  const meId = view.me?.id;
  const players = playerMap(view.players);
  // Other people's dishes, for couples cooking together.
  // One entry per person, with all their dishes.
  const others = [...new Set(view.menu.filter((m) => m.playerId !== meId).map((m) => m.playerId))].map((playerId) => ({
    playerId,
    dish: view.menu.filter((m) => m.playerId === playerId).map((m) => m.dish).join(" + "),
  }));
  const [sharedWith, setSharedWith] = useState<string | null>(existing?.sharedWith ?? null);
  const [choosing, setChoosing] = useState(false);
  // The hosts are the House: they bring food and a photo, but don't play.
  const [house, setHouse] = useState(!!view.me?.house);
  const drawn = !!view.me?.teamId;
  const sharedDishes = sharedWith ? view.menu.filter((m) => m.playerId === sharedWith) : [];
  const shared = sharedDishes.length ? { playerId: sharedWith!, dish: sharedDishes.map((m) => m.dish).join(" + ") } : undefined;
  type DraftDish = { dish: string; category: DishCategory | null; dietary: string };
  const [dishes, setDishes] = useState<DraftDish[]>(
    existing?.dishes?.length && !existing.sharedWith
      ? existing.dishes.map((d) => ({ dish: d.dish, category: d.category, dietary: d.dietary }))
      : [{ dish: "", category: null, dietary: "" }],
  );
  const setDish = (i: number, patch: Partial<DraftDish>) => setDishes(dishes.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const dishesReady = dishes.every((d) => d.dish.trim() && d.category);
  const [facts, setFacts] = useState<string[]>(existing?.facts.length ? existing.facts.map((f) => f.text) : [""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const who = drawn ? {} : { house };
      await send("player.answers", sharedWith ? { sharedWith, facts, ...who } : { dishes, facts, ...who });
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="phone__card quest" onSubmit={submit}>
      <h1 className="phone__title">{existing ? "Your answers" : "A few questions"}</h1>
      {!existing && <p>Two minutes, then you're done. You can change your answers any time before the day.</p>}

      {!drawn && (
        <div className="quest__role segmented" role="radiogroup" aria-label="Are you playing or hosting?">
          <button type="button" role="radio" aria-checked={!house} className={!house ? "is-selected" : ""} onClick={() => setHouse(false)}>
            I'm playing
          </button>
          <button type="button" role="radio" aria-checked={house} className={house ? "is-selected" : ""} onClick={() => setHouse(true)}>
            I'm hosting (the House)
          </button>
        </div>
      )}
      {house && <p className="quest__help">The hosts are the House: you won't be on a team, and your photo appears with the House on the leaderboard.</p>}

      <fieldset className="quest__group">
        <legend className="quest__legend">🍽️ What are you bringing?</legend>
        {shared ? (
          <div className="quest__shared">
            <p>
              You're bringing <strong>{shared.dish}</strong> with {players.get(shared.playerId)?.name ?? "someone"}.
            </p>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setSharedWith(null)}>
              No, I'm bringing my own
            </button>
          </div>
        ) : choosing ? (
          <div className="quest__shared">
            <p className="quest__help">Tap the person whose food you're bringing together (or who's bringing food for you). It'll appear once on the menu, with both of you.</p>
            <ul className="quest__dishes">
              {others.map((m) => {
                const who = players.get(m.playerId);
                return (
                  <li key={m.playerId}>
                    <button
                      type="button"
                      className="poll-option"
                      onClick={() => {
                        setSharedWith(m.playerId);
                        setChoosing(false);
                      }}
                    >
                      {who && <Avatar player={who} className="poll-option__photo" />}
                      <span className="poll-option__label">
                        {m.dish}
                        <span className="phone__muted"> · {who?.name ?? "a guest"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setChoosing(false)}>
              Back
            </button>
          </div>
        ) : null}
        {!shared && !choosing && others.length > 0 && (
          <button type="button" className="btn btn--ghost btn--small quest__with" onClick={() => setChoosing(true)}>
            Cooking with someone, or someone bringing food for you? Pick their dish
          </button>
        )}
        {!shared &&
          !choosing &&
          dishes.map((d, i) => (
            <div key={i} className="quest__dish">
              <label className="field">
                <span className="field__label">
                  {dishes.length > 1 ? `Dish ${i + 1}` : "Dish"}
                  {i > 0 && (
                    <button type="button" className="quest__remove" onClick={() => setDishes(dishes.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </span>
                <input
                  className="input"
                  value={d.dish}
                  maxLength={DISH_MAX}
                  onChange={(e) => setDish(i, { dish: e.target.value })}
                  placeholder={i === 0 ? "e.g. Grandma's trifle" : "e.g. Roast potatoes"}
                  required
                />
              </label>
              <div className="field">
                <span className="field__label">What kind of dish?</span>
                <div className="quest__cats" role="radiogroup" aria-label={`What kind of dish is dish ${i + 1}`}>
                  {DISH_CATEGORIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={d.category === c}
                      className={`quest__cat${d.category === c ? " is-selected" : ""}`}
                      onClick={() => setDish(i, { category: c })}
                    >
                      {CATEGORY_LABEL[c]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                <span className="field__label">Dietary notes (optional)</span>
                <input
                  className="input"
                  value={d.dietary}
                  maxLength={DIETARY_MAX}
                  onChange={(e) => setDish(i, { dietary: e.target.value })}
                  placeholder="e.g. vegetarian, contains nuts"
                />
              </label>
            </div>
          ))}
        {!shared && !choosing && dishes.length < MAX_DISHES && (
          <button type="button" className="btn btn--ghost btn--small quest__with" onClick={() => setDishes([...dishes, { dish: "", category: null, dietary: "" }])}>
            Bringing more than one thing? Add another dish
          </button>
        )}
      </fieldset>

      <fieldset className="quest__group">
        <legend className="quest__legend">🤫 Secret facts{house ? " (optional for the House)" : ""}</legend>
        <p className="quest__help">
          Things about you that nobody here would guess. Only the host sees these, until one turns up in a game of "Who wrote this?".
        </p>
        {facts.map((f, i) => (
          <label key={i} className="field">
            <span className="field__label">
              Fact {i + 1}
              {i > 0 && (
                <button type="button" className="quest__remove" onClick={() => setFacts(facts.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </span>
            <textarea
              className="input input--area"
              rows={2}
              maxLength={FACT_MAX}
              value={f}
              onChange={(e) => setFacts(facts.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder={i === 0 ? "e.g. I once got lost in IKEA for three hours" : "Another one"}
              required={i === 0 && !house}
            />
          </label>
        ))}
        {facts.length < MAX_FACTS && (
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setFacts([...facts, ""])}>
            Add another fact
          </button>
        )}
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn--primary btn--block" disabled={busy || (!sharedWith && !dishesReady) || (!house && !facts[0]?.trim())}>
        {busy ? "Saving…" : existing ? "Save my answers" : "Done"}
      </button>
      {existing && onDone && (
        <button type="button" className="btn btn--ghost btn--block" onClick={onDone}>
          Cancel
        </button>
      )}
    </form>
  );
}
