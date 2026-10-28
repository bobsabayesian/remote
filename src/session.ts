import { DurableObject } from "cloudflare:workers";

export interface Project {
  name: string;
  slug: string;
  createdAt: number;
  lastActive?: number;
  /** Set when the first photo/video upload begins; the name/folder can no longer change. */
  locked?: boolean;
}

interface SessionEnv {
  FILES: R2Bucket;
  RETENTION_DAYS?: string;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

interface Peer {
  id: string;
  role: "camera" | "controller";
}

/**
 * One Durable Object per session code. It remembers the project the code
 * belongs to and relays signaling/commands between the camera device and any
 * number of controllers. Camera -> all controllers, controller -> camera,
 * unless a message carries an explicit `to` peer id.
 */
export class Session extends DurableObject<SessionEnv> {
  constructor(ctx: DurableObjectState, env: SessionEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/init" && req.method === "POST") {
      if (await this.ctx.storage.get("project")) return new Response("exists", { status: 409 });
      const { name, slug } = (await req.json()) as { name: string; slug: string };
      const project: Project = { name, slug, createdAt: Date.now(), lastActive: Date.now() };
      await this.ctx.storage.put("project", project);
      await this.ctx.storage.setAlarm(Date.now() + this.sweepEvery());
      return Response.json(project);
    }

    if (url.pathname === "/rename" && req.method === "POST") {
      const project = await this.ctx.storage.get<Project>("project");
      if (!project) return new Response("not found", { status: 404 });
      if (project.locked) return new Response("locked", { status: 409 });
      const { name, slug } = (await req.json()) as { name: string; slug: string };
      project.name = name;
      project.slug = slug;
      await this.ctx.storage.put("project", project);
      this.broadcast({ type: "renamed", name, folder: `remote/${slug}` });
      return Response.json(project);
    }

    if (url.pathname === "/lock" && req.method === "POST") {
      const project = await this.ctx.storage.get<Project>("project");
      if (!project) return new Response("not found", { status: 404 });
      if (!project.locked) {
        project.locked = true;
        await this.ctx.storage.put("project", project);
        this.broadcast({ type: "locked" });
      }
      return Response.json(project);
    }

    if (url.pathname === "/info") {
      const project = await this.ctx.storage.get<Project>("project");
      if (!project) return new Response("not found", { status: 404 });
      if (Date.now() - (project.lastActive ?? 0) > HOUR) {
        project.lastActive = Date.now();
        await this.ctx.storage.put("project", project);
      }
      return Response.json(project);
    }

    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    const role = url.searchParams.get("role") === "camera" ? "camera" : "controller";
    const id = crypto.randomUUID().slice(0, 8);

    if (role === "camera") {
      for (const old of this.ctx.getWebSockets("camera")) old.close(4000, "replaced by another camera");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ id, role } satisfies Peer);

    const peers = this.open()
      .filter((w) => w !== server)
      .map((w) => w.deserializeAttachment() as Peer);
    server.send(JSON.stringify({ type: "welcome", id, peers }));
    this.broadcast({ type: "peer-joined", id, role }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Retention: files are deleted RETENTION_DAYS (default 7) after upload. Once
   * the folder is empty and the session has been idle that long, the project
   * itself is removed and its code stops working.
   */
  async alarm() {
    const project = await this.ctx.storage.get<Project>("project");
    if (!project) return;
    const cutoff = Date.now() - this.retention();
    const prefix = `remote/${project.slug}/`;
    const metaKey = prefix + ".project.json";
    let remaining = 0;
    let cursor: string | undefined;
    do {
      const page = await this.env.FILES.list({ prefix, cursor, limit: 1000 });
      const expired = page.objects.filter((o) => o.key !== metaKey && o.uploaded.getTime() < cutoff).map((o) => o.key);
      if (expired.length) await this.env.FILES.delete(expired);
      remaining += page.objects.length - expired.length - (page.objects.some((o) => o.key === metaKey) ? 1 : 0);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    if (remaining === 0 && (project.lastActive ?? 0) < cutoff) {
      await this.env.FILES.delete(metaKey);
      for (const w of this.ctx.getWebSockets()) w.close(1000, "session expired");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + this.sweepEvery());
  }

  private retention(): number {
    const days = Number(this.env.RETENTION_DAYS);
    return (days > 0 ? days : 7) * DAY;
  }

  private sweepEvery(): number {
    return Math.min(DAY, this.retention());
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > 65536) return;
    const me = ws.deserializeAttachment() as Peer;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    msg.from = me.id;
    const out = JSON.stringify(msg);
    const to = typeof msg.to === "string" ? msg.to : null;
    const targetRole = me.role === "camera" ? "controller" : "camera";
    for (const w of this.open()) {
      const peer = w.deserializeAttachment() as Peer;
      if (to ? peer.id === to : peer.role === targetRole) w.send(out);
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    this.left(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  private left(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Peer | null;
    if (me) this.broadcast({ type: "peer-left", id: me.id, role: me.role }, ws);
  }

  private open(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }

  private broadcast(msg: object, except?: WebSocket) {
    const out = JSON.stringify(msg);
    for (const w of this.open()) if (w !== except) w.send(out);
  }
}
