// The show's extras (Block 4): the welcome screen's agenda, the grand prize,
// the hall of fame and videos. Pure functions over ServerState, like logic.ts.

import { AGENDA_ITEM_MAX, AGENDA_MAX_ITEMS, AGENDA_TIME_MAX, type AgendaItem } from "../shared/types";
import { UserError, type Handler } from "./common";
import { newId, type ServerState } from "./state";

/** Replaces the agenda. Rows keep their ids when re-saved; blank rows are dropped. */
function parseAgenda(s: ServerState, raw: unknown): AgendaItem[] {
  if (!Array.isArray(raw)) throw new UserError("Send the agenda as a list.");
  const rows = raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
    .map((r) => ({
      id: typeof r.id === "string" ? r.id : "",
      time: typeof r.time === "string" ? r.time.trim().replace(/\s+/g, " ") : "",
      item: typeof r.item === "string" ? r.item.trim().replace(/\s+/g, " ") : "",
    }))
    .filter((r) => r.time || r.item);
  if (rows.length > AGENDA_MAX_ITEMS) throw new UserError(`The agenda can have up to ${AGENDA_MAX_ITEMS} items.`);
  const known = new Set(s.agenda.map((a) => a.id));
  return rows.map((r, i) => {
    if (!r.item) throw new UserError(`Agenda item ${i + 1} needs a description.`);
    if (r.time.length > AGENDA_TIME_MAX) throw new UserError(`Times must be ${AGENDA_TIME_MAX} characters or fewer.`);
    if (r.item.length > AGENDA_ITEM_MAX) throw new UserError(`Agenda items must be ${AGENDA_ITEM_MAX} characters or fewer.`);
    return { id: known.has(r.id) ? r.id : newId(s, "g"), time: r.time, item: r.item };
  });
}

export const showHost: Record<string, Handler> = {
  "agenda.save": (s, _a, p) => {
    s.agenda = parseAgenda(s, p.items);
    return { audit: ["agenda.save", `Agenda saved (${s.agenda.length} items)`] };
  },
};
