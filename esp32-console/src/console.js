// SPDX-License-Identifier: Apache-2.0
"use strict";

const $ = (id) => document.getElementById(id);
const pending = new Map();
let ws,
  session = 0,
  id = 0,
  lease = 0,
  windowId = 0,
  mode = "",
  held = null,
  generation = 0,
  last = {},
  busy = false;
let pointer = null, acceptedAt = null, lastDriveAt = 0;
let queryPending = false,
  lastSample = 0;
let page = "drive", drivePanel = "manual", stage = "", samplingNow = false;
const titles = {mapping:"Wheel directions", distance:"Distance", turn:"Turn angle"};
const savedParams = () => last.saved_calibration || last.calibration;
function stageState(c, key) {
  if (!c) return "Loading…";
  if (key === "mapping") return c.mapped ? (c.revision ? "Saved" : "Chassis default") : "Not calibrated";
  const turn = key === "turn";
  if (!(turn ? c.track_mm : c.left_mm_tick)) return "Not calibrated";
  return c.checks & (turn ? 2 : 1) ? "Saved · verified" : "Saved · test needed";
}
const traceKeys = ["boot_id","t_ms","rate_at_ms","rate_window_ms","feedback_age_ms","left_ticks","right_ticks",
  "left_target_ticks_s","right_target_ticks_s","left_ticks_s","right_ticks_s","left_pwm","right_pwm"];
let trace = [], recording = false, traceBoot;
function logDrive(m) {
  if (traceBoot !== m.boot_id) recording = false;
  traceBoot = m.boot_id;
  if (!recording && (m.left_pwm || m.right_pwm || m.left_target_ticks_s || m.right_target_ticks_s)) {
    trace = [];
    recording = true;
  }
  if (!recording) return;
  trace.push(traceKeys.map(k => m[k] ?? "").join(","));
  if (trace.length > 3000) trace.shift();
  $("exportRun").disabled = false;
  if (m.settled && !m.left_pwm && !m.right_pwm) recording = false;
}
$("exportRun").onclick = () => {
  const url = URL.createObjectURL(new Blob([[traceKeys.join(","), ...trace].join("\n")], {type:"text/csv"}));
  const a = document.createElement("a");
  a.href = url;
  a.download = "wheel-trace.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// 67.5 mm tire circumference divided by the measured counts per wheel revolution.
const nominalScales = [Math.PI * 67.5 / 1784, Math.PI * 67.5 / 1782];
const nominalMean = (nominalScales[0] + nominalScales[1]) / 2;
const presets = [...document.querySelectorAll("[data-speed]")];
let speedLimits = {}, rateStamp, smoothedSpeed;
function showTarget() {
  const v = Number($("speed").value);
  $("speedOut").textContent = v.toFixed(2);
  for (const button of presets) {
    button.disabled = Number(button.dataset.speed) > Number($("speed").max);
    button.setAttribute("aria-pressed", Number(button.dataset.speed) === v);
  }
}
function showActual(ready) {
  if (!ready || !last.rate_window_ms || !Number.isFinite(last.left_ticks_s) ||
      !Number.isFinite(last.right_ticks_s) || last.feedback_age_ms >= 300) {
    $("actualSpeed").textContent = "—";
    smoothedSpeed = rateStamp = undefined;
    return;
  }
  if (last.rate_at_ms !== rateStamp) {
    const scales = last.distance_ready
      ? [last.calibration.left_mm_tick, last.calibration.right_mm_tick] : nominalScales;
    const measured = Math.abs(last.left_ticks_s * scales[0] + last.right_ticks_s * scales[1]) / 2000;
    const elapsed = (last.rate_at_ms - rateStamp) >>> 0;
    const weight = smoothedSpeed === undefined || elapsed > 1000 ? 1 : 1 - Math.exp(-elapsed / 300);
    smoothedSpeed = last.settled ? 0 : (smoothedSpeed ?? 0) + weight * (measured - (smoothedSpeed ?? 0));
    rateStamp = last.rate_at_ms;
  }
  $("actualSpeed").textContent = "≈" + smoothedSpeed.toFixed(2);
}
let feedbackTimer;
function say(message) {
  clearTimeout(feedbackTimer);
  $("feedback").textContent = message;
  $("feedback").parentElement.classList.toggle("has-message", !!message);
  if (page === "drive" && message) feedbackTimer = setTimeout(() => say(""), 4500);
}
let trialStage = "";
function trialInterrupted(reason, state) {
  if (!trialStage) return;
  const messages = {overshoot:"Outside target tolerance", timeout:"Control timed out",
    wheel_stalled:"Wheel stalled", feedback_lost:"Motor feedback lost", ENCODER_RESET:"Encoder reset",
    STALE_WINDOW:"Connection delayed", NOT_OWNER:"Control ended", UART_TX:"Motor link failed",
    lidar_interlock:"Obstacle detected", action_timeout:"Movement timed out"};
  let detail = messages[reason] || reason || "Control ended";
  if (reason === "overshoot" && Number.isFinite(state?.left_progress_mm) && Number.isFinite(state?.right_progress_mm))
    detail += " · L " + Math.round(state.left_progress_mm) + " / " + Math.round(state.left_goal_mm) +
      " mm · R " + Math.round(state.right_progress_mm) + " / " + Math.round(state.right_goal_mm) + " mm";
  $("trialOutcome").textContent = titles[trialStage] + " test · " + detail + ". Result not saved.";
  $("trialResult").hidden = false;
}
$("trialBack").onclick = () => { $("trialResult").hidden = true; render(); };
const manualInFlight = new Map();
function clearLocal() {
  manualInFlight.clear();
  trialStage = "";
  lease = 0;
  windowId = 0;
  mode = "";
  stage = "";
  samplingNow = false;
  held = pointer = acceptedAt = null;
  generation++;
}
async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    const errors = {BAD_SAMPLE:"Invalid sample. Check that both wheels turned in the expected directions and sample again.",
      MODE:"Wait for the wheels to stop and try again.", NOT_READY:"Check the sampling step and wait for the wheels to stop.",
      NO_FEEDBACK:"Motor feedback lost", BUSY:ownerMessage(e.owner || last.owner) || "Please wait for the wheels to stop", RANGE:"Value out of range",
      STALE_WINDOW:"Connection delayed. Press again.", NOT_OWNER:"Control ended. Press again.",
      CAL_REQUIRED:"Complete the required calibration first", SCALE_REQUIRED:"Save distance calibration first"};
    say(errors[e.message] || e.message);
  }
}
function ownerMessage(owner) {
  return owner === "usb" ? "USB host is driving" : owner === "wifi" ? "Another Wi-Fi client has control" : "";
}
const dirs = [...document.querySelectorAll("[data-dir]")];
function render() {
  document.body.dataset.page = page;
  const ready = !!session && last.driver_online,
    free = last.owner === "free";
  const batteryFresh = session && last.battery_valid && Number.isFinite(last.battery_v) &&
    (!lastSample || Date.now() - lastSample <= 1000);
  $("battery").textContent = batteryFresh ?
    last.battery_v.toFixed(2) + " V · ≈" + last.battery_percent + "%" : "Battery level unknown";
  $("batteryAlarm").hidden = !(batteryFresh && last.battery_low);
  document.body.dataset.connected = String(!!session);
  document.documentElement.style.setProperty("--charge", batteryFresh ? last.battery_percent + "%" : "0%");
  $("padStop").disabled = $("stop").disabled = !session;
  const precision = drivePanel === "actions";
  $("stop").hidden = page === "drive" && !precision;
  for (const button of driveButtons) {
    const selected = drivePanel === button.dataset.drivePanel;
    $(button.dataset.drivePanel).hidden = !selected;
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = !selected && (!!lease || !!held || busy);
  }
  const turning = ["left","right"].includes($("actionType").value);
  const actionReady = turning ? last.calibrated : last.distance_ready;
  $("speedSetting").hidden = !last.manual_ready;
  if (session && last.manual_ready) {
    const maxMm = last.distance_ready ? last.manual_max_mm_s : speedLimits.basic_ticks_max * nominalMean;
    const slider = $("speed");
    slider.min = last.distance_ready ? Math.min(0.01, maxMm / 1000) : 0.02;
    slider.max = Math.max(Number(slider.min), Math.floor(maxMm / 10) / 100);
    showTarget();
  }
  showActual(ready && (!lastSample || Date.now() - lastSample < 1000));
  for (const b of dirs)
    b.disabled = !(
      ready &&
      last.manual_ready &&
      (!ownerMessage(last.owner) && !busy && (!mode || mode === "manual" || mode === "claim"))
    );
  $("execute").disabled = !(
    ready &&
    actionReady &&
    free &&
    last.settled &&
    !busy
  );
  const saved = savedParams();
  for (const tab of document.querySelectorAll("button[data-page]")) {
    const selected = tab.dataset.page === page;
    $(tab.dataset.page).hidden = !selected;
    tab.setAttribute("aria-current", selected ? "page" : "false");
    tab.disabled = !selected && (!!lease || !!held || busy);
  }
  $("availability").textContent = !session ? "Waiting for connection" : !ready ? "Motor driver offline" :
    page === "settings" ? "Network settings" : stage ? titles[stage] : ownerMessage(last.owner) ? ownerMessage(last.owner) :
    mode === "manual" ? "Driving" : mode === "claim" ? "Getting ready" : last.owner === "self" ? "This device has control" : !last.settled ? "Waiting for wheels to stop" :
    page === "drive" && precision && !actionReady ? (turning ? "Verify distance and angle calibration" : "Verify distance calibration") :
    last.manual_ready ? "Ready to drive" : "Set wheel directions first";
  $("overview").hidden = !!stage || !$("trialResult").hidden;
  $("wizard").hidden = !stage;
  $("wizard").disabled = mode !== "cal" || busy;
  for (const button of document.querySelectorAll("[data-stage]")) {
    const key = button.dataset.stage;
    const missing = key === "distance" && !saved?.mapped ? "Save wheel directions first" :
      key === "turn" && !saved?.left_mm_tick ? "Save distance first" : "";
    $(key+"State").textContent = missing || stageState(saved,key);
    button.disabled = !!missing || !ready || !free || !last.settled || busy;
  }
  if (stage) {
    const c = last.calibration;
    const active = last.action_state === "running";
    const available = stage === "turn" ? c?.track_mm > 0 : c?.left_mm_tick > 0;
    $("startSample").disabled = samplingNow || active || !last.settled;
    $("calculate").disabled = !samplingNow || !last.settled;
    $("spin").disabled = !samplingNow;
    $("trial").disabled = !available || samplingNow || active || !last.settled;
    $("save").disabled = (stage !== "mapping" && !available) || samplingNow || active || !last.settled;
    $("jogTicks").textContent = "M3 ticks " + last.m3_ticks + " · M4 ticks " + last.m4_ticks;
    $("stageStatus").textContent = samplingNow ? "Sampling" : active ? "Test in progress" :
      stage === "mapping" ? "Save to apply these directions" : last.action_state === "failed" && last.reason !== "ready" ? "Test failed · " + last.reason : !available ? "Ready to sample" :
      c.checks & (stage === "turn" ? 2 : 1) ? "Test passed. Ready to save." : "Save these values or run a test.";
  }
  $("owner").textContent =
    { free: "Available", self: "This browser", usb: "USB host", wifi: "Another Wi-Fi client" }[
      last.owner
    ] || "—";
  $("driver").textContent = ready ? "Online" : "No feedback";
  $("still").textContent = last.settled
    ? "Stopped"
    : ready
      ? "Moving or stopping"
      : "Unknown";
  $("wheelTarget").textContent = ready ? [last.left_target_ticks_s,last.right_target_ticks_s].join(" / ") : "—";
  $("wheelRate").textContent = ready && last.rate_window_ms ? [last.left_ticks_s,last.right_ticks_s].join(" / ") : "—";
  $("wheelPwm").textContent = ready ? [last.left_pwm,last.right_pwm].join(" / ") : "—";
  $("m3").textContent = last.m3_ticks ?? "—";
  $("m4").textContent = last.m4_ticks ?? "—";
  $("age").textContent = ready ? last.feedback_age_ms + " ms" : "—";
  const c = last.calibration;
  if (c)
    $("params").textContent =
      "Revision " +
      c.revision +
      " · left/right " +
      Number(c.left_mm_tick).toFixed(3) +
      " / " +
      Number(c.right_mm_tick).toFixed(3) +
      " mm/ticks · track width " +
      Number(c.track_mm).toFixed(1) +
      " mm";
  const progress = last.action_id ? "Movement · " + last.action_state : "";
  if ($("progress").textContent !== progress) $("progress").textContent = progress;
}
