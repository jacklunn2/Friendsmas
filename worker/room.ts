// The event room: one Durable Object holds the whole event and is the only
// place state changes. It handles one request at a time, so a double-tapped
// spin or two simultaneous awards can never collide.

import { DurableObject } from "cloudflare:workers";
import {
  IMAGE_MAX_BYTES,
  PHOTO_MAX_BYTES,
  VIDEO_CHUNK_BYTES,
  type AuditEntry,
  type ClientRequest,
  type Role,
  type ServerMessage,
} from "../shared/types";
import { nextAlarmAt, onAlarm, runAction, UserError, type Actor } from "./logic";
import { randomToken } from "./random";
import { checkVideoUpload, registerVideo } from "./show";
import { freshState, migrate, type ServerState } from "./state";
import { hostView, playerView, stageView } from "./views";

export interface Env {
  ROOM: DurableObjectNamespace<EventRoom>;
  ASSETS: Fetcher;
  HOST_PASSWORD?: string;
}

interface Attachment {
  role: Role;
  playerId: string | null;
  /** The host's or guest's secret, re-checked on every message. */
  token: string | null;
}

const MAX_HOST_SESSIONS = 8;
const AUDIT_IN_VIEW = 40;

export class EventRoom extends DurableObject<Env> {
  private state!: ServerState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)",
      );
      // Guest profile photos: small square JPEGs, resized on the phone.
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS photos (player_id TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)",
      );
      // Quiz pictures, uploaded from the control room.
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)",
      );
      // Video clips, uploaded in chunks of up to VIDEO_CHUNK_BYTES (one row each,
      // under SQLite's 2 MB limit). A clip only joins the event once complete.
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, name TEXT NOT NULL, duration_ms INTEGER, complete INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
      );
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS video_chunks (video_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (video_id, idx))",
      );
      // TVs waiting to be connected: the TV shows a 4-digit code, the host types it in.
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS tv_pairings (id TEXT PRIMARY KEY, code TEXT NOT NULL, created_at INTEGER NOT NULL, event_code TEXT)",
      );
      const stored = await ctx.storage.get<ServerState>("state");
      if (stored) {
        this.state = migrate(stored);
      } else {
        this.state = freshState(Date.now());
        await ctx.storage.put("state", this.state);
      }
    });
  }

  // -------------------------------------------------------------------------
  // HTTP

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/host/login" && request.method === "POST") return this.hostLogin(request);
    if (url.pathname === "/api/ws") return this.openSocket(request, url);
    if (url.pathname === "/api/photo" && request.method === "POST") return this.uploadPhoto(request);
    if (url.pathname === "/api/image" && request.method === "POST") return this.uploadImage(request);
    const image = url.pathname.match(/^\/api\/image\/([A-Za-z0-9_-]+)$/);
    if (image && request.method === "GET") return this.serveImage(image[1], url);
    if (url.pathname === "/api/tv/pair" && request.method === "POST") return this.startTvPairing(request);
    const pairing = url.pathname.match(/^\/api\/tv\/pair\/([A-Za-z0-9_-]+)$/);
    if (pairing && request.method === "GET") return this.tvPairingStatus(pairing[1]);
    if (url.pathname === "/api/video" && request.method === "POST") return this.beginVideo(request);
    const chunk = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]+)\/chunk\/(\d+)$/);
    if (chunk && request.method === "PUT") return this.videoChunk(request, chunk[1], Number(chunk[2]));
    const done = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]+)\/done$/);
    if (done && request.method === "POST") return this.finishVideo(request, done[1]);
    const video = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]+)$/);
    if (video && request.method === "GET") return this.serveVideo(video[1], url, request);
    const photo = url.pathname.match(/^\/api\/photo\/([a-z0-9]+)$/);
    if (photo && request.method === "GET") return this.servePhoto(photo[1], url);
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async hostLogin(request: Request): Promise<Response> {
    const expected = this.env.HOST_PASSWORD;
    if (!expected) {
      return Response.json(
        { error: "The host password isn't set up yet. Add HOST_PASSWORD in the Cloudflare dashboard." },
        { status: 503 },
      );
    }
    let password = "";
    try {
      const body = (await request.json()) as { password?: unknown };
      password = typeof body.password === "string" ? body.password : "";
    } catch {
      // fall through to the wrong-password response
    }
    if (!(await safeEqual(password, expected))) {
      await sleep(600);
      return Response.json({ error: "That password isn't right." }, { status: 401 });
    }
    const token = randomToken();
    this.state.hostTokens = [...this.state.hostTokens, { token, createdAt: Date.now() }].slice(-MAX_HOST_SESSIONS);
    await this.ctx.storage.put("state", this.state);
    this.audit("host.login", "Host signed in");
    return Response.json({ token });
  }

  // -------------------------------------------------------------------------
  // Photos

  private async uploadPhoto(request: Request): Promise<Response> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > PHOTO_MAX_BYTES) return Response.json({ error: "That photo is too large." }, { status: 413 });
    // Read the body before answering, so every response leaves the connection clean.
    const data = await request.arrayBuffer();
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const me = token ? this.state.players.find((p) => p.token === token) : undefined;
    if (!me) return Response.json({ error: "Join the event first, then add your photo." }, { status: 401 });
    if (!(request.headers.get("content-type") ?? "").startsWith("image/jpeg")) {
      return Response.json({ error: "Photos must be JPEG images." }, { status: 415 });
    }
    if (data.byteLength > PHOTO_MAX_BYTES) return Response.json({ error: "That photo is too large." }, { status: 413 });
    const head = new Uint8Array(data, 0, Math.min(3, data.byteLength));
    if (data.byteLength < 100 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
      return Response.json({ error: "That doesn't look like a photo." }, { status: 415 });
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO photos (player_id, data, updated_at) VALUES (?, ?, ?)",
      me.id,
      data,
      now,
    );
    me.photo = (me.photo ?? 0) + 1;
    this.state.version += 1;
    await this.ctx.storage.put("state", this.state);
    this.audit("player.photo", `${me.name} added a photo`, now);
    this.broadcast();
    return Response.json({ photo: me.photo });
  }

  private servePhoto(playerId: string, url: URL): Response {
    if (url.searchParams.get("c") !== this.state.eventCode) return new Response("Not found", { status: 404 });
    const row = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM photos WHERE player_id = ?", playerId)
      .toArray()[0];
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(row.data, {
      headers: {
        "content-type": "image/jpeg",
        // The URL changes whenever the photo does, so it can be cached for good.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }

  private async scheduleAlarm(): Promise<void> {
    const at = nextAlarmAt(this.state);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 50));
  }

  private deleteImages(ids: string[]): void {
    for (const id of ids) this.ctx.storage.sql.exec("DELETE FROM images WHERE id = ?", id);
  }

  private async uploadImage(request: Request): Promise<Response> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > IMAGE_MAX_BYTES) return Response.json({ error: "That picture is too large." }, { status: 413 });
    const data = await request.arrayBuffer();
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token || !this.state.hostTokens.some((t) => t.token === token)) {
      return Response.json({ error: "Sign in to the control room again." }, { status: 401 });
    }
    const type = request.headers.get("content-type") ?? "";
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return Response.json({ error: "Pictures must be JPEG, PNG or WebP." }, { status: 415 });
    if (data.byteLength > IMAGE_MAX_BYTES) return Response.json({ error: "That picture is too large." }, { status: 413 });
    if (data.byteLength < 100) return Response.json({ error: "That doesn't look like a picture." }, { status: 415 });
    const id = randomToken(12);
    this.ctx.storage.sql.exec("INSERT INTO images (id, type, data, created_at) VALUES (?, ?, ?, ?)", id, type, data, Date.now());
    return Response.json({ id });
  }

  private serveImage(id: string, url: URL): Response {
    if (url.searchParams.get("c") !== this.state.eventCode) return new Response("Not found", { status: 404 });
    const row = this.ctx.storage.sql
      .exec<{ type: string; data: ArrayBuffer }>("SELECT type, data FROM images WHERE id = ?", id)
      .toArray()[0];
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(row.data, { headers: { "content-type": row.type, "cache-control": "private, max-age=31536000, immutable" } });
  }

  // -------------------------------------------------------------------------
  // Connecting a TV: it shows a short code, the host types it into the control
  // room, and the TV is sent the stage link. Codes last ten minutes.

  private static PAIR_MS = 10 * 60_000;

  private async startTvPairing(request: Request): Promise<Response> {
    await request.arrayBuffer();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM tv_pairings WHERE created_at < ?", Date.now() - EventRoom.PAIR_MS);
    const waiting = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tv_pairings WHERE event_code IS NULL").toArray()[0].n;
    if (waiting >= 20) return Response.json({ error: "Too many TVs waiting. Try again in a few minutes." }, { status: 429 });
    const taken = new Set(sql.exec<{ code: string }>("SELECT code FROM tv_pairings").toArray().map((r) => r.code));
    let code = "";
    do {
      code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
    } while (taken.has(code));
    const id = randomToken(16);
    sql.exec("INSERT INTO tv_pairings (id, code, created_at, event_code) VALUES (?, ?, ?, NULL)", id, code, Date.now());
    return Response.json({ id, code, expiresInMs: EventRoom.PAIR_MS });
  }

  private tvPairingStatus(id: string): Response {
    const row = this.ctx.storage.sql
      .exec<{ code: string; created_at: number; event_code: string | null }>("SELECT code, created_at, event_code FROM tv_pairings WHERE id = ?", id)
      .toArray()[0];
    if (!row || row.created_at < Date.now() - EventRoom.PAIR_MS) return Response.json({ status: "expired" }, { status: 404 });
    if (!row.event_code) return Response.json({ status: "waiting", code: row.code });
    this.ctx.storage.sql.exec("DELETE FROM tv_pairings WHERE id = ?", id);
    return Response.json({ status: "connected", eventCode: row.event_code });
  }

  /** The host typed a TV's code into the control room. */
  private connectTv(rawCode: unknown): string {
    const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
    if (code.length !== 4) throw new UserError("Type the 4-digit code shown on the TV.");
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ id: string }>("SELECT id FROM tv_pairings WHERE code = ? AND event_code IS NULL AND created_at >= ?", code, Date.now() - EventRoom.PAIR_MS)
      .toArray()[0];
    if (!row) throw new UserError("No TV is showing that code. Check the number, or refresh the page on the TV for a new one.");
    sql.exec("UPDATE tv_pairings SET event_code = ? WHERE id = ?", this.state.eventCode, row.id);
    return code;
  }

  // -------------------------------------------------------------------------
  // Videos

  private isHost(request: Request): boolean {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    return !!token && this.state.hostTokens.some((t) => t.token === token);
  }

  /** Starts an upload: checks the size and type, and returns an id to send chunks to. */
  private async beginVideo(request: Request): Promise<Response> {
    // Always read the body before replying, even to refuse it.
    let body: { name?: unknown; type?: unknown; size?: unknown; durationMs?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      // checked below
    }
    if (!this.isHost(request)) return Response.json({ error: "Sign in to the control room again." }, { status: 401 });
    const size = Number(body.size);
    const type = typeof body.type === "string" ? body.type : "";
    try {
      checkVideoUpload(this.state, size, type);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    // Forget uploads that were abandoned part-way.
    const stale = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM videos WHERE complete = 0 AND created_at < ?", Date.now() - 2 * 3600_000)
      .toArray();
    this.deleteVideos(stale.map((r) => r.id));
    const id = randomToken(12);
    const chunks = Math.ceil(size / VIDEO_CHUNK_BYTES);
    const duration = Number(body.durationMs);
    this.ctx.storage.sql.exec(
      "INSERT INTO videos (id, type, size, chunks, name, duration_ms, complete, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      id,
      type,
      size,
      chunks,
      typeof body.name === "string" ? body.name.slice(0, 200) : "Video",
      Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      Date.now(),
    );
    return Response.json({ id, chunkSize: VIDEO_CHUNK_BYTES, chunks });
  }

  private videoRow(id: string) {
    return this.ctx.storage.sql
      .exec<{ id: string; type: string; size: number; chunks: number; name: string; duration_ms: number | null; complete: number; created_at: number }>(
        "SELECT * FROM videos WHERE id = ?",
        id,
      )
      .toArray()[0];
  }

  private async videoChunk(request: Request, id: string, idx: number): Promise<Response> {
    const data = await request.arrayBuffer();
    if (!this.isHost(request)) return Response.json({ error: "Sign in to the control room again." }, { status: 401 });
    const row = this.videoRow(id);
    if (!row || row.complete) return Response.json({ error: "That upload has expired. Start again." }, { status: 404 });
    if (!Number.isInteger(idx) || idx < 0 || idx >= row.chunks) return Response.json({ error: "Unexpected part of the video." }, { status: 400 });
    const expected = idx === row.chunks - 1 ? row.size - idx * VIDEO_CHUNK_BYTES : VIDEO_CHUNK_BYTES;
    if (data.byteLength !== expected) return Response.json({ error: "Part of the video went missing. Try again." }, { status: 400 });
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO video_chunks (video_id, idx, data) VALUES (?, ?, ?)", id, idx, data);
    return Response.json({ ok: true });
  }

  /** Checks every chunk arrived, then adds the clip to the event. */
  private async finishVideo(request: Request, id: string): Promise<Response> {
    await request.arrayBuffer();
    if (!this.isHost(request)) return Response.json({ error: "Sign in to the control room again." }, { status: 401 });
    const row = this.videoRow(id);
    if (!row) return Response.json({ error: "That upload has expired. Start again." }, { status: 404 });
    if (row.complete) return Response.json({ id });
    const got = this.ctx.storage.sql
      .exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM video_chunks WHERE video_id = ?", id)
      .toArray()[0];
    if (got.n !== row.chunks || got.bytes !== row.size) return Response.json({ error: "Some of the video is missing. Try uploading it again." }, { status: 400 });
    const draft = structuredClone(this.state);
    try {
      checkVideoUpload(draft, row.size, row.type);
    } catch (e) {
      this.deleteVideos([id]);
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    registerVideo(draft, { id, name: row.name, size: row.size, type: row.type, durationMs: row.duration_ms, createdAt: Date.now() });
    this.ctx.storage.sql.exec("UPDATE videos SET complete = 1 WHERE id = ?", id);
    draft.version += 1;
    this.state = draft;
    await this.ctx.storage.put("state", this.state);
    this.audit("video.add", `Uploaded ${row.name}`);
    this.broadcast();
    return Response.json({ id });
  }

  /** Streams a clip, a chunk at a time, honouring Range requests so the TV can seek. */
  private serveVideo(id: string, url: URL, request: Request): Response {
    if (url.searchParams.get("c") !== this.state.eventCode) return new Response("Not found", { status: 404 });
    const row = this.videoRow(id);
    if (!row || !row.complete) return new Response("Not found", { status: 404 });
    let start = 0;
    let end = row.size - 1;
    const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      if (range[1] === "" && range[2] !== "") {
        start = Math.max(0, row.size - Number(range[2]));
      } else {
        start = Number(range[1] || 0);
        if (range[2] !== "") end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= row.size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${row.size}` } });
      }
    }
    const sql = this.ctx.storage.sql;
    let pos = start;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos > end) {
          controller.close();
          return;
        }
        const idx = Math.floor(pos / VIDEO_CHUNK_BYTES);
        const data = sql.exec<{ data: ArrayBuffer }>("SELECT data FROM video_chunks WHERE video_id = ? AND idx = ?", id, idx).toArray()[0]?.data;
        if (!data) {
          controller.error(new Error("missing chunk"));
          return;
        }
        const from = pos - idx * VIDEO_CHUNK_BYTES;
        const to = Math.min(data.byteLength, end - idx * VIDEO_CHUNK_BYTES + 1);
        controller.enqueue(new Uint8Array(data.slice(from, to)));
        pos = idx * VIDEO_CHUNK_BYTES + to;
      },
    });
    const headers: Record<string, string> = {
      "content-type": row.type,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${row.size}`;
    return new Response(body, { status: range ? 206 : 200, headers });
  }

  private deleteVideos(ids: string[]): void {
    for (const id of ids) {
      this.ctx.storage.sql.exec("DELETE FROM video_chunks WHERE video_id = ?", id);
      this.ctx.storage.sql.exec("DELETE FROM videos WHERE id = ?", id);
    }
  }

  private deletePhotos(ids: string[]): void {
    for (const id of ids) this.ctx.storage.sql.exec("DELETE FROM photos WHERE player_id = ?", id);
  }

  private openSocket(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "Expected a WebSocket" }, { status: 426 });
    }
    const role = url.searchParams.get("role");
    const code = url.searchParams.get("code") ?? "";
    const token = url.searchParams.get("token") ?? "";

    const [client, server] = Object.values(new WebSocketPair());
    let attachment: Attachment | null = null;
    let refusal = "";

    if (role === "host") {
      if (this.state.hostTokens.some((t) => t.token === token)) attachment = { role: "host", playerId: null, token };
      else refusal = "Sign in again to open the control room.";
    } else if (role === "stage") {
      // A stage opened on the host's signed-in laptop may also spin the wheel.
      const isHost = !!token && this.state.hostTokens.some((t) => t.token === token);
      if (code === this.state.eventCode || isHost) {
        attachment = { role: "stage", playerId: null, token: isHost ? token : null };
      } else refusal = "This TV link is out of date.";
    } else if (role === "player") {
      if (code === this.state.eventCode) {
        const me = token ? this.state.players.find((p) => p.token === token) : undefined;
        attachment = { role: "player", playerId: me?.id ?? null, token: me ? token : null };
      } else refusal = "This invitation link isn't valid. Check it with the host.";
    } else {
      refusal = "Unknown screen.";
    }

    this.ctx.acceptWebSocket(server);
    if (!attachment) {
      server.send(json({ type: "unauthorized", message: refusal }));
      server.close(4001, "unauthorized");
    } else {
      server.serializeAttachment(attachment);
      server.send(json({ type: "state", view: this.viewFor(attachment) }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // WebSocket messages

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = this.checkedAttachment(ws);
    if (!att) return;
    let req: ClientRequest;
    try {
      req = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (req.a === "ping") {
      ws.send(json({ type: "ok", rid: req.rid }));
      return;
    }

    // The stage can only ever spin the wheel, and only on the host's laptop.
    if (att.role === "stage") {
      if (req.a !== "draw.spin" || !att.token) {
        ws.send(json({ type: "error", rid: req.rid, message: "Use the control room for that." }));
        return;
      }
    }
    if (req.a === "tv.connect" && att.role === "host") {
      try {
        const code = this.connectTv((req.p ?? {}).code);
        this.audit("tv.connect", `Connected a TV (code ${code})`, Date.now());
        ws.send(json({ type: "ok", rid: req.rid }));
      } catch (err) {
        ws.send(json({ type: "error", rid: req.rid, message: err instanceof UserError ? err.message : "Couldn't connect the TV." }));
      }
      return;
    }
    const actor: Actor = { role: att.role === "stage" ? "host" : att.role, playerId: att.playerId };
    const now = Date.now();
    // Work on a copy so a failed action can never leave half-applied changes.
    const draft = structuredClone(this.state);
    try {
      const result = runAction(draft, actor, req.a, req.p ?? {}, now);
      if (result.noChange) {
        ws.send(json({ type: "ok", rid: req.rid, data: result.data }));
        return;
      }
      draft.version += 1;
      this.state = draft;
      await this.ctx.storage.put("state", this.state);
      if (result.audit) this.audit(result.audit[0], result.audit[1], now);
      if (result.deletePhotos) this.deletePhotos(result.deletePhotos);
      if (result.deleteImages) this.deleteImages(result.deleteImages);
      if (result.deleteVideos) this.deleteVideos(result.deleteVideos);
      await this.scheduleAlarm();
      if (result.welcome) {
        ws.serializeAttachment({
          role: "player",
          playerId: result.welcome.playerId,
          token: result.welcome.token,
        } satisfies Attachment);
      }
      // Send the new state first, so by the time a screen hears "done",
      // it already shows the result of its action.
      this.broadcast();
      if (result.welcome) ws.send(json({ type: "welcome", rid: req.rid, ...result.welcome }));
      else ws.send(json({ type: "ok", rid: req.rid, data: result.data }));
    } catch (err) {
      const message = err instanceof UserError ? err.message : "Something went wrong on the server. Try again.";
      if (!(err instanceof UserError)) console.error("Action failed", req.a, err);
      ws.send(json({ type: "error", rid: req.rid, message }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    if (onAlarm(this.state, now)) {
      this.state.version += 1;
      await this.ctx.storage.put("state", this.state);
      await this.scheduleAlarm();
      this.audit("alarm", "Time ran out", now);
      this.broadcast();
    } else {
      await this.scheduleAlarm();
    }
  }

  // -------------------------------------------------------------------------
  // Helpers

  /**
   * Re-validates a socket's identity against current state. A guest whose
   * phone was unlinked or removed becomes anonymous; a host whose session
   * no longer exists is disconnected.
   */
  private checkedAttachment(ws: WebSocket): Attachment | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return null;
    if (att.role === "host" && !this.state.hostTokens.some((t) => t.token === att.token)) {
      ws.send(json({ type: "unauthorized", message: "Sign in again to open the control room." }));
      ws.close(4001, "unauthorized");
      return null;
    }
    if (att.role === "stage" && att.token && !this.state.hostTokens.some((t) => t.token === att.token)) {
      const plain: Attachment = { role: "stage", playerId: null, token: null };
      ws.serializeAttachment(plain);
      return plain;
    }
    if (att.role === "player" && att.playerId) {
      const me = this.state.players.find((p) => p.id === att.playerId);
      if (!me || !me.token || me.token !== att.token) {
        const anon: Attachment = { role: "player", playerId: null, token: null };
        ws.serializeAttachment(anon);
        return anon;
      }
    }
    return att;
  }

  private viewFor(att: Attachment) {
    const now = Date.now();
    if (att.role === "host") return hostView(this.state, this.recentAudit(), now);
    if (att.role === "stage") return stageView(this.state, now, !!att.token);
    return playerView(this.state, att.playerId, now);
  }

  private broadcast(): void {
    const audit = this.recentAudit();
    const now = Date.now();
    const stage = json({ type: "state", view: stageView(this.state, now) });
    let stageWithSpin: string | null = null;
    let host: string | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.checkedAttachment(ws);
      if (!att) continue;
      try {
        if (att.role === "stage") {
          ws.send(att.token ? (stageWithSpin ??= json({ type: "state", view: stageView(this.state, now, true) })) : stage);
        }
        else if (att.role === "host") ws.send((host ??= json({ type: "state", view: hostView(this.state, audit, now) })));
        else ws.send(json({ type: "state", view: playerView(this.state, att.playerId, now) }));
      } catch {
        // socket closing; the client will reconnect
      }
    }
  }

  private audit(action: string, detail: string, at = Date.now()): void {
    this.ctx.storage.sql.exec("INSERT INTO audit (at, action, detail) VALUES (?, ?, ?)", at, action, detail);
  }

  private recentAudit(): AuditEntry[] {
    return this.ctx.storage.sql
      .exec<{ at: number; action: string; detail: string }>(
        "SELECT at, action, detail FROM audit ORDER BY id DESC LIMIT ?",
        AUDIT_IN_VIEW,
      )
      .toArray()
      .map((r) => ({ at: r.at, action: r.action, detail: r.detail }));
  }
}

function json(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
