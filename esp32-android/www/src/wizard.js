// SPDX-License-Identifier: Apache-2.0
"use strict";

const networkCard = $("wifiTitle").closest("section");
let wizardStep = "", identified, savedNetwork;

function resetWizard() {
  wizardStep = "";
  identified = savedNetwork = null;
  $("wifiPanel").prepend(networkCard);
  $("homePass").value = "";
  $("foundRovers").replaceChildren();
}
function step(name, message = "") {
  wizardStep = name;
  $("networkWizard").hidden = false;
  $("roverCards").hidden = $("addRover").hidden = true;
  $("garageTitle").textContent = "Add rover";
  $("cancelSelection").hidden = $("retryRover").hidden = true;
  $("selectionStatus").textContent = message;
  for (const panel of $("networkWizard").querySelectorAll("[data-step]"))
    panel.hidden = panel.dataset.step !== name;
}
function hotspotStep() {
  cancelSelection();
  step("hotspot");
}
$("addRover").onclick = () => { cancelSelection(); step("choose"); };
$("hotspotPath").onclick = $("useHotspotInstead").onclick = $("switchHotspot").onclick = hotspotStep;
$("lanPath").onclick = () => step("lan");
$("useHotspot").onclick = () => selectRover({host:hotspotAddress}, match => {
  identified = match;
  $("identifiedRover").textContent = match.deviceId;
  step("identified");
});
$("addAndDrive").onclick = () => { if (identified && session) enterRover(identified); };
$("configureHome").onclick = () => {
  if (!identified || !session) return;
  $("wizardWifi").append(networkCard);
  $("homeName").value = wifiError = "";
  $("networkSetup").disabled = true;
  step("configure");
  refreshWifi();
};
function offerSwitch(net) {
  if (wizardStep !== "configure" || !net.home_ssid || !validBoard(net.home_ip) || net.busy) return;
  if (net.home_ssid !== savedNetwork || net.message !== "Connected and saved.") return;
  identified = {...identified, host:net.home_ip};
  $("switchHint").textContent = "Join " + net.home_ssid + " in phone Wi-Fi settings. Then find " + identified.deviceId + " to finish.";
  step("switch");
  if (ws) reconnectSilentSocket();
}
function wizardDisconnected() {
  if (!wizardStep) return false;
  if (wizardStep === "switch") return true;
  if (wizardStep === "configure" && identified && savedNetwork) {
    identified = {deviceId:identified.deviceId};
    $("switchHint").textContent = "Connection lost before confirmation. If the rover light is solid green, join " + savedNetwork + " and find " + identified.deviceId + ".";
    step("switch");
  } else if (wizardStep === "configure" || wizardStep === "identified") {
    step("hotspot", "Connection lost. Rejoin the hotspot and identify the rover again.");
  }
  return true;
}
$("verifyHome").onclick = () => selectRover(identified, async (match, token) => {
  const net = await call("wifi_status");
  if (token !== selecting) return;
  if (net.setup_allowed || net.home_ssid !== savedNetwork || !net.home_ip) {
    throw Error("Join the selected home network on your phone first");
  }
  enterRover(match);
});
$("searchLan").onclick = async () => {
  const token = ++selecting;
  $("foundRovers").replaceChildren();
  $("selectionStatus").textContent = "Searching…";
  try {
    const result = await window.Capacitor?.Plugins?.RoverDiscovery?.find({});
    if (token !== selecting) return;
    if (!Array.isArray(result?.devices)) throw Error();
    const devices = [...new Set(result.devices.filter(validDevice))];
    $("selectionStatus").textContent = devices.length ? "Select a rover." : "No rovers found. Search again or use its hotspot.";
    for (const deviceId of devices) {
      const button = document.createElement("button");
      button.textContent = deviceId;
      button.onclick = () => selectRover({deviceId});
      $("foundRovers").append(button);
    }
  } catch {
    if (token === selecting) $("selectionStatus").textContent = "Search unavailable. Try again or use the hotspot.";
  }
};
