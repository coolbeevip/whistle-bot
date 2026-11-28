// SPDX-License-Identifier: Apache-2.0
"use strict";

let departure, calibrationExit, toastTimer, lastDriveNotice;
function driveNotice(message) {
  clearTimeout(toastTimer);
  $("driveToast").textContent = message;
  $("driveToast").hidden = false;
  toastTimer = setTimeout(() => { $("driveToast").hidden = true; }, 3500);
}
function atRest(state) {
  return state.owner === "free" && state.settled === true && state.driver_online === true;
}
function beginDeparture() {
  departure = {rover:selectedRover, boot:speedLimits.boot_id, after:last.t_ms, saveUnknown:calibrationExit?.op === "cal_checkpoint"};
}
function showDeparture(state, detail = "") {
  const flow = departure;
  flow.state = state;
  const name = flow.rover.deviceId;
  $("departureTitle").textContent = name;
  $("departureStatus").textContent = ({
    confirm:"Stop this rover before returning to your vehicles?",
    waiting:"Waiting for the rover to confirm the wheels have stopped and control is released.",
    unknown:"Connected. Unable to confirm the wheels have stopped. Check the rover.",
    offline:"Disconnected. Unable to confirm the wheels have stopped. Check the rover.",
    reconnecting:"Reconnecting to " + name + "…"
  })[state] + (detail ? " " + detail : "") + (flow.saveUnknown ? " Calibration save result is unknown." : "");
  $("stayRover").hidden = $("stopAndReturn").hidden = state !== "confirm";
  $("reconnectRover").hidden = state !== "offline" && state !== "unknown";
  $("reconnectRover").textContent = "Reconnect to " + name;
  $("confirmedRest").hidden = !["offline","unknown"].includes(state);
  if (!$("departureDialog").open) $("departureDialog").showModal();
}
function finishDeparture() {
  clearTimeout(departure?.timer);
  departure = null;
  $("departureDialog").close();
  selectedRover = null;
  cancelSelection();
}
function waitForRest(flow) {
  clearTimeout(flow.timer);
  showDeparture("waiting");
  flow.timer = setTimeout(() => {
    if (departure === flow && flow.state === "waiting") showDeparture("unknown");
  }, 3000);
}
async function departureProgress(frame) {
  const flow = departure;
  if (!flow || !["waiting","unknown"].includes(flow.state) || flow.checking ||
      flow.socket !== ws || frame.boot_id !== flow.boot || !atRest(frame) ||
      (Number.isFinite(flow.after) && ((frame.t_ms - flow.after) | 0) <= 0)) return;
  const socket = ws;
  flow.checking = true;
  try {
    const current = await call("status");
    if (departure === flow && ws === socket && current.boot_id === flow.boot && atRest(current)) finishDeparture();
  } catch {
    if (departure === flow && ws === socket) showDeparture("unknown");
  } finally { flow.checking = false; }
}
$("returnRovers").onclick = () => {
  if (!session || stage || mode === "cal" || calibrationExit || departure) return;
  beginDeparture();
  if (!busy && !held && !lease && !mode && atRest(last) && Date.now()-lastSample <= 1000) finishDeparture();
  else if (busy || lease || mode || held || last.owner === "self") showDeparture("confirm");
  else showDeparture("unknown");
};
$("stayRover").onclick = () => { departure = null; $("departureDialog").close(); };
$("departureDialog").oncancel = e => { e.preventDefault(); if (departure?.state === "confirm") $("stayRover").click(); };
$("confirmedRest").onclick = finishDeparture;
$("stopAndReturn").onclick = async () => {
  const flow = departure;
  flow.state = "sending";
  $("stopAndReturn").disabled = true;
  $("stayRover").hidden = true;
  clearLocal();
  try {
    await call("stop");
    if (departure !== flow || !session) return;
    flow.socket = ws;
    flow.after = last.t_ms;
    waitForRest(flow);
  } catch {
    if (departure === flow) showDeparture(session ? "unknown" : "offline");
  } finally { $("stopAndReturn").disabled = false; }
};
$("reconnectRover").onclick = async () => {
  const flow = departure;
  if (ws) reconnectSilentSocket();
  showDeparture("reconnecting");
  await selectRover(flow.rover, match => {
    if (departure !== flow) return;
    remember(match);
    flow.socket = ws;
    flow.boot = speedLimits.boot_id;
    flow.after = last.t_ms;
    waitForRest(flow);
  });
};

function calibrationProgress(state) {
  const action = calibrationExit;
  if (!action?.accepted || action.socket !== ws || state.boot_id !== action.boot) return;
  const saving = action.op === "cal_checkpoint";
  if (saving && !["saved","save_failed"].includes(state.reason)) return;
  if (saving && state.reason === "saved" && (state.saved_calibration || state.calibration)?.revision === action.revision) return;
  if (!saving && !atRest(state)) return;
  calibrationExit = null;
  clearLocal();
  say(saving ? (state.reason === "saved" ? "Calibration saved" : "Save failed. Previous settings retained.") : "Calibration cancelled");
  render();
}
async function endCalibration(op) {
  if (calibrationExit) return;
  const action = {op, socket:ws, boot:speedLimits.boot_id, revision:savedParams()?.revision, accepted:false};
  calibrationExit = action;
  try {
    await call(op);
  } catch (error) {
    if (calibrationExit === action) calibrationExit = null;
    throw error;
  }
  if (calibrationExit !== action || action.socket !== ws) return;
  action.accepted = true;
  clearLocal();
  say(op === "cal_checkpoint" ? "Saving…" : "Waiting for wheels to stop…");
  render();
  try { calibrationProgress(await call("status")); }
  catch { if (calibrationExit === action) say("Waiting for calibration feedback…"); }
}
