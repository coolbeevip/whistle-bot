// SPDX-License-Identifier: Apache-2.0
"use strict";

const $ = (id) => document.getElementById(id);
const landscape = matchMedia("(orientation: landscape)");
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
const titles = {mapping:"Wheel directions", distance:"Distance", turn:"Effective track width"};
const savedParams = () => last.saved_calibration || last.calibration;
function stageState(c, key) {
  if (!c) return "Loading…";
  if (key === "mapping") return c.mapped ? (c.revision ? "Saved" : "Chassis default") : "Not calibrated";
  const turn = key === "turn";
  if (!(turn ? c.track_mm : c.left_mm_tick)) return "Not calibrated";
  return c.checks & (turn ? 2 : 1) ? "Saved · verified" : "Saved · test needed";
}
// 67.5 mm tire circumference divided by the measured counts per wheel revolution.
const nominalScales = [Math.PI * 67.5 / 1784, Math.PI * 67.5 / 1782];
const nominalMean = (nominalScales[0] + nominalScales[1]) / 2;
const gearButtons = [...document.querySelectorAll("[data-gear]")];
const gearInputs = [...document.querySelectorAll("[data-gear-setting]")];
const gearSpeeds = gearInputs.map(input => {
  const key = "gear." + input.dataset.gearSetting;
  const stored = Number(localStorage.getItem(key));
  if (Number.isFinite(stored) && stored >= 0.01) input.value = stored;
  return Number(input.value);
});
let selectedGear = 1, sport = true, speedCeiling = 1.07;
let speedLimits = {}, rateStamp, smoothedSpeed;
function gearSpeed(index) {
  return Math.min(gearSpeeds[index], speedCeiling);
}
function showGears() {
  gearButtons.forEach((button, i) => {
    button.setAttribute("aria-pressed", String(i === selectedGear));
    button.querySelector("small").textContent = gearSpeed(i) + " m/s";
    gearInputs[i].max = speedCeiling;
  });
  for (const button of $("acceleration").children)
    button.setAttribute("aria-pressed", String((button.dataset.mode === "responsive") === sport));
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
  $("actualSpeed").textContent = smoothedSpeed.toFixed(2);
}
let feedbackTimer;
function say(message) {
  clearTimeout(feedbackTimer);
  if (page === "drive" && message) driveNotice(message);
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
  if (mode === "action") {
    try {
      localStorage.setItem("esp32.lastPrecisionTrace", JSON.stringify({
        boot: last.boot_id, action: last.action_id, reason: last.reason,
        savedAt: Date.now(), events: precisionTrace,
      }));
    } catch { /* Storage availability must never delay releasing control. */ }
  }
  manualInFlight.clear();
  trialStage = "";
  lease = 0;
  windowId = 0;
  mode = "";
  stage = "";
  samplingNow = false;
  held = pointer = acceptedAt = null;
  for (const button of dirs) button.classList.remove("steering");
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
function renderImuRow(id, values, precision) {
  const cells = $(id).querySelectorAll("td");
  cells.forEach((cell, i) => {
    cell.textContent = Number.isFinite(values?.[i]) ? values[i].toFixed(precision) : "—";
  });
}

function render() {
  const fresh = !!session && !!lastSample && Date.now() - lastSample <= 1000;
  const imu = fresh ? last.imu : null;
  renderImuRow("imuAccel", imu?.accel_g, 3);
  renderImuRow("imuGyro", imu?.gyro_dps, 2);
  document.body.dataset.page = page;
  const ready = fresh && last.driver_online,
    free = last.owner === "free";
  const batteryFresh = fresh && last.battery_valid && Number.isFinite(last.battery_v) && Number.isFinite(last.battery_percent);
  $("battery").textContent = batteryFresh ?
    Math.round(last.battery_percent) + "%" : "—";
  $("battery").title = batteryFresh ? last.battery_v.toFixed(2) + " V" : "Battery unavailable";
  $("batteryAlarm").hidden = !(batteryFresh && last.battery_low);
  document.body.dataset.connected = String(!!session);
  document.documentElement.style.setProperty("--charge", batteryFresh ? last.battery_percent + "%" : "0%");
  $("precisionStop").disabled = $("padStop").disabled = $("stop").disabled = !session;
  const precision = drivePanel === "actions";
  const summary = document.querySelector(".drive-summary");
  const drivingView = page === "drive" && !landscape.matches;
  const summaryHost = drivingView && precision ? $("precisionControls") : document.querySelector("main");
  if (summary.parentElement !== summaryHost) summaryHost.prepend(summary);
  const statusHost = drivingView && !precision ? $("stickFooter") : document.querySelector(".toolbar");
  const statusSlot = $("availability").parentElement;
  if (statusSlot.parentElement !== statusHost) statusHost.prepend(statusSlot);
  $("stop").hidden = drivingView;
  const canInterrupt = !!session && (busy || mode === "action" || last.action_state === "running" || last.settled === false);
  $("precisionStop").hidden = !canInterrupt;
  $("execute").hidden = canInterrupt;
  for (const button of driveButtons) {
    const selected = drivePanel === button.dataset.drivePanel;
    $(button.dataset.drivePanel).hidden = !selected;
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = !selected && (!!lease || !!held || busy);
  }
  const turning = goalKind === "angle";
  const actionReady = last.precision_ready ?? (turning ? last.calibrated : last.distance_ready);
  $("acceleration").hidden = $("speedSetting").hidden = page !== "drive" || precision;
  if (session && last.manual_ready) {
    const maxMm = last.distance_ready ? last.manual_max_mm_s : speedLimits.basic_ticks_max * nominalMean;
    speedCeiling = Math.max(0.01, Math.floor(maxMm / 10) / 100);
  }
  showGears();
  renderGoal(canInterrupt);
  showActual(ready);
  for (const b of dirs)
    b.disabled = !(
      ready &&
      !landscape.matches && last.manual_ready &&
      (!ownerMessage(last.owner) && !busy && (!mode || mode === "manual" || mode === "claim"))
    );
  $("execute").disabled = !(
    ready &&
    !landscape.matches && actionReady &&
    free &&
    last.settled &&
    !busy
  );
  const saved = savedParams();
  const navigationLocked = !!lease || !!held || busy || !!calibrationExit;
  for (const id of ["drive", "settings", "cal"]) $(id).hidden = page !== id;
  for (const tab of document.querySelectorAll("nav [data-page]")) {
    const selected = tab.dataset.page === (page === "cal" ? "settings" : page);
    tab.setAttribute("aria-current", selected ? "page" : "false");
    tab.disabled = navigationLocked && tab.dataset.page !== page;
  }
  $("returnRovers").disabled = !session || !!calibrationExit || !!stage || mode === "cal" || (page === "cal" && busy);
  $("returnRovers").hidden = document.body.dataset.selecting === "true";
  $("calBack").disabled = navigationLocked;
  const needsCalibration = !last.distance_ready || (turning && last.precision_ready == null && !last.calibrated);
  $("precisionCalibration").hidden = !(page === "drive" && precision && ready && free &&
    last.settled && !navigationLocked && !actionReady && needsCalibration);
  $("availability").textContent = !session ? "Waiting for connection" : !fresh ? "Telemetry delayed" : !ready ? (page === "drive" && precision ? "" : "Motor driver offline") :
    page === "settings" ? "Network settings" : stage ? "" : ownerMessage(last.owner) ? ownerMessage(last.owner) :
    mode === "manual" ? "Driving" : mode === "claim" ? "Getting ready" : last.owner === "self" ? "This device has control" : !last.settled ? "Waiting for wheels to stop" :
    page === "drive" && precision && !actionReady ? (!last.distance_ready ? (saved?.mapped ? "Verify distance calibration" : "Set wheel directions first") : last.yaw_ready === false ? "Keep the IMU still on level ground" : turning && last.precision_ready == null ? "Verify distance and angle calibration" : "Verify distance calibration") :
    !last.manual_ready ? "Set wheel directions first" : "";
  const notice = $("availability").textContent;
  if (notice !== lastDriveNotice && page === "drive" && drivePanel === "manual" && selectedRover && $("garage").hidden && notice) driveNotice(notice);
  lastDriveNotice = notice;
  $("overview").hidden = !!stage || !$("trialResult").hidden;
  $("wizard").hidden = !stage;
  $("wizard").disabled = mode !== "cal" || busy;
  for (const button of document.querySelectorAll("[data-stage]")) {
    const key = button.dataset.stage;
    const missing = key === "distance" && !saved?.mapped ? "Save wheel directions first" :
      key === "turn" && !saved?.left_mm_tick ? "Save distance first" : "";
    $(key+"State").textContent = missing || stageState(saved,key);
    button.disabled = !!calibrationExit || landscape.matches || !!missing || !ready || !free || !last.settled || busy;
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
    $("jogTicks").textContent = "M3 ticks " + (last.m3_ticks ?? "—") + " · M4 ticks " + (last.m4_ticks ?? "—");
    $("stageStatus").textContent = samplingNow ? "Sampling" : active ? "Test in progress" :
      stage === "mapping" ? "Save to apply these directions" : last.action_state === "failed" && last.reason !== "ready" ? "Test failed · " + last.reason : !available ? "Ready to sample" :
      c.checks & (stage === "turn" ? 2 : 1) ? "Test passed. Ready to save." : "Save these values or run a test.";
  }
  $("owner").textContent =
    { free: "Available", self: "This browser", usb: "USB host", wifi: "Wi-Fi client" }[
      last.owner
    ] || "—";
  $("driver").textContent = ready ? "Online" : fresh ? "No feedback" : "—";
  $("still").textContent = fresh && last.settled
    ? "Stopped"
    : ready
      ? "Not settled"
      : "Unknown";
  const wheelPairs = [
    ["wheelPwm", ready, last.left_pwm, last.right_pwm],
    ["wheelTarget", ready, last.left_target_ticks_s, last.right_target_ticks_s],
    ["wheelRate", ready && last.rate_window_ms, last.left_ticks_s, last.right_ticks_s],
  ];
  for (const [id, available, left, right] of wheelPairs) {
    const cells = $(id).children;
    cells[1].textContent = (available ? left : null) ?? "—";
    cells[2].textContent = (available ? right : null) ?? "—";
  }
  $("m3").textContent = fresh ? last.m3_ticks ?? "—" : "—";
  $("m4").textContent = fresh ? last.m4_ticks ?? "—" : "—";
  $("age").textContent = ready && Number.isFinite(last.feedback_age_ms) ? last.feedback_age_ms + " ms" : "—";
  const c = last.calibration;
  if (c)
    $("params").textContent =
      "Revision " +
      c.revision +
      " · left/right " +
      Number(c.left_mm_tick).toFixed(3) +
      " / " +
      Number(c.right_mm_tick).toFixed(3) +
      " mm/tick · track width " +
      Number(c.track_mm).toFixed(1) +
      " mm";
  let progress = last.action_id ? "Movement · " + last.action_state : "";
  if (Number.isFinite(last.action_target_deg))
    progress = "#" + last.action_id + " · " + last.action_state + " · Target " + last.action_target_deg + "°";
  if (Number.isFinite(last.action_yaw_deg)) {
    progress += " · Yaw " + last.action_yaw_deg.toFixed(1) + "°";
    if (["failed", "cancelled"].includes(last.action_state))
      progress += " · " + (last.action_reason || last.reason);
  }
  if ($("progress").textContent !== progress) $("progress").textContent = progress;
}
