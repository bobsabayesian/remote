export const normCode = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const fmtCode = (c) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
export const $ = (id) => document.getElementById(id);

export async function api(path, opts) {
  const res = await fetch(path, opts);
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((isJson && body.error) || res.statusText || "Request failed");
  return body;
}

// Recently used sessions, per browser, so "come back later" is one tap.
const RECENT_KEY = "remote.recent";
export function recent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
export function remember({ code, name }) {
  try {
    const list = recent().filter((r) => r.code !== code);
    list.unshift({ code, name, at: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {}
}

export function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export async function getIceServers(code) {
  try {
    return (await api(`/api/s/${code}/ice`)).iceServers;
  } catch {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
}

/** WebSocket to the session room with automatic reconnect. */
export function connect({ code, role, onMessage, onState }) {
  let ws;
  let closed = false;
  let tries = 0;
  let pinger;

  function open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/s/${code}/ws?role=${role}`);
    ws.onopen = () => {
      tries = 0;
      onState("open");
      pinger = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = (e) => {
      clearInterval(pinger);
      if (closed) return;
      if (e.code === 4000) return onState("replaced");
      onState("closed");
      setTimeout(open, Math.min(10000, 500 * 2 ** tries++));
    };
  }
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      ws.close();
    },
  };
}

export function renderQR(el, text) {
  // eslint-disable-next-line no-undef
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function toast(msg, kind = "") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.append(box);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), 3500);
}
