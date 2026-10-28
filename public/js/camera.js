import { $, api, normCode, fmtCode, fmtDuration, stamp, remember, connect, getIceServers, renderQR, toast } from "./common.js";

const code = normCode(location.hash);
if (!code) location.replace("/");

const PART_SIZE = 8 * 1024 * 1024; // R2 multipart: every part but the last must be the same size (>= 5 MiB)
const MAX_QUEUE = 300;
const SIZES = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] };
const BITRATE = { 720: 5e6, 1080: 8e6, 2160: 20e6 };
const MIME_CANDIDATES = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

const preview = $("preview");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let project;
let iceServers = [];
let conn;
let stream = null;
let wantStream = false; // user pressed Start; try to recover if the OS kills the stream
let wake = null;

const controllers = new Set();
const pcs = new Map(); // controller id -> RTCPeerConnection

let rec = null; // active video recording
let finalizing = 0;
let tl = null; // active timelapse
const queue = []; // photo/frame uploads waiting
let uploading = false;
let saved = 0;
let lastSaved = "";

// ---- setup -------------------------------------------------------------

try {
  project = await api(`/api/s/${code}/info`);
} catch (e) {
  document.body.innerHTML = `<main><section class="card"><h1>Session not found</h1><p class="muted">${e.message}</p><p><a href="/">Back</a></p></section></main>`;
  throw e;
}
remember(project);
document.title = `${project.name} · Camera`;
$("projName").textContent = project.name;
$("folder").textContent = project.folder + "/";
$("code").textContent = fmtCode(code);
$("host").textContent = location.host;
const controlUrl = `${location.origin}/control.html#${code}`;
renderQR($("qr"), controlUrl);
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(controlUrl);
    toast("Link copied");
  } catch {
    prompt("Copy this link", controlUrl);
  }
};

iceServers = await getIceServers(code);
const chain = { p: Promise.resolve() }; // handle signaling messages one at a time, in order
conn = connect({
  code,
  role: "camera",
  onState(s) {
    const pill = $("connPill");
    pill.className = "pill " + (s === "open" ? "on" : "warn");
    pill.textContent = s === "open" ? "Online" : s === "replaced" ? "Another device took over" : "Reconnecting…";
    if (s !== "open") {
      controllers.clear();
      for (const id of [...pcs.keys()]) closePeer(id);
      renderControllers();
    }
  },
  onMessage(m) {
    chain.p = chain.p.then(() => handle(m)).catch((e) => console.error(e));
  },
});

// ---- messages from controllers --------------------------------------------

async function handle(m) {
  switch (m.type) {
    case "welcome":
      controllers.clear();
      for (const p of m.peers) if (p.role === "controller") controllers.add(p.id);
      renderControllers();
      for (const id of controllers) await greet(id);
      break;
    case "peer-joined":
      if (m.role !== "controller") break;
      controllers.add(m.id);
      renderControllers();
      await greet(m.id);
      break;
    case "peer-left":
      controllers.delete(m.id);
      closePeer(m.id);
      renderControllers();
      break;
    case "answer":
      await pcs.get(m.from)?.setRemoteDescription(m.sdp);
      break;
    case "ice":
      await pcs.get(m.from)?.addIceCandidate(m.candidate).catch(() => {});
      break;
    case "request-start":
      if (stream) break;
      showAsk();
      conn.send({ type: "info", to: m.from, message: "Prompt is showing on the camera device" });
      break;
    case "renamed":
      project.name = m.name;
      $("projName").textContent = m.name;
      $("folder").textContent = m.folder + "/";
      document.title = `${m.name} · Camera`;
      remember(project);
      break;
    case "get-status":
      sendStatus(m.from);
      break;
    case "photo":
      if (needStream()) takePhoto().catch(fail);
      break;
    case "rec-start":
      if (needStream()) startRecording().catch(fail);
      break;
    case "rec-stop":
      stopRecording();
      break;
    case "tl-start":
      if (needStream()) startTimelapse(Number(m.intervalSec));
      break;
    case "tl-stop":
      stopTimelapse();
      break;
    case "flip":
      $("facing").value = $("facing").value === "user" ? "environment" : "user";
      restartStream().catch(fail);
      break;
  }
}

function needStream() {
  if (stream) return true;
  fail(new Error("The camera isn't started on the camera device"));
  return false;
}

function fail(e) {
  console.error(e);
  toast(e.message, "err");
  conn.send({ type: "error", message: e.message });
}

async function greet(id) {
  sendStatus(id);
  if (stream) await offerTo(id);
}

// ---- WebRTC live view (camera is always the offerer) ----------------------------

function closePeer(id) {
  pcs.get(id)?.close();
  pcs.delete(id);
}

async function offerTo(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers });
  pcs.set(id, pc);
  for (const t of stream.getVideoTracks()) pc.addTrack(t, stream);
  pc.onicecandidate = (e) => e.candidate && conn.send({ type: "ice", to: id, candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" && pcs.get(id) === pc) offerTo(id).catch(() => {});
  };
  await pc.setLocalDescription(await pc.createOffer());
  conn.send({ type: "offer", to: id, sdp: pc.localDescription });
}

// ---- camera stream --------------------------------------------------------

async function startStream() {
  const [w, h] = SIZES[$("res").value];
  const facing = $("facing").value;
  stream?.getTracks().forEach((t) => t.stop()); // iOS needs the old camera released first
  stream = null;

  const video = { facingMode: { ideal: facing }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({ video, audio: $("audio").checked });
  } catch (e) {
    if (!$("audio").checked) throw e;
    s = await navigator.mediaDevices.getUserMedia({ video, audio: false }); // mic refused; carry on silent
    $("audio").checked = false;
    toast("Microphone unavailable, recording without audio", "err");
  }
  stream = s;
  wantStream = true;
  s.getVideoTracks()[0].addEventListener("ended", () => {
    if (stream === s) stream = null;
    render();
  });

  preview.srcObject = s;
  await preview.play().catch(() => {});
  if (!preview.videoWidth) await new Promise((r) => preview.addEventListener("loadedmetadata", r, { once: true }));
  keepAwake();

  const track = s.getVideoTracks()[0];
  for (const [id, pc] of pcs) {
    const sender = pc.getSenders().find((x) => x.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }
  for (const id of controllers) if (!pcs.has(id)) await offerTo(id);
  hideAsk();
  render();
  sendStatus();
}

async function restartStream() {
  if (rec) throw new Error("Stop recording before changing camera settings");
  if (!wantStream) return;
  await startStream();
}

async function toggleCamera() {
  $("camErr").textContent = "";
  try {
    if (stream) {
      wantStream = false;
      stopTimelapse();
      stopRecording();
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      preview.srcObject = null;
      for (const id of [...pcs.keys()]) closePeer(id);
      wake?.release().catch(() => {});
      render();
      sendStatus();
    } else {
      await startStream();
    }
  } catch (e) {
    $("camErr").textContent = e.name === "NotAllowedError" ? "Camera access was blocked. Allow it in the browser settings and try again." : e.message;
  }
}
$("start").onclick = toggleCamera;

// The operator can ask for the camera, but browsers only grant access after a tap on this device.
let titleFlash = 0;
function showAsk() {
  $("ask").hidden = false;
  navigator.vibrate?.([300, 150, 300]);
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {}
  clearInterval(titleFlash);
  const orig = document.title;
  let on = false;
  titleFlash = setInterval(() => (document.title = (on = !on) ? "📷 Start the camera!" : orig), 1000);
  $("ask").dataset.title = orig;
}
function hideAsk() {
  $("ask").hidden = true;
  clearInterval(titleFlash);
  if ($("ask").dataset.title) document.title = $("ask").dataset.title;
}
$("askStart").onclick = async () => {
  hideAsk();
  if (!stream) await toggleCamera();
};
$("askDismiss").onclick = hideAsk;
for (const id of ["facing", "res", "audio"]) {
  $(id).addEventListener("change", () => restartStream().catch((e) => ($("camErr").textContent = e.message)));
}

async function keepAwake() {
  try {
    wake = await navigator.wakeLock?.request("screen");
    wake?.addEventListener("release", () => (wake = null));
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !wantStream) return;
  if (!wake) keepAwake();
  if (!stream) startStream().catch(() => {});
});

// ---- photos & uploads -----------------------------------------------------

const canvas = document.createElement("canvas");
function grabFrame() {
  if (!stream || !preview.videoWidth) throw new Error("Camera isn't producing video");
  canvas.width = preview.videoWidth;
  canvas.height = preview.videoHeight;
  canvas.getContext("2d").drawImage(preview, 0, 0);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Capture failed"))), "image/jpeg", 0.92));
}

async function takePhoto() {
  const blob = await grabFrame();
  enqueue(`photo-${stamp()}-${String(Date.now() % 1000).padStart(3, "0")}.jpg`, blob);
}

function enqueue(name, blob) {
  if (queue.length >= MAX_QUEUE) {
    const dropped = queue.shift();
    toast(`Upload backlog full, dropped ${dropped.name}`, "err");
  }
  queue.push({ name, blob });
  render();
  pump();
}

async function pump() {
  if (uploading) return;
  uploading = true;
  let delay = 1000;
  while (queue.length) {
    const item = queue[0];
    try {
      const res = await fetch(`/api/s/${code}/photo?name=${encodeURIComponent(item.name)}`, {
        method: "PUT",
        headers: { "content-type": item.blob.type },
        body: item.blob,
      });
      if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        fail(new Error(`Server rejected ${item.name} (${res.status})`));
      } else if (!res.ok) {
        throw new Error(String(res.status));
      } else {
        markSaved(item.name, "photo");
      }
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      delay = 1000;
    } catch {
      await sleep(delay);
      delay = Math.min(30000, delay * 2);
    }
    render();
  }
  uploading = false;
}

function markSaved(name, kind) {
  saved++;
  lastSaved = name;
  conn.send({ type: "saved", name, kind });
  render();
}

// ---- video recording (streamed to R2 as multipart) ----------------------------

function pickMime() {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

async function startRecording() {
  if (rec) return;
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), videoBitsPerSecond: BITRATE[$("res").value] });
  const type = (recorder.mimeType || mime || "video/mp4").split(";")[0];
  const name = `video-${stamp()}.${type.includes("mp4") ? "mp4" : "webm"}`;
  const q = `name=${encodeURIComponent(name)}`;
  const { uploadId } = await api(`/api/s/${code}/mpu/start?${q}&type=${encodeURIComponent(type)}`, { method: "POST" });

  const r = (rec = { recorder, name, q: `${q}&uploadId=${encodeURIComponent(uploadId)}`, buf: new Blob(), parts: [], n: 0, started: Date.now(), chain: Promise.resolve(), failed: false });
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    r.buf = new Blob([r.buf, e.data]);
    drain(r, false);
  };
  recorder.onstop = () => finishRecording(r);
  recorder.start(1000);
  render();
  sendStatus();
}

function stopRecording() {
  if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
}

function drain(r, final) {
  r.chain = r.chain
    .then(async () => {
      while (!r.failed && (r.buf.size >= PART_SIZE || (final && r.buf.size > 0))) {
        const part = r.buf.slice(0, PART_SIZE);
        r.buf = r.buf.slice(part.size);
        await uploadPart(r, part);
      }
    })
    .catch((e) => {
      r.failed = true;
      fail(new Error(`Video upload failed: ${e.message}`));
      if (r.recorder.state !== "inactive") r.recorder.stop();
    });
}

async function uploadPart(r, blob) {
  const n = ++r.n;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`/api/s/${code}/mpu/part?${r.q}&n=${n}`, { method: "PUT", body: blob });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      r.parts.push(await res.json());
      return;
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
}

function finishRecording(r) {
  if (rec === r) rec = null;
  finalizing++;
  render();
  sendStatus();
  drain(r, true);
  r.chain
    .then(async () => {
      if (r.failed || !r.parts.length) {
        await api(`/api/s/${code}/mpu/abort?${r.q}`, { method: "POST" }).catch(() => {});
        return;
      }
      await api(`/api/s/${code}/mpu/complete?${r.q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: r.parts.sort((a, b) => a.partNumber - b.partNumber) }),
      });
      markSaved(r.name, "video");
    })
    .catch((e) => fail(new Error(`Could not finish ${r.name}: ${e.message}`)))
    .finally(() => {
      finalizing--;
      render();
    });
}

// ---- timelapse --------------------------------------------------------------

function startTimelapse(intervalSec) {
  if (tl) return;
  const interval = Math.min(86400, Math.max(1, Number.isFinite(intervalSec) ? intervalSec : 10));
  tl = { interval, n: 0, folder: `timelapse-${stamp()}`, next: performance.now(), timer: 0 };
  tick(tl);
  render();
  sendStatus();
}

async function tick(t) {
  if (tl !== t) return;
  try {
    const blob = await grabFrame();
    t.n++;
    enqueue(`${t.folder}/frame-${String(t.n).padStart(6, "0")}.jpg`, blob);
  } catch (e) {
    console.warn("timelapse frame skipped:", e.message); // e.g. screen locked; keep trying
  }
  t.next += t.interval * 1000;
  t.timer = setTimeout(() => tick(t), Math.max(0, t.next - performance.now()));
  render();
}

function stopTimelapse() {
  if (!tl) return;
  clearTimeout(tl.timer);
  tl = null;
  render();
  sendStatus();
}

// ---- status -------------------------------------------------------------------

function sendStatus(to) {
  conn.send({
    type: "status",
    to,
    streaming: !!stream,
    facing: $("facing").value,
    size: stream ? `${preview.videoWidth}×${preview.videoHeight}` : "",
    recording: rec ? { seconds: (Date.now() - rec.started) / 1000, name: rec.name } : null,
    timelapse: tl ? { intervalSec: tl.interval, frames: tl.n, folder: tl.folder } : null,
    pending: queue.length + finalizing,
    saved,
  });
}

function renderControllers() {
  const n = controllers.size;
  $("ctlPill").className = "pill" + (n ? " on" : "");
  $("ctlPill").textContent = n ? `${n} controller${n > 1 ? "s" : ""}` : "No controller";
}

function render() {
  const on = !!stream;
  $("start").textContent = on ? "Stop camera" : "Start camera";
  $("start").classList.toggle("primary", !on);
  $("idle").hidden = on;
  $("recBadge").hidden = !rec;
  $("tlBadge").hidden = !tl;
  $("tlCount").textContent = tl ? tl.n : 0;
  $("statRes").textContent = on ? `${preview.videoWidth}×${preview.videoHeight}` : "–";
  $("statPending").textContent = queue.length + finalizing;
  $("statSaved").textContent = saved;
  $("lastSaved").textContent = lastSaved ? `Last saved: ${lastSaved}` : "";
  for (const id of ["facing", "res", "audio"]) $(id).disabled = !!rec;
}

setInterval(() => {
  if (rec) $("recTime").textContent = fmtDuration((Date.now() - rec.started) / 1000);
  if (rec || tl) sendStatus();
}, 1000);
render();
