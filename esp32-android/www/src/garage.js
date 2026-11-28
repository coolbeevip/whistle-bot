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

function connectionSource(rover) {
  return rover.source || (rover.host === hotspotAddress ? "hotspot" : "wifi");
}
function remember(rover) {
  const source = connectionSource(rover);
  const existing = rovers.find(r => r.deviceId === rover.deviceId && connectionSource(r) === source);
  if (existing) Object.assign(existing, rover);
  else rovers.push(rover);
  localStorage.setItem("esp32.rovers", JSON.stringify(rovers));
}
function showGarage(message = "") {
  document.body.dataset.selecting = "true";
  $("headerRover").hidden = true;
  $("garage").hidden = false;
  resetWizard();
  $("networkWizard").hidden = true;
  $("roverCards").hidden = $("addRover").hidden = false;
  $("garageTitle").textContent = "Your rovers";
  $("roverCards").replaceChildren();
  for (const rover of rovers) {
    const button = document.createElement("button");
    const chassis = document.createElement("img");
    chassis.className = "rover-image";
    chassis.src = "/assets/esp32-s3-devkitc-1-v1.1-isometric.png";
    chassis.alt = "";
    const name = document.createElement("span");
    name.textContent = rover.deviceId;
    const network = document.createElement("span");
    const hotspot = connectionSource(rover) === "hotspot";
    network.className = "rover-network";
    const ssid = document.createElement("span");
    ssid.textContent = rover.ssid || (hotspot ? rover.deviceId : "Wi-Fi");
    network.append($(hotspot ? "hotspotIcon" : "wifiIcon").content.cloneNode(true), ssid);
    network.title = (hotspot ? "Hotspot" : "Wi-Fi") + " · " + ssid.textContent;
    network.dataset.source = hotspot ? "hotspot" : "wifi";
    name.className = "rover-id";
    button.setAttribute("aria-label", rover.deviceId + ", " + network.title);
    button.append(network, chassis, name);
    button.onclick = () => selectRover(rover);
    $("roverCards").append(button);
  }
  $("selectionStatus").textContent = message || (rovers.length ? "" : "Add your first rover to get started.");
  $("retryRover").hidden = !retrySelection;
  $("cancelSelection").hidden = true;
}
function connectionEnded() {
  if (departure) { showDeparture("offline"); return; }
  if (wizardDisconnected()) return;
  if (selectedRover) retrySelection = () => selectRover(selectedRover);
  showGarage("Disconnected. Select a rover to reconnect.");
}
function cancelSelection() {
  selecting++;
  if (ws) reconnectSilentSocket();
  retrySelection = null;
  showGarage();
}
async function selectRover(rover, onMatch = enterRover) {
  const token = ++selecting;
  if (ws) reconnectSilentSocket();
  $("selectionStatus").textContent = "Connecting…";
  $("retryRover").hidden = true;
  $("cancelSelection").hidden = false;
  try {
    let match;
    if (validBoard(rover.host)) {
      try { match = await connect(rover.host, rover.deviceId); }
      catch (error) { if (!rover.deviceId || connectionSource(rover) === "hotspot" || error.message === "ROVER_BUSY") throw error; }
    }
    if (token !== selecting) return;
    if (!match) {
      const found = await window.Capacitor?.Plugins?.RoverDiscovery?.find({deviceId:rover.deviceId});
      if (token !== selecting) return;
      if (!found || found.deviceId !== rover.deviceId || !validBoard(found.host)) throw Error("Rover unavailable");
      if (found.host === hotspotAddress) throw Error("Join the rover’s home Wi-Fi first");
      match = await connect(found.host, rover.deviceId);
    }
    if (token !== selecting) return;
    await onMatch({...rover, ...match, source:connectionSource(rover)}, token);
  } catch (error) {
    if (token !== selecting) return;
    if (ws) reconnectSilentSocket();
    if (departure) {
      showDeparture("offline", error.message === "ROVER_BUSY" ? "This rover is connected to another phone." : error.message);
      return;
    }
    if (error.message === "ROVER_BUSY") {
      retrySelection = rover.deviceId ? () => selectRover(rover) : null;
      showGarage("This rover is connected to another phone.");
      return;
    }
    if (!$("networkWizard").hidden) {
      $("selectionStatus").textContent = error.message + ". Try again or return to rovers.";
      $("cancelSelection").hidden = true;
      return;
    }
    retrySelection = () => selectRover(rover);
    showGarage(error.message + ". Retry or open the network wizard.");
  }
}
$("retryRover").onclick = () => retrySelection?.();
$("cancelSelection").onclick = $("closeWizard").onclick = cancelSelection;
function enterRover(match) {
  selectedRover = match;
  if (match.source === "hotspot") match.ssid = match.deviceId;
  remember(match);
  if (match.source === "wifi") {
    const socket = ws;
    call("wifi_status").then(net => {
      if (ws === socket && net.home_ssid && net.home_ip) remember({...match, ssid:net.home_ssid});
    }).catch(() => {}); // The card stays usable if network metadata is temporarily unavailable.
  }
  resetWizard();
  retrySelection = null;
  $("garage").hidden = true;
  document.body.dataset.selecting = "false";
  $("headerRover").textContent = match.deviceId;
  $("headerRover").hidden = false;
  showPage("drive");
  driveNotice("Connected to " + match.deviceId);
}
