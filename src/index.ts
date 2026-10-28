import { Session, type Project } from "./session";

export { Session };

export interface Env {
  FILES: R2Bucket;
  SESSIONS: DurableObjectNamespace<Session>;
  ASSETS: Fetcher;
  // Optional: Cloudflare Calls TURN, for live view across strict NATs / cellular.
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}

const ROOT = "remote";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const CODE_LENGTH = 8;
const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
const MAX_PART_BYTES = 64 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      return Response.json({ error: "Server error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/projects" && req.method === "POST") return createProject(req, env);

  const m = /^\/api\/s\/([A-Za-z0-9-]+)\/([a-z]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!m) throw new HttpError(404, "Not found");
  const code = normalizeCode(m[1]);
  const [, , action, rest] = m;

  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(code));
  const infoRes = await stub.fetch("https://session/info");
  if (!infoRes.ok) throw new HttpError(404, "Unknown session code");
  const project = (await infoRes.json()) as Project;
  const prefix = `${ROOT}/${project.slug}/`;

  switch (`${req.method} ${action}`) {
    case "GET info":
      return Response.json({ code, name: project.name, slug: project.slug, folder: prefix.slice(0, -1) });
    case "POST rename":
      return rename(req, env, stub, project, prefix);
    case "GET ws":
      return stub.fetch(req);
    case "GET ice":
      return Response.json({ iceServers: await iceServers(env) });
    case "PUT photo":
      return putPhoto(req, env, prefix, url);
    case "POST mpu":
      return mpu(req, env, prefix, url, rest ?? "");
    case "PUT mpu":
      return mpu(req, env, prefix, url, rest ?? "");
    case "GET files":
      return listFiles(env, prefix);
    case "GET file":
      return getFile(req, env, prefix, rest ?? "");
  }
  throw new HttpError(404, "Not found");
}

// ---- projects ----------------------------------------------------------

async function createProject(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim().slice(0, 80);
  const nameSlug = slugify(name);

  if (nameSlug) {
    const taken = await env.FILES.head(`${ROOT}/${nameSlug}/.project.json`);
    if (taken) throw new HttpError(409, `A project called "${name}" already exists. Pick another name, or rejoin it with its session code.`);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const slug = nameSlug || code.toLowerCase();
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(code));
    const res = await stub.fetch("https://session/init", {
      method: "POST",
      body: JSON.stringify({ name: name || code, slug }),
    });
    if (res.status === 409) continue;
    await env.FILES.put(`${ROOT}/${slug}/.project.json`, JSON.stringify({ name: name || code, createdAt: Date.now() }), {
      httpMetadata: { contentType: "application/json" },
    });
    return Response.json({ code, name: name || code, slug });
  }
  throw new HttpError(500, "Could not allocate a session code, try again");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function randomCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length); // rejection sampling, no modulo bias
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Display name only: the folder (slug) stays put so existing files and links keep working.
async function rename(req: Request, env: Env, stub: DurableObjectStub<Session>, project: Project, prefix: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "Name can't be empty");
  await stub.fetch("https://session/rename", { method: "POST", body: JSON.stringify({ name }) });
  await env.FILES.put(`${prefix}.project.json`, JSON.stringify({ name, createdAt: project.createdAt }), {
    httpMetadata: { contentType: "application/json" },
  });
  return Response.json({ name });
}

// ---- uploads -----------------------------------------------------------

/** Relative file path inside the project folder: no traversal, no hidden files. */
function cleanName(name: string | null): string {
  if (!name || name.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(name)) throw new HttpError(400, "Bad file name");
  if (name.split("/").some((seg) => seg === "" || seg.startsWith("."))) throw new HttpError(400, "Bad file name");
  return name;
}

function contentType(req: Request, allowed: Set<string>): string {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!allowed.has(ct)) throw new HttpError(415, "Unsupported content type");
  return ct;
}

async function putPhoto(req: Request, env: Env, prefix: string, url: URL): Promise<Response> {
  const key = prefix + cleanName(url.searchParams.get("name"));
  const type = contentType(req, IMAGE_TYPES);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_PHOTO_BYTES) throw new HttpError(413, "Photo too large");
  const body = await req.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_PHOTO_BYTES) throw new HttpError(400, "Bad photo size");
  await env.FILES.put(key, body, { httpMetadata: { contentType: type } });
  return Response.json({ key, size: body.byteLength });
}

/**
 * Resumable video upload using R2 multipart:
 *   POST mpu/start?name=video.mp4        -> { uploadId }
 *   PUT  mpu/part?name=&uploadId=&n=     -> { partNumber, etag }
 *   POST mpu/complete?name=&uploadId=    body { parts }  -> { key }
 *   POST mpu/abort?name=&uploadId=
 */
async function mpu(req: Request, env: Env, prefix: string, url: URL, step: string): Promise<Response> {
  const key = prefix + cleanName(url.searchParams.get("name"));

  if (step === "start") {
    const type = (url.searchParams.get("type") ?? "").toLowerCase();
    if (!VIDEO_TYPES.has(type)) throw new HttpError(415, "Unsupported video type");
    const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: type } });
    return Response.json({ uploadId: upload.uploadId });
  }

  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) throw new HttpError(400, "Missing uploadId");
  const upload = env.FILES.resumeMultipartUpload(key, uploadId);

  if (step === "part" && req.method === "PUT") {
    const n = Number(url.searchParams.get("n"));
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, "Bad part number");
    const body = await req.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_PART_BYTES) throw new HttpError(400, "Bad part size");
    const part = await upload.uploadPart(n, body);
    return Response.json(part);
  }
  if (step === "complete" && req.method === "POST") {
    const { parts } = (await req.json()) as { parts: R2UploadedPart[] };
    if (!Array.isArray(parts) || !parts.length) throw new HttpError(400, "No parts");
    const obj = await upload.complete(parts);
    return Response.json({ key, size: obj.size });
  }
  if (step === "abort" && req.method === "POST") {
    await upload.abort();
    return Response.json({ ok: true });
  }
  throw new HttpError(404, "Not found");
}

// ---- reading files back --------------------------------------------------

async function listFiles(env: Env, prefix: string): Promise<Response> {
  const files: { name: string; size: number; uploaded: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      const name = o.key.slice(prefix.length);
      if (!name.startsWith(".")) files.push({ name, size: o.size, uploaded: o.uploaded.getTime() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && files.length < 20000);
  return Response.json({ files });
}

async function getFile(req: Request, env: Env, prefix: string, rest: string): Promise<Response> {
  const name = cleanName(decodeURIComponent(rest));
  const obj = await env.FILES.get(prefix + name, { range: req.headers, onlyIf: req.headers });
  if (!obj) throw new HttpError(404, "No such file");

  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", "private, max-age=3600");
  // Files are user uploads served from the app origin: never let them run as pages.
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "sandbox");

  if (!("body" in obj)) return new Response(null, { status: 304, headers: h });

  let status = 200;
  h.set("content-length", String(obj.size));
  const r = req.headers.has("range") ? (obj.range as { offset?: number; length?: number; suffix?: number } | undefined) : undefined;
  if (r) {
    const start = r.suffix !== undefined ? Math.max(0, obj.size - r.suffix) : (r.offset ?? 0);
    const end = r.suffix !== undefined || r.length === undefined ? obj.size - 1 : Math.min(obj.size - 1, start + r.length - 1);
    h.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    h.set("content-length", String(end - start + 1));
    status = 206;
  }
  return new Response(obj.body, { status, headers: h });
}

// ---- WebRTC ICE servers ---------------------------------------------------

async function iceServers(env: Env): Promise<unknown[]> {
  const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return stun;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (res.ok) {
      const data = (await res.json()) as { iceServers?: unknown[] };
      if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
    }
  } catch (e) {
    console.error("TURN credential request failed", e);
  }
  return stun;
}
