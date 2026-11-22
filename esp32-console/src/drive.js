// SPDX-License-Identifier: Apache-2.0
"use strict";

async function stop() {
  trialInterrupted("Stopped");
  clearLocal();
  render();
  if (session) {
    await call("stop");
    say("Stop requested");
  }
}
async function releaseLease(previous) {
  try { await call("release", {lease:previous}); }
  catch (e) { if (e.message !== "NOT_OWNER") throw e; }
}
async function releaseMine() {
  const previous = lease;
  clearLocal();
  render();
  if (session && previous) await releaseLease(previous);
}
function release(e) {
  if (e.pointerId === pointer) guarded(releaseMine);
}
async function beginManual(token) {
  const deadline = performance.now() + 800;
  while (token === generation && held) {
    try {
      if (await acquire("manual", token)) {
        say("");
        render();
        await serviceManual();
      }
      return;
    } catch (e) {
      if (token !== generation) return;
      // A quick direction change can arrive while the previous press is settling.
      if (["BUSY","NOT_READY"].includes(e.message) && !ownerMessage(e.owner) &&
          performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 70));
        continue;
      }
      clearLocal();
      render();
      throw e;
    }
  }
}
async function serviceManual(canRetry = true) {
  if (!lease || mode !== "manual" || !held) return;
  const token = generation, activeLease = lease, sentWindow = windowId;
  // Keep newer 100 ms windows flowing while earlier acknowledgements are pending.
  if (manualInFlight.has(sentWindow) || manualInFlight.size >= 5) return;
  manualInFlight.set(sentWindow, token);
  lastDriveAt = performance.now();
  try {
    await drive();
  } catch (e) {
    if (token !== generation || lease !== activeLease) return;
    if (["STALE_WINDOW", "Response timed out"].includes(e.message) && windowId !== sentWindow) return;
    if (canRetry && e.message === "STALE_WINDOW" && e.lease === activeLease &&
        e.window && e.window !== sentWindow) {
      windowId = e.window;
      return serviceManual(false);
    }
    const message = {NOT_OWNER:"Drive stopped. Press again.", STALE_WINDOW:"Connection delayed. Press again.",
      NO_FEEDBACK:"Motor feedback lost"};
    say(ownerMessage(e.owner) || message[e.message] || e.message);
    await guarded(releaseMine);
  } finally {
    if (manualInFlight.get(sentWindow) === token) manualInFlight.delete(sentWindow);
  }
}
for (const control of document.querySelectorAll(".pad, [data-jog], #spin"))
  control.addEventListener("contextmenu", e => e.preventDefault());
dirs.forEach((b) => {
  b.onpointerdown = (e) => guarded(async () => {
    if (held || busy || lease || !e.isPrimary || e.button !== 0) return;
    pointer = e.pointerId;
    held = b.dataset.dir.split(",").map(Number);
    mode = "claim";
    const token = ++generation;
    b.setPointerCapture(pointer);
    render();
    await beginManual(token);
  });
  b.onpointerup = release;
  b.onpointercancel = release;
  b.onlostpointercapture = release;
});
async function drive() {
  if (held) {
    const mmPerSecond = Math.round(Number($("speed").value) * 1000);
    const acceleration = $("acceleration").value;
    if (!last.distance_ready) {
      await call("drive_low", {left_dir: held[0], right_dir: held[1],
        ticks_s: Math.round(mmPerSecond / nominalMean), acceleration});
      return;
    }
    let v = mmPerSecond;
    await call("drive", {
      left_mm_s: v * held[0],
      right_mm_s: v * held[1], acceleration,
    });
  }
}
function disengage() {
  if (mode || lease || held || busy) {
    trialInterrupted("Page left or hidden");
    guarded(releaseMine);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disengage();
});
window.addEventListener("blur", disengage);
$("padStop").onclick = $("stop").onclick = () => guarded(stop);
$("speed").oninput = showTarget;
for (const button of presets) button.onclick = () => {
  $("speed").value = button.dataset.speed;
  showTarget();
};
const driveButtons = [...document.querySelectorAll("[data-drive-panel]")];
for (const button of driveButtons) button.onclick = () => {
  if (busy || lease || held) return;
  drivePanel = button.dataset.drivePanel;
  say("");
  render();
};
const targets = { distance: "0.5", angle: "90" };
let targetKind = "distance";
$("actionType").onchange = () => {
  targets[targetKind] = $("amount").value;
  const turn = ["left", "right"].includes($("actionType").value);
  targetKind = turn ? "angle" : "distance";
  $("targetLabel").textContent = turn ? "Angle" : "Distance";
  $("unit").textContent = turn ? "°" : "m";
  $("amount").min = turn ? "1" : "0.001";
  $("amount").max = turn ? "360" : "3";
  $("amount").value = targets[targetKind];
  render();
};
function goal() {
  const kind = $("actionType").value,
    turn = ["left", "right"].includes(kind);
  const magnitude = Number($("amount").value);
  if (
    !Number.isFinite(magnitude) ||
    magnitude < (turn ? 1 : 0.001) ||
    magnitude > (turn ? 360 : 3)
  )
    throw Error(turn ? "Enter 1–360°" : "Enter 0.001–3 m");
  return {
    turn,
    [turn ? "angle_deg" : "distance_mm"]:
      magnitude *
      (turn ? 1 : 1000) *
      (["reverse", "right"].includes(kind) ? -1 : 1),
    request_key: session + "-" + id + "-" + Date.now(),
  };
}
$("execute").onclick = () =>
  guarded(async () => {
    if (busy || lease) return;
    const g = goal(),
      token = ++generation;
    busy = true;
    try {
      if (await acquire("action", token))
        await call(g.turn ? "turn_angle" : "move_distance", g);
    } catch (e) {
      if (lease) await releaseMine();
      throw e;
    } finally {
      busy = false;
      render();
    }
  });
