// SPDX-License-Identifier: Apache-2.0
"use strict";

const validDevice = id => typeof id === "string" && /^Whistle-[0-9A-F]{6}$/.test(id);
let rovers;
try { rovers = JSON.parse(localStorage.getItem("esp32.rovers")); } catch { rovers = []; }
rovers = Array.isArray(rovers) ? rovers.filter(r => r && validDevice(r.deviceId)) : [];
const legacyId = localStorage.getItem("esp32.deviceId");
if (validDevice(legacyId) && !rovers.some(r => r.deviceId === legacyId)) {
  remember({deviceId:legacyId, host:localStorage.getItem("esp32.board")});
}
let selecting = 0, selectedRover, retrySelection;

function remember(rover) {
  const existing = rovers.find(r => r.deviceId === rover.deviceId);
  if (existing) Object.assign(existing, rover);
  else rovers.push(rover);
  localStorage.setItem("esp32.rovers", JSON.stringify(rovers));
}
function showGarage(message = "") {
  document.body.dataset.selecting = "true";
  $("garage").hidden = false;
  $("networkWizard").hidden = true;
  $("roverCards").replaceChildren();
  for (const rover of rovers) {
    const button = document.createElement("button");
    button.textContent = rover.deviceId;
    button.onclick = () => selectRover(rover);
    $("roverCards").append(button);
  }
  $("selectionStatus").textContent = message || (rovers.length ? "" : "Add your first rover to get started.");
  $("retryRover").hidden = !retrySelection;
  $("cancelSelection").hidden = true;
}
function connectionEnded() {
  if (selectedRover) retrySelection = () => selectRover(selectedRover);
  showGarage("Disconnected. Select a rover to reconnect.");
}
function cancelSelection() {
  selecting++;
  if (ws) reconnectSilentSocket();
  retrySelection = null;
  showGarage();
}
async function selectRover(rover) {
  const token = ++selecting;
  if (ws) reconnectSilentSocket();
  $("selectionStatus").textContent = "Connecting…";
  $("retryRover").hidden = true;
  $("cancelSelection").hidden = false;
  try {
    let match;
    if (validBoard(rover.host)) {
      try { match = await connect(rover.host, rover.deviceId); }
      catch (error) { if (!rover.deviceId || error.message === "ROVER_BUSY") throw error; }
    }
    if (token !== selecting) return;
    if (!match) {
      const found = await window.Capacitor?.Plugins?.RoverDiscovery?.find({deviceId:rover.deviceId});
      if (token !== selecting) return;
      if (!found || found.deviceId !== rover.deviceId || !validBoard(found.host)) throw Error("Rover unavailable");
      match = await connect(found.host, rover.deviceId);
    }
    if (token !== selecting) return;
    selectedRover = match;
    remember(match);
    retrySelection = null;
    $("garage").hidden = true;
    document.body.dataset.selecting = "false";
    showPage("drive");
  } catch (error) {
    if (token !== selecting) return;
    retrySelection = () => selectRover(rover);
    showGarage(error.message + ". Retry or open the network wizard.");
  }
}
$("retryRover").onclick = () => retrySelection?.();
$("cancelSelection").onclick = $("closeWizard").onclick = cancelSelection;
$("addRover").onclick = () => {
  cancelSelection();
  $("networkWizard").hidden = false;
};
$("useHotspot").onclick = () => selectRover({host:hotspotAddress});
