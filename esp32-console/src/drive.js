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
const pad = document.querySelector(".pad");
let centeredTap = false;
function moveKnob(x, y) {
  pad.style.setProperty("--dx", x + "px");
  pad.style.setProperty("--dy", y + "px");
}
function trackStick(e) {
  const box = pad.getBoundingClientRect();
  const x = e.clientX - box.x - box.width / 2, y = e.clientY - box.y - box.height / 2;
  const length = Math.hypot(x, y);
  if (length < box.width * 0.12) {
    if (held) {
      guarded(releaseMine);
      pointer = e.pointerId;
    }
    moveKnob(0, 0);
    return;
  }
  centeredTap = false;
  if (dirs[0].disabled) return;
  const scale = Math.min(1, box.width * 0.24 / length);
  moveKnob(x * scale, y * scale);
  const direction = Math.abs(x) > Math.abs(y)
    ? [Math.sign(x), -Math.sign(x)]
    : [-Math.sign(y), -Math.sign(y)];
  if (held) {
    held = direction;
    return;
  }
  held = direction;
  mode = "claim";
  const token = ++generation;
  render();
  guarded(() => beginManual(token));
}
pad.onpointerdown = e => {
  if (pointer !== null || held || busy || lease || !e.isPrimary || e.button !== 0) return;
  if (dirs[0].disabled && e.target !== $("padStop")) return;
  pointer = e.pointerId;
  centeredTap = e.target === $("padStop");
  pad.setPointerCapture(pointer);
  trackStick(e);
};
pad.onpointermove = e => { if (pointer === e.pointerId) trackStick(e); };
pad.onpointerup = pad.onpointercancel = pad.onlostpointercapture = e => {
  if (pointer !== e.pointerId) return;
  if (centeredTap && e.type === "pointerup" && session) guarded(stop);
  else if (held || lease) guarded(releaseMine);
  else { pointer = null; moveKnob(0, 0); }
};
async function drive() {
  if (held) {
    const mmPerSecond = Math.round(gearSpeed(selectedGear) * 1000);
    const acceleration = sport ? "responsive" : "smooth";
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
  if (mode || lease || held || busy || pointer !== null) {
    trialInterrupted("Page left or hidden");
    guarded(releaseMine);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disengage();
});
window.addEventListener("blur", disengage);
$("padStop").onclick = e => { if (e.detail === 0) guarded(stop); };
$("precisionStop").onclick = $("stop").onclick = () => guarded(stop);
gearButtons.forEach((button, i) => {
  button.onclick = () => { selectedGear = i; showGears(); };
});
gearInputs.forEach((input, i) => {
  input.onchange = () => {
    if (input.reportValidity()) {
      gearSpeeds[i] = input.valueAsNumber;
      localStorage.setItem("gear." + i, input.value);
      $("gearStatus").textContent = "G" + (i + 1) + " saved · " + input.valueAsNumber.toFixed(2) + " m/s";
    } else {
      $("gearStatus").textContent = "Enter " + input.min + "–" + input.max + " m/s in steps of 0.01";
      input.value = gearSpeeds[i];
    }
    showGears();
  };
  for (const button of input.parentElement.querySelectorAll("[data-adjust]")) {
    button.onclick = () => {
      const next = Math.round(gearSpeed(i) * 100) + Number(button.dataset.adjust) * 5;
      input.value = Math.min(speedCeiling, Math.max(0.01, next / 100)).toFixed(2);
      input.onchange();
    };
  }
});
$("acceleration").onclick = () => { sport = !sport; showGears(); };
const driveButtons = [...document.querySelectorAll("[data-drive-panel]")];
for (const button of driveButtons) button.onclick = () => {
  if (busy || lease || held) return;
  drivePanel = button.dataset.drivePanel;
  say("");
  render();
};
let goalKind = "distance";
// Distance is stored in millimetres so repeated adjustments do not accumulate rounding error.
const targets = {
  distance: {
    value: 500,
    min: 1,
    max: 3000,
    step: 10,
    presets: [100, 500, 1000, 2000],
    dirs: ["forward", "reverse"],
    side: 0,
  },
  angle: {
    value: 90,
    min: 1,
    max: 360,
    step: 1,
    presets: [15, 45, 90, 180],
    dirs: ["left", "right"],
    side: 0,
  },
};
const nudgeButtons = [...document.querySelectorAll("[data-nudge]")];
const kindButtons = [...document.querySelectorAll("[data-kind]")];
const dirButtons = [$("dirA"), $("dirB")];
const presetButtons = [
  ...document.querySelectorAll('[aria-label="Target presets"] button'),
];
let repeatTimer,
  repeated = false;
function endAdjust() {
  clearTimeout(repeatTimer);
}
function displayGoal(value, preset = false) {
  if (goalKind === "angle") return value + "°";
  const metres = value / 1000;
  return (preset ? metres : metres.toFixed(value % 10 ? 3 : 2)) + " m";
}
function renderGoal(active) {
  const target = targets[goalKind];
  for (const button of kindButtons)
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.kind === goalKind),
    );
  dirButtons.forEach((button, i) => {
    const dir = target.dirs[i];
    button.textContent = dir[0].toUpperCase() + dir.slice(1);
    button.setAttribute("aria-pressed", String(target.side === i));
  });
  presetButtons.forEach((button, i) => {
    button.textContent = displayGoal(target.presets[i], true);
    button.setAttribute(
      "aria-pressed",
      String(target.value === target.presets[i]),
    );
  });
  $("goalValue").value = displayGoal(target.value);
  for (const button of [...kindButtons, ...dirButtons, ...presetButtons])
    button.disabled = active;
  for (const button of nudgeButtons) {
    const steps = Number(button.dataset.nudge);
    button.disabled =
      active ||
      (steps < 0 ? target.value === target.min : target.value === target.max);
    const amount = displayGoal(Math.abs(steps) * target.step);
    button.setAttribute(
      "aria-label",
      (steps < 0 ? "Decrease" : "Increase") + " by " + amount,
    );
  }
  const direction = dirButtons[target.side].textContent;
  $("execute").textContent = `GO · ${direction} ${displayGoal(target.value)}`;
}
for (const button of kindButtons)
  button.onclick = () => {
    endAdjust();
    goalKind = button.dataset.kind;
    render();
  };
dirButtons.forEach(
  (button, i) =>
    (button.onclick = () => {
      targets[goalKind].side = i;
      render();
    }),
);
presetButtons.forEach(
  (button, i) =>
    (button.onclick = () => {
      const t = targets[goalKind];
      t.value = t.presets[i];
      render();
    }),
);
for (const button of nudgeButtons) {
  function adjust() {
    if (button.disabled) return;
    const t = targets[goalKind];
    const next = t.value + Number(button.dataset.nudge) * t.step;
    t.value = Math.max(t.min, Math.min(t.max, next));
    render();
  }
  button.onpointerdown = (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    endAdjust();
    repeated = false;
    button.setPointerCapture(e.pointerId);
    function repeat() {
      if (button.disabled) return;
      repeated = true;
      adjust();
      repeatTimer = setTimeout(repeat, 85);
    }
    repeatTimer = setTimeout(repeat, 380);
  };
  button.onpointerup =
    button.onpointercancel =
    button.onlostpointercapture =
      endAdjust;
  button.oncontextmenu = (e) => e.preventDefault();
  button.onclick = (e) => {
    if (!repeated || e.detail === 0) adjust();
    repeated = false;
  };
}
renderGoal(false);
function goal() {
  const target = targets[goalKind];
  const turn = goalKind === "angle";
  const direction = target.dirs[target.side];
  const sign = direction === "reverse" || direction === "right" ? -1 : 1;
  return {
    turn,
    [turn ? "angle_deg" : "distance_mm"]: sign * target.value,
    request_key: session + "-" + id + "-" + Date.now(),
  };
}
$("execute").onclick = () =>
  guarded(async () => {
    if (busy || lease) return;
    const g = goal(),
      token = ++generation;
    busy = true;
    render();
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
