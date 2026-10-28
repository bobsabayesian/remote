import { zipFiles, saveBlob } from "./zip.js";
import { $, api, normCode, fmtCode, fmtDuration, fmtBytes, remember, connect, getIceServers, toast } from "./common.js";

const code = normCode(location.hash);
if (!code) location.replace("/");

let project;
try {
  project = await api(`/api/s/${code}/info`);
} catch (e) {
  document.body.innerHTML = `<main><section class="card"><h1>Session not found</h1><p class="muted">${e.message}</p><p><a href="/">Back</a></p></section></main>`;
  throw e;
}
remember(project);
document.title = `${project.name} · Control`;
$("projName").textContent = project.name;
$("folder").textContent = project.folder + "/";
$("code").textContent = fmtCode(code);

const iceServers = await getIceServers(code);
const video = $("remote");
let cameraId = null;
let pc = null;
let status = null;
let wsOpen = false;
const chain = { p: Promise.resolve() };

const conn = connect({
  code,
  role: "controller",
  onState(s) {
    wsOpen = s === "open";
    $("connPill").className = "pill " + (wsOpen ? "on" : "warn");
    $("connPill").textContent = wsOpen ? "Connected" : "Reconnecting…";
    if (!wsOpen) {
      cameraId = null;
      status = null;
      closePc();
    }
    render();
  },
  onMessage(m) {
    chain.p = chain.p.then(() => handle(m)).catch((e) => console.error(e));
  },
});

async function handle(m) {
  switch (m.type) {
    case "welcome": {
      const cam = m.peers.find((p) => p.role === "camera");
      cameraId = cam ? cam.id : null;
      render();
      break;
    }
    case "peer-joined":
      if (m.role === "camera") {
        cameraId = m.id;
        render();
      }
      break;
    case "peer-left":
      if (m.id === cameraId) {
        cameraId = null;
        status = null;
        closePc();
        render();
      }
      break;
    case "offer":
      await answer(m);
      break;
    case "ice":
      await pc?.addIceCandidate(m.candidate).catch(() => {});
      break;
    case "status":
      status = m;
      render();
      break;
    case "renamed":
      applyName(m.name);
      break;
    case "info":
      toast(m.message);
      break;
    case "saved":
      toast(`Saved ${m.name}`);
      flash(`Saved ${m.name}`);
      if (!$("filesPane").hidden) loadFiles();
      else filesStale = true;
      break;
    case "error":
      toast(m.message, "err");
      flash(m.message);
      break;
  }
}

// ---- live view ------------------------------------------------------------

function closePc() {
  pc?.close();
  pc = null;
  video.srcObject = null;
}

async function answer(m) {
  closePc();
  const conn_ = new RTCPeerConnection({ iceServers });
  pc = conn_;
  conn_.onicecandidate = (e) => e.candidate && conn.send({ type: "ice", to: m.from, candidate: e.candidate });
  conn_.ontrack = (e) => {
    video.srcObject = e.streams[0];
    video.play().catch(() => {});
    render();
  };
  conn_.onconnectionstatechange = () => render();
  await conn_.setRemoteDescription(m.sdp);
  await conn_.setLocalDescription(await conn_.createAnswer());
  conn.send({ type: "answer", to: m.from, sdp: conn_.localDescription });
}

// ---- commands ----------------------------------------------------------------

const send = (msg) => conn.send(msg);
const doPhoto = () => send({ type: "photo" });
const doRec = () => send({ type: status?.recording ? "rec-stop" : "rec-start" });
$("photo").onclick = doPhoto;
$("fPhoto").onclick = doPhoto;
$("fRec").onclick = doRec;
$("ask").onclick = () => {
  send({ type: "request-start" });
  $("ask").disabled = true;
  askCooling = true;
  setTimeout(() => ((askCooling = false), render()), 8000); // brief cooldown so the camera isn't spammed
  toast("Asked the camera device to turn on");
};
$("flip").onclick = () => send({ type: "flip" });
$("rec").onclick = doRec;
$("tl").onclick = () => {
  if (status?.timelapse) return send({ type: "tl-stop" });
  const sec = intervalSeconds();
  if (!(sec >= 1)) return toast("Interval must be at least 1 second", "err");
  send({ type: "tl-start", intervalSec: sec });
};

const intervalSeconds = () => Number($("every").value) * Number($("unit").value);

const PRESETS = [
  ["5 s", 5],
  ["10 s", 10],
  ["30 s", 30],
  ["1 min", 60],
  ["5 min", 300],
  ["15 min", 900],
  ["1 hr", 3600],
];
for (const [label, sec] of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onclick = () => {
    const unit = sec % 3600 === 0 ? 3600 : sec % 60 === 0 ? 60 : 1;
    $("unit").value = String(unit);
    $("every").value = String(sec / unit);
    updateHint();
  };
  $("presets").append(b);
}
function updateHint() {
  const sec = intervalSeconds();
  [...$("presets").children].forEach((b, i) => b.classList.toggle("active", PRESETS[i][1] === sec));
  if (!(sec >= 1)) return ($("tlHint").textContent = "");
  const perDay = Math.floor(86400 / sec);
  $("tlHint").textContent = `${perDay.toLocaleString()} frames per 24 h. At 30 fps playback, 24 h of capture is about ${fmtDuration(perDay / 30)} of video.`;
}
$("every").addEventListener("input", updateHint);
$("unit").addEventListener("change", updateHint);
updateHint();

// ---- fullscreen & composition grid ----------------------------------------------------

const stage = $("stage");
let flashTimer = 0;
let askCooling = false;
function flash(msg) {
  $("flash").innerHTML = "<span></span>";
  $("flash").firstChild.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => $("flash").replaceChildren(), 2500);
}
function setGrid(on) {
  $("grid").hidden = !on;
  $("gridBtn").setAttribute("aria-pressed", String(on));
  try { localStorage.setItem("remote.grid", on ? "1" : ""); } catch {}
}
$("gridBtn").onclick = $("fGrid").onclick = () => setGrid($("grid").hidden);
try { setGrid(!!localStorage.getItem("remote.grid")); } catch {}

async function enterFull() {
  stage.classList.add("full"); // CSS fallback for browsers without element fullscreen (iPhone Safari)
  try { await (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage, { navigationUI: "hide" }); } catch {}
}
async function exitFull() {
  stage.classList.remove("full");
  if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch?.(() => {});
}
$("fullBtn").onclick = enterFull;
$("fExit").onclick = exitFull;
for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(ev, () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) stage.classList.remove("full");
  });
}
document.addEventListener("keydown", (e) => e.key === "Escape" && stage.classList.contains("full") && exitFull());

// ---- rename (operator only; display name, folder stays) ----------------------------------

function applyName(name) {
  project.name = name;
  $("projName").textContent = name;
  document.title = `${name} · Control`;
  remember(project);
  $("renameForm").hidden = true;
  $("titleRow").hidden = false;
}
$("renameBtn").onclick = () => {
  $("titleRow").hidden = true;
  $("renameForm").hidden = false;
  $("folderNote").hidden = false;
  $("renameInput").value = project.name;
  $("renameInput").select();
};
$("renameCancel").onclick = () => {
  $("renameForm").hidden = true;
  $("titleRow").hidden = false;
  $("folderNote").hidden = true;
};
$("renameForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("renameInput").value.trim();
  if (!name) return;
  try {
    const r = await api(`/api/s/${code}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    applyName(r.name);
    $("folderNote").hidden = true;
    toast("Renamed");
  } catch (err) {
    toast(err.message, "err");
  }
};

// ---- rendering ------------------------------------------------------------------

function render() {
  const camOnline = !!cameraId;
  const streaming = !!status?.streaming;
  const ready = wsOpen && camOnline && streaming;
  $("camPill").className = "pill" + (streaming ? " on" : camOnline ? " warn" : "");
  $("camPill").textContent = streaming ? "Camera live" : camOnline ? "Camera not started" : "Camera offline";

  const hasVideo = !!video.srcObject;
  $("idle").hidden = hasVideo;
  $("idleMsg").textContent = !wsOpen
    ? "Connecting…"
    : !camOnline
      ? "Waiting for the camera device to open this session…"
      : !streaming
        ? "Camera page is open. Press “Start camera” on that device."
        : "Connecting live view… (controls still work if this stays blank)";

  $("photo").disabled = !ready;
  $("fPhoto").disabled = !ready;
  $("fRec").disabled = !ready && !status?.recording;
  $("fRec").textContent = status?.recording ? "■ Stop" : "● Record";
  $("fRec").classList.toggle("danger", !!status?.recording);
  $("ask").hidden = !(wsOpen && camOnline && !streaming);
  if (!$("ask").hidden && !askCooling) $("ask").disabled = false;
  $("flip").disabled = !ready || !!status?.recording;
  $("rec").disabled = !ready && !status?.recording;
  $("rec").textContent = status?.recording ? "■ Stop recording" : "● Record video";
  $("rec").classList.toggle("danger", !!status?.recording);
  $("tl").disabled = !ready && !status?.timelapse;
  $("tl").textContent = status?.timelapse ? `Stop timelapse (${status.timelapse.frames} frames)` : "Start timelapse";
  $("tl").classList.toggle("danger", !!status?.timelapse);

  $("recBadge").hidden = !status?.recording;
  $("tlBadge").hidden = !status?.timelapse;
  $("tlCount").textContent = status?.timelapse?.frames ?? 0;
  if (status?.recording) $("recTime").textContent = fmtDuration(status.recording.seconds);
  $("sRes").textContent = status?.size || "–";
  $("sPending").textContent = status?.pending ?? 0;
  $("sSaved").textContent = status?.saved ?? 0;
}
setInterval(() => wsOpen && !status && cameraId && send({ type: "get-status" }), 3000);

// ---- tabs & file gallery ----------------------------------------------------------

let filesStale = true;
let items = [];
let shown = 24;

function tab(name) {
  const files = name === "files";
  $("live").hidden = files;
  $("filesPane").hidden = !files;
  $("tabLive").setAttribute("aria-selected", String(!files));
  $("tabFiles").setAttribute("aria-selected", String(files));
  if (files && filesStale) loadFiles();
}
$("tabLive").onclick = () => tab("live");
$("tabFiles").onclick = () => tab("files");
$("refresh").onclick = () => loadFiles();
$("more").onclick = () => ((shown += 24), drawFiles());

const fileUrl = (name) => `/api/s/${code}/file/${name.split("/").map(encodeURIComponent).join("/")}`;
const kindOf = (name) => (/\.(jpe?g|png|webp)$/i.test(name) ? "image" : /\.(mp4|webm|mov)$/i.test(name) ? "video" : "other");

async function loadFiles() {
  filesStale = false;
  try {
    const { files } = await api(`/api/s/${code}/files`);
    const groups = new Map();
    items = [];
    for (const f of files) {
      const slash = f.name.indexOf("/");
      if (slash < 0) {
        items.push({ kind: kindOf(f.name), name: f.name, size: f.size, at: f.uploaded });
        continue;
      }
      const dir = f.name.slice(0, slash);
      let g = groups.get(dir);
      if (!g) items.push((g = { kind: "sequence", name: dir, frames: [], size: 0, at: 0 })), groups.set(dir, g);
      g.frames.push(f.name);
      g.size += f.size;
      g.at = Math.max(g.at, f.uploaded);
    }
    for (const g of groups.values()) g.frames.sort();
    items.sort((a, b) => b.at - a.at);
    drawFiles();
  } catch (e) {
    toast(e.message, "err");
  }
}

function drawFiles() {
  const box = $("files");
  box.replaceChildren();
  $("filesEmpty").hidden = items.length > 0;
  $("more").hidden = items.length <= shown;
  for (const it of items.slice(0, shown)) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    const thumbSrc = it.kind === "sequence" ? fileUrl(it.frames[it.frames.length - 1]) : fileUrl(it.name);
    let thumb;
    if (it.kind === "video") {
      thumb = document.createElement("video");
      thumb.src = thumbSrc + "#t=0.1";
      thumb.preload = "metadata";
      thumb.muted = true;
      thumb.playsInline = true;
    } else if (it.kind === "other") {
      thumb = document.createElement("div");
      thumb.className = "thumb";
    } else {
      thumb = document.createElement("img");
      thumb.src = thumbSrc;
      thumb.loading = "lazy";
      thumb.decoding = "async";
      thumb.alt = "";
    }
    thumb.classList.add("thumb");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = it.kind === "sequence" ? `${it.name} · ${fmtBytes(it.size)}` : `${it.name} · ${fmtBytes(it.size)}`;
    tile.append(thumb, meta);
    if (it.kind === "sequence" || it.kind === "video") {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = it.kind === "sequence" ? `▶ ${it.frames.length} frames` : "▶ video";
      tile.append(badge);
    }
    tile.onclick = () => openViewer(it);
    box.append(tile);
  }
}

async function downloadZip(entries, filename, button) {
  const label = button.textContent;
  button.disabled = true;
  try {
    const blob = await zipFiles(entries, (i, n) => (button.textContent = i < n ? `Zipping ${i + 1}/${n}…` : label));
    saveBlob(blob, filename);
  } catch (e) {
    toast(e.message, "err");
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

$("dlAll").onclick = () => {
  const entries = items.flatMap((it) => (it.kind === "sequence" ? it.frames : [it.name])).map((name) => ({ name, url: fileUrl(name) }));
  if (!entries.length) return toast("Nothing to download yet");
  downloadZip(entries, `${project.slug}.zip`, $("dlAll"));
};

const viewer = $("viewer");
let playTimer = 0;
function openViewer(it) {
  const body = $("viewBody");
  body.replaceChildren();
  $("viewDl").onclick = null;
  $("viewDl").textContent = "Download";
  $("viewName").textContent = it.name;
  const dl = $("viewDl");
  dl.hidden = false;
  if (it.kind === "sequence") {
    const img = document.createElement("img");
    const bar = document.createElement("div");
    bar.className = "bar";
    const play = document.createElement("button");
    play.textContent = "▶";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = String(it.frames.length - 1);
    range.value = "0";
    const label = document.createElement("span");
    label.className = "muted small";
    const show = (i) => {
      img.src = fileUrl(it.frames[i]);
      label.textContent = `${i + 1} / ${it.frames.length}`;
      new Image().src = fileUrl(it.frames[Math.min(i + 3, it.frames.length - 1)]); // warm the cache ahead of playback
    };
    const stop = () => (clearInterval(playTimer), (play.textContent = "▶"), (playTimer = 0));
    play.onclick = () => {
      if (playTimer) return stop();
      play.textContent = "❚❚";
      playTimer = setInterval(() => {
        const next = (Number(range.value) + 1) % it.frames.length;
        range.value = String(next);
        show(next);
      }, 120);
    };
    range.oninput = () => show(Number(range.value));
    bar.append(play, range, label);
    body.append(img, bar);
    dl.removeAttribute("download");
    dl.href = "#";
    dl.textContent = "Download frames (zip)";
    dl.onclick = (e) => {
      e.preventDefault();
      downloadZip(it.frames.map((name) => ({ name, url: fileUrl(name) })), `${it.name}.zip`, dl);
    };
    show(0);
  } else if (it.kind === "video") {
    const v = document.createElement("video");
    v.src = fileUrl(it.name);
    v.controls = true;
    v.playsInline = true;
    v.autoplay = true;
    body.append(v);
    dl.href = fileUrl(it.name);
    dl.download = it.name;
  } else {
    const img = document.createElement("img");
    img.src = fileUrl(it.name);
    body.append(img);
    dl.href = fileUrl(it.name);
    dl.download = it.name;
  }
  viewer.showModal();
}
viewer.addEventListener("close", () => {
  clearInterval(playTimer);
  playTimer = 0;
  $("viewBody").replaceChildren();
});
$("viewClose").onclick = () => viewer.close();

render();
