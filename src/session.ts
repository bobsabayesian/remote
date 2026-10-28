import { DurableObject } from "cloudflare:workers";

export interface Project {
  name: string;
  slug: string;
  createdAt: number;
}

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
export class Session extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/init" && req.method === "POST") {
      if (await this.ctx.storage.get("project")) return new Response("exists", { status: 409 });
      const { name, slug } = (await req.json()) as { name: string; slug: string };
      const project: Project = { name, slug, createdAt: Date.now() };
      await this.ctx.storage.put("project", project);
      return Response.json(project);
    }

    if (url.pathname === "/info") {
      const project = await this.ctx.storage.get<Project>("project");
      return project ? Response.json(project) : new Response("not found", { status: 404 });
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
