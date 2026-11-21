// The show's extras (Block 4): the welcome screen's agenda, the grand prize,
// the hall of fame and videos. Pure functions over ServerState, like logic.ts.

import { AGENDA_ITEM_MAX, AGENDA_MAX_ITEMS, AGENDA_TIME_MAX, CAPTION_MAX, MAX_PAST_WINNERS, type AgendaItem } from "../shared/types";
import { str, UserError, type Handler, type Payload } from "./common";
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

function imageId(p: Payload): string {
  const id = p.imageId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new UserError("Upload a picture first.");
  return id;
}

function findWinner(s: ServerState, id: unknown) {
  const w = s.prize.pastWinners.find((x) => x.id === id);
  if (!w) throw new UserError("That photo no longer exists.");
  return w;
}

export const showHost: Record<string, Handler> = {
  /** The trophy photo (null removes it). */
  "prize.trophy": (s, _a, p) => {
    const old = s.prize.trophyImageId;
    s.prize.trophyImageId = p.imageId === null ? null : imageId(p);
    return {
      audit: ["prize.trophy", s.prize.trophyImageId ? "Trophy photo added" : "Trophy photo removed"],
      deleteImages: old && old !== s.prize.trophyImageId ? [old] : undefined,
    };
  },

  "prize.winner.add": (s, _a, p) => {
    if (s.prize.pastWinners.length >= MAX_PAST_WINNERS) throw new UserError(`The hall of fame holds up to ${MAX_PAST_WINNERS} photos.`);
    const caption = str(p, "caption", { max: CAPTION_MAX, optional: true, label: "the caption" });
    s.prize.pastWinners.push({ id: newId(s, "w"), imageId: imageId(p), caption });
    return { audit: ["prize.winner.add", caption || "Past winners photo added"] };
  },

  "prize.winner.update": (s, _a, p) => {
    const w = findWinner(s, p.id);
    w.caption = str(p, "caption", { max: CAPTION_MAX, optional: true, label: "the caption" });
    return {};
  },

  "prize.winner.move": (s, _a, p) => {
    const list = s.prize.pastWinners;
    const i = list.indexOf(findWinner(s, p.id));
    const j = i + (p.direction === "up" ? -1 : 1);
    if (j < 0 || j >= list.length) return { noChange: true };
    [list[i], list[j]] = [list[j], list[i]];
    return {};
  },

  "prize.winner.remove": (s, _a, p) => {
    const w = findWinner(s, p.id);
    s.prize.pastWinners = s.prize.pastWinners.filter((x) => x !== w);
    return { audit: ["prize.winner.remove", w.caption || "Past winners photo removed"], deleteImages: [w.imageId] };
  },

  "agenda.save": (s, _a, p) => {
    s.agenda = parseAgenda(s, p.items);
    return { audit: ["agenda.save", `Agenda saved (${s.agenda.length} items)`] };
  },
};
