// The event room: one Durable Object holds the whole event and is the only
// place state changes. It handles one request at a time, so a double-tapped
// spin or two simultaneous awards can never collide.

import { DurableObject } from "cloudflare:workers";
import type { AuditEntry, ClientRequest, Role, ServerMessage } from "../shared/types";
import { onAlarm, runAction, UserError, type Actor } from "./logic";
import { randomToken } from "./random";
import { freshState, type ServerState } from "./state";
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
      const stored = await ctx.storage.get<ServerState>("state");
      if (stored) {
        this.state = stored;
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
      } else refusal = "Open the stage from the control room.";
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
      if (result.alarmAt !== undefined) {
        if (result.alarmAt === null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(result.alarmAt);
      }
      if (result.welcome) {
        ws.serializeAttachment({
          role: "player",
          playerId: result.welcome.playerId,
          token: result.welcome.token,
        } satisfies Attachment);
        ws.send(json({ type: "welcome", rid: req.rid, ...result.welcome }));
      } else {
        ws.send(json({ type: "ok", rid: req.rid, data: result.data }));
      }
      this.broadcast();
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
      this.audit("naming.close", "Team naming closed automatically", now);
      this.broadcast();
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
