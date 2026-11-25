// SPDX-License-Identifier: Apache-2.0
"use strict";

const hotspotAddress = "192.168.4.1";
function validBoard(value) {
  if (!value || !/^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(value)) return false;
  try { return Boolean(new URL("ws://" + value).hostname); } catch { return false; }
}
const requestedBoard = new URLSearchParams(location.search).get("board");
const rememberedBoard = localStorage.getItem("esp32.board");
const boardHost = [requestedBoard, rememberedBoard, hotspotAddress].find(validBoard);
if (validBoard(requestedBoard)) localStorage.setItem("esp32.board", boardHost);
$("boardHost").value = boardHost;
$("boardForm").onsubmit = e => {
  e.preventDefault();
  const input = $("boardHost");
  const host = input.value.trim();
  input.setCustomValidity(validBoard(host) ? "" : "Enter the controller IP address or hostname.");
  if (input.reportValidity()) location.assign("?board=" + encodeURIComponent(host));
};
$("boardHost").oninput = () => $("boardHost").setCustomValidity("");

function call(op, fields = {}, timeout = op.startsWith("wifi_") ? 3000 : 700) {
  if (!ws || ws.readyState !== 1 || (!session && op !== "hello"))
    return Promise.reject(Error("Disconnected"));
  if (landscape.matches && (["claim", "cal_begin", "drive", "drive_low", "move_distance", "turn_angle", "heartbeat"].includes(op) ||
      (op === "cal_sample" && ["trial", "jog"].includes(fields.step))))
    return Promise.reject(Error("Rotate to portrait to operate the rover."));
  const n = ++id,
    packet = { v: 1, id: n, op, ...fields };
  if (session) packet.session = session;
  if (lease) {
    packet.lease ??= lease;
    packet.window ??= windowId;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(n);
      reject(Error("Response timed out"));
    }, timeout);
    pending.set(n, { resolve, reject, timer });
    ws.send(JSON.stringify(packet));
  });
}
let reconnectSilentSocket;
function connect() {
  ws = new WebSocket("ws://" + boardHost + "/ws");
  const socket = ws;
  const opening = setTimeout(() => disconnectCurrent(), 5000);
  ws.onopen = async () => {
    clearTimeout(opening);
    try {
      const h = await call("hello", {}, 3000);
      session = h.session;
      speedLimits = h;
      rateStamp = smoothedSpeed = undefined;
      last = await call("status", {}, 3000);
      lastSample = Date.now();
      await call("subscribe", { topic: "encoders", hz: 5 }, 3000);
      $("lidar").hidden = !h.capabilities.includes("lidar_sectors");
      if (!$("lidar").hidden)
        await call("subscribe", { topic: "lidar_sectors", hz: 5 }, 3000);
      $("connection").textContent = "Connected";
      render();
    } catch {
      disconnectCurrent();
    }
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.event === "lidar_sectors") {
      $("sectors").textContent = m.sectors
        .map(
          (s, i) =>
            ["Front", "Left", "Rear", "Right"][i] +
            " " +
            (s.valid ? s.min_mm + " mm" : "Unknown"),
        )
        .join(" · ");
      return;
    }
    if (m.event === "control_window") {
      if (lease && m.lease === lease) {
        windowId = m.window;
        if (mode === "manual") serviceManual();
        if (mode === "action") {
          tracePrecision("window", windowId, m.t_ms);
          renewPrecision();
        }
      }
      return;
    }
    if (["encoders", "action", "status"].includes(m.event)) {
      if (lease && acceptedAt !== null && ((m.t_ms - acceptedAt) | 0) < 0) return;
      last = m;
      lastSample = Date.now();
      if (lease && m.owner !== "self") {
        trialInterrupted(m.reason, m);
        const manual = mode === "manual", action = mode === "action";
        clearLocal();
        const reason = {timeout:"Drive timed out. Release and press again.", feedback_lost:"Motor feedback lost",
          wheel_stalled:"Wheel stalled", lidar_interlock:"Obstacle detected", deadline:"Controller stopped. Press again."};
        say(action && m.action_id ? "" : ownerMessage(m.owner) || reason[m.reason] || (manual ? "Drive stopped. Press again." : "Control released"));
      }
      if (m.reason === "saved") say("Calibration saved");
      if (m.reason === "save_failed") say("Save failed. Previous settings retained.");
      render();
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(Object.assign(Error(m.error || "Request failed"), {owner:m.owner, window:m.window, lease:m.lease}));
  };
  ws.onclose = () => disconnectCurrent();
  function disconnectCurrent() {
    if (ws !== socket) return;
    clearTimeout(opening);
    socket.onclose = socket.onopen = socket.onmessage = null;
    ws = null;
    socket.close();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Connection lost"));
    }
    pending.clear();
    trialInterrupted("Disconnected");
    session = 0;
    $("networkSetup").disabled = true;
    clearLocal();
    last = {};
    busy = false;
    lastSample = 0;
    $("sectors").textContent = "Data stale";
    render();
    $("connection").textContent = "Disconnected";
    setTimeout(connect, 1200);
  }
  reconnectSilentSocket = disconnectCurrent;
}
async function acquire(kind, token) {
  const r = await call(kind === "cal" ? "cal_begin" : "claim", kind === "manual" ? {manual_pad:true} : kind === "action" ? {precision:true} : {});
  if (token !== generation) {
    await releaseLease(r.lease);
    return false;
  }
  acceptedAt = r.accepted_ms ?? null;
  lease = r.lease;
  windowId = r.window;
  mode = kind;
  if (kind === "action") {
    precisionTrace.length = 0;
    tracePrecision("claim", windowId, r.accepted_ms);
  }
  return true;
}
