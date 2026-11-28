// The guest questionnaire on phones: what you're bringing, and your secret
// facts for "Who wrote this?". The photo comes straight after, on its own step.

import { useState, type FormEvent } from "react";
import {
  DIETARY_MAX,
  DISH_CATEGORIES,
  DISH_CATEGORY_LABEL,
  DISH_MAX,
  FACT_MAX,
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
  const others = view.menu.filter((m) => m.playerId !== meId);
  const [sharedWith, setSharedWith] = useState<string | null>(existing?.sharedWith ?? null);
  const [choosing, setChoosing] = useState(false);
  const shared = sharedWith ? view.menu.find((m) => m.playerId === sharedWith) : undefined;
  const [dish, setDish] = useState(existing?.dish ?? "");
  const [category, setCategory] = useState<DishCategory | null>(existing?.category ?? null);
  const [dietary, setDietary] = useState(existing?.dietary ?? "");
  const [facts, setFacts] = useState<string[]>(existing?.facts.length ? existing.facts.map((f) => f.text) : [""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await send("player.answers", sharedWith ? { sharedWith, facts } : { dish, category, dietary, facts });
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
            <p className="quest__help">Tap the dish you're making together. It'll appear once on the menu, with both of you.</p>
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
            Making a dish with someone who's already answered? Choose it here
          </button>
        )}
        {!shared && !choosing && (
        <>
        <label className="field">
          <span className="field__label">Dish</span>
          <input className="input" value={dish} maxLength={DISH_MAX} onChange={(e) => setDish(e.target.value)} placeholder="e.g. Grandma's trifle" required />
        </label>
        <div className="field">
          <span className="field__label">What kind of dish?</span>
          <div className="quest__cats" role="radiogroup" aria-label="What kind of dish">
            {DISH_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                className={`quest__cat${category === c ? " is-selected" : ""}`}
                onClick={() => setCategory(c)}
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
            value={dietary}
            maxLength={DIETARY_MAX}
            onChange={(e) => setDietary(e.target.value)}
            placeholder="e.g. vegetarian, contains nuts"
          />
        </label>
        </>
        )}
      </fieldset>

      <fieldset className="quest__group">
        <legend className="quest__legend">🤫 Secret facts</legend>
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
              required={i === 0}
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
      <button className="btn btn--primary btn--block" disabled={busy || (!sharedWith && (!dish.trim() || !category)) || !facts[0]?.trim()}>
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
