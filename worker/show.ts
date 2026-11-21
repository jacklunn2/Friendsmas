// The show's extras (Block 4): the welcome screen's agenda, the grand prize,
// the hall of fame and videos. Pure functions over ServerState, like logic.ts.

import {
  AGENDA_ITEM_MAX,
  AGENDA_MAX_ITEMS,
  AGENDA_TIME_MAX,
  CAPTION_MAX,
  MAX_PAST_WINNERS,
  VIDEO_MAX_BYTES,
  VIDEO_NAME_MAX,
  VIDEO_TOTAL_MAX_BYTES,
  VIDEO_TYPES,
  type AgendaItem,
  type VideoInfo,
} from "../shared/types";
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

// ---------------------------------------------------------------------------
// Videos. The bytes live in the Durable Object's SQLite storage (room.ts);
// these rules keep the list and what's playing on the TV.

/** Checks a new upload before any bytes are stored. */
export function checkVideoUpload(s: ServerState, size: number, type: string): void {
  if (!(VIDEO_TYPES as readonly string[]).includes(type)) throw new UserError("Videos must be MP4, WebM or MOV files.");
  if (!Number.isInteger(size) || size <= 0) throw new UserError("That video is empty.");
  if (size > VIDEO_MAX_BYTES) throw new UserError(`Videos can be up to ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} MB. Trim it or lower its quality first.`);
  const used = s.videos.reduce((n, v) => n + v.size, 0);
  if (used + size > VIDEO_TOTAL_MAX_BYTES) {
    throw new UserError(`That would go over the ${Math.round(VIDEO_TOTAL_MAX_BYTES / 1024 / 1024)} MB for all videos. Delete a clip first.`);
  }
}

/** Adds a fully uploaded clip to the list. Called by room.ts, never by a client action. */
export function registerVideo(s: ServerState, v: VideoInfo): void {
  const name = v.name.trim().replace(/\s+/g, " ").slice(0, VIDEO_NAME_MAX) || "Video";
  s.videos.push({ ...v, name });
}

function findVideo(s: ServerState, id: unknown): VideoInfo {
  const v = s.videos.find((x) => x.id === id);
  if (!v) throw new UserError("That video no longer exists.");
  return v;
}

function play(s: ServerState, videoId: string, activityId: string | null, now: number) {
  s.video = { videoId, activityId, playing: true, positionMs: 0, since: now, seq: ++s.videoSeq };
}

/** When an activity goes on the TV, its clip plays first. Anything else playing stops. */
export function startActivityVideo(s: ServerState, activityId: string | null, now: number): void {
  s.video = null;
  const a = activityId ? s.activities.find((x) => x.id === activityId) : undefined;
  if (a?.videoId && s.videos.some((v) => v.id === a.videoId)) play(s, a.videoId, a.id, now);
}

/** When the clip will have finished, if we know how long it is. */
export function videoEndsAt(s: ServerState): number | null {
  const pb = s.video;
  if (!pb?.playing) return null;
  const v = s.videos.find((x) => x.id === pb.videoId);
  if (!v?.durationMs) return null;
  return pb.since + (v.durationMs - pb.positionMs) + 1000;
}

/** Called by the alarm: clears a clip that has finished. */
export function videoAlarm(s: ServerState, now: number): boolean {
  const end = videoEndsAt(s);
  if (end !== null && now >= end - 250) {
    s.video = null;
    return true;
  }
  return false;
}

function findWinner(s: ServerState, id: unknown) {
  const w = s.prize.pastWinners.find((x) => x.id === id);
  if (!w) throw new UserError("That photo no longer exists.");
  return w;
}

export const showHost: Record<string, Handler> = {
  "video.rename": (s, _a, p) => {
    const v = findVideo(s, p.id);
    v.name = str(p, "name", { max: VIDEO_NAME_MAX, label: "a name for the video" });
    return {};
  },

  "video.delete": (s, _a, p) => {
    const v = findVideo(s, p.id);
    if (s.video?.videoId === v.id) s.video = null;
    for (const a of s.activities) if (a.videoId === v.id) a.videoId = null;
    s.videos = s.videos.filter((x) => x !== v);
    return { audit: ["video.delete", v.name], deleteVideos: [v.id] };
  },

  /** Attaches a clip to an activity (null detaches it). */
  "activity.video": (s, _a, p) => {
    const a = s.activities.find((x) => x.id === p.activityId);
    if (!a) throw new UserError("That activity no longer exists.");
    a.videoId = p.videoId === null ? null : findVideo(s, p.videoId).id;
    return { audit: ["activity.video", a.videoId ? `${a.name} opens with ${findVideo(s, a.videoId).name}` : `${a.name}: no video`] };
  },

  /** Plays any clip on the TV now. */
  "video.play": (s, _a, p, now) => {
    const v = findVideo(s, p.videoId);
    play(s, v.id, null, now);
    return { audit: ["video.play", `${v.name} on the TV`] };
  },

  "video.pause": (s, _a, _p, now) => {
    const pb = s.video;
    if (!pb) throw new UserError("Nothing is playing.");
    if (!pb.playing) return { noChange: true };
    s.video = { ...pb, playing: false, positionMs: pb.positionMs + (now - pb.since), since: now };
    return {};
  },

  "video.resume": (s, _a, _p, now) => {
    const pb = s.video;
    if (!pb) throw new UserError("Nothing is playing.");
    if (pb.playing) return { noChange: true };
    s.video = { ...pb, playing: true, since: now };
    return {};
  },

  "video.restart": (s, _a, _p, now) => {
    const pb = s.video;
    if (!pb) throw new UserError("Nothing is playing.");
    play(s, pb.videoId, pb.activityId, now);
    return {};
  },

  /** Stops the clip and shows whatever is underneath. */
  "video.skip": (s) => {
    if (!s.video) return { noChange: true };
    s.video = null;
    return { audit: ["video.skip", "Video skipped"] };
  },

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
