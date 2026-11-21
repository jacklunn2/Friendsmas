// The control room's view of the guest questionnaire: who's done it, the
// food list with its warnings, and everyone's secret facts (host-only).

import { useMemo, useState, type FormEvent } from "react";
import {
  DIETARY_MAX,
  DISH_CATEGORIES,
  DISH_CATEGORY_LABEL,
  DISH_MAX,
  FACT_MAX,
  MAX_FACTS,
  type DishCategory,
  type HostPlayer,
  type HostView,
} from "../../../shared/types";
import { Avatar } from "../ui";
import type { Run } from "./Scoring";

export function QuestionnairePanel({ view, run }: { view: HostView; run: Run }) {
  const guests = view.roster.filter((p) => p.status !== "pending");
  const answers = view.questionnaires;
  const done = guests.filter((p) => answers[p.id]);
  const notDone = guests.filter((p) => !answers[p.id] && p.status !== "excluded");
  const noPhoto = guests.filter((p) => !p.photo && p.status !== "excluded");
  const [editing, setEditing] = useState<string | null>(null);
  const [showFacts, setShowFacts] = useState(false);
  const dupIds = useMemo(() => new Set(view.foodWarnings.flatMap((w) => w.playerIds)), [view.foodWarnings]);

  return (
    <section className="panel" aria-labelledby="quest-h">
      <header className="panel__head">
        <h2 id="quest-h" className="panel__title">
          Questionnaire
        </h2>
        <span className="panel__meta">
          {done.length} of {guests.length} done
        </span>
      </header>
      <p className="host__muted">
        Guests answer through the guest link, any time before the day. Anyone who hasn't is asked to finish it when they join.
      </p>

      {(notDone.length > 0 || noPhoto.length > 0) && (
        <div className="callout callout--warn">
          {notDone.length > 0 && (
            <p>
              <strong>Not done yet:</strong> {notDone.map((p) => p.name).join(", ")}
            </p>
          )}
          {noPhoto.length > 0 && (
            <p>
              <strong>No photo yet:</strong> {noPhoto.map((p) => p.name).join(", ")}
            </p>
          )}
        </div>
      )}

      <h3 className="callout__title">The food</h3>
      {view.foodWarnings.length > 0 && (
        <ul className="warn-list">
          {view.foodWarnings.map((w) => (
            <li key={w.message}>{w.message}</li>
          ))}
        </ul>
      )}
      <div className="food-groups">
        {DISH_CATEGORIES.map((c) => {
          const items = done.filter((p) => answers[p.id].category === c);
          if (!items.length) return null;
          return (
            <div key={c} className="food-group">
              <h4>{DISH_CATEGORY_LABEL[c]}</h4>
              <ul>
                {items.map((p) => (
                  <li key={p.id} className={dupIds.has(p.id) ? "food-group__dup" : undefined}>
                    <Avatar player={p} /> {answers[p.id].dish}
                    {answers[p.id].dietary && <span className="host__muted">({answers[p.id].dietary})</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {!done.length && <p className="host__muted">Nobody has answered yet.</p>}
      </div>

      <div className="row">
        <h3 className="callout__title">Everyone's answers</h3>
        <button className="btn btn--small btn--ghost" onClick={() => setShowFacts(!showFacts)} aria-pressed={showFacts}>
          {showFacts ? "Hide secret facts" : "Show secret facts"}
        </button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Guest</th>
            <th>Bringing</th>
            <th>Secret facts</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {guests.map((p) => {
            const a = answers[p.id];
            return (
              <tr key={p.id}>
                <td>
                  <span className="data-table__who">
                    <Avatar player={p} /> {p.name}
                  </span>
                </td>
                <td>
                  {a ? (
                    <>
                      {a.dish} <span className="tag">{DISH_CATEGORY_LABEL[a.category]}</span>
                      {a.dietary && <div className="host__muted">{a.dietary}</div>}
                    </>
                  ) : (
                    <span className="host__muted">Not done</span>
                  )}
                </td>
                <td>
                  {a ? (
                    showFacts ? (
                      <ol className="facts">
                        {a.facts.map((f) => (
                          <li key={f.id}>{f.text}</li>
                        ))}
                      </ol>
                    ) : (
                      <span className="host__muted">
                        {a.facts.length} {a.facts.length === 1 ? "fact" : "facts"}
                      </span>
                    )
                  ) : null}
                </td>
                <td>
                  <button className="btn btn--small btn--ghost" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    {a ? "Edit" : "Fill in"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing && guests.find((p) => p.id === editing) && (
        <AnswersEditor key={editing} player={guests.find((p) => p.id === editing)!} view={view} run={run} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}

function AnswersEditor({ player, view, run, onClose }: { player: HostPlayer; view: HostView; run: Run; onClose: () => void }) {
  const a = view.questionnaires[player.id];
  const [dish, setDish] = useState(a?.dish ?? "");
  const [category, setCategory] = useState<DishCategory>(a?.category ?? "main");
  const [dietary, setDietary] = useState(a?.dietary ?? "");
  const [facts, setFacts] = useState(a ? a.facts.map((f) => f.text).join("\n") : "");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run("guest.answers", { playerId: player.id, dish, category, dietary, facts: facts.split("\n") }, `Saved ${player.name}'s answers`);
    if (ok) onClose();
  };

  return (
    <form className="inline-form" onSubmit={save}>
      <strong>{player.name}'s answers</strong>
      <div className="inline-form__row">
        <label className="field">
          <span className="field__label">Dish</span>
          <input className="input" value={dish} maxLength={DISH_MAX} onChange={(e) => setDish(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label">Kind</span>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as DishCategory)}>
            {DISH_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {DISH_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Dietary notes</span>
          <input className="input" value={dietary} maxLength={DIETARY_MAX} onChange={(e) => setDietary(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field__label">
          Secret facts, one per line (up to {MAX_FACTS}, {FACT_MAX} characters each)
        </span>
        <textarea className="input input--area" rows={3} value={facts} onChange={(e) => setFacts(e.target.value)} required />
      </label>
      <div className="row__actions">
        <button className="btn btn--small btn--primary">Save</button>
        <button type="button" className="btn btn--small btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
