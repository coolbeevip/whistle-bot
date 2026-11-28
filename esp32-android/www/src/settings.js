// SPDX-License-Identifier: Apache-2.0
"use strict";

let setupAllowed = false, scanGraceUntil = 0;
let wifiPoll = false, wifiRequest = false, wifiError = "";
const panelButtons = [...document.querySelectorAll("button[data-panel]")];
for (const button of panelButtons) button.onclick = () => {
  for (const other of panelButtons) {
    $(other.dataset.panel).hidden = other !== button;
    other.setAttribute("aria-pressed", String(other === button));
  }
  if (button.dataset.panel === "wifiPanel") refreshWifi();
};
function highlightNetwork() {
  $("testWifi").disabled = !setupAllowed || !$("homeName").value.length;
  for (const row of $("nearby").children)
    row.setAttribute("aria-pressed", String(row.textContent === $("homeName").value));
}
$("homeName").oninput = highlightNetwork;

function presentNetworks(names, scanning) {
  const list = $("nearby");
  list.hidden = scanning || names.length === 0;
  if (names.length !== list.children.length || names.some((name, i) => list.children[i].textContent !== name)) {
    const rows = names.map(name => {
      const row = document.createElement("button");
      row.type = "button";
      row.textContent = name;
      row.onclick = () => {
        if ($("homeName").value !== name) $("homePass").value = "";
        $("homeName").value = name;
        highlightNetwork();
      };
      return row;
    });
    list.replaceChildren(...rows);
  }
  highlightNetwork();
}
async function refreshWifi() {
  if (wifiPoll || wifiRequest || (wizardStep !== "configure" && (page !== "settings" || $("wifiPanel").hidden)) || !session) return;
  wifiPoll = true;
  try {
    const socket = ws;
    const net = await call("wifi_status");
    if (socket !== ws) return;
    if (wifiRequest) return;
    const occupied = last.owner !== "free";
    setupAllowed = net.setup_allowed;
    $("networkSetup").disabled = net.busy || occupied;
    $("scanWifi").disabled = !(net.scan_allowed ?? setupAllowed);
    for (const id of ["homeName", "homePass", "showPass", "forgetWifi"]) $(id).disabled = !setupAllowed;
    $("networkStatus").textContent = (net.home_ip ? "Connected to " + net.home_ssid :
      net.home_ssid ? "Saved network: " + net.home_ssid : "No saved network") +
      (net.hotspot_on ? " · Hotspot: " + net.hotspot : "");
    $("networkAddress").hidden = !net.home_ip;
    $("homeLink").textContent = net.home_ip;
    $("forgetWifi").hidden = !net.home_ssid;
    $("networkMessage").textContent = wifiError || (occupied ? "Finish driving or calibration first." : !setupAllowed ?
      "To save a network, connect your phone to " + net.hotspot + " and open Add on the rover list." +
      (net.hotspot_on ? "" : " Hold BOOT for 5 seconds to enable the hotspot.") :
      (net.scan_state === "running" ? "" : net.message));
    if (wizardStep === "configure") offerSwitch(net);
    const names = net.networks || [];
    presentNetworks(names, net.scan_state === "running");
    if (!net.busy && net.scan_state !== "running") scanGraceUntil = 0;
    $("scanWifi").textContent = net.scan_state === "running" ? "Scanning…" : "Scan";
    $("scanStatus").textContent = net.scan_state === "running" ? "Searching for 2.4 GHz networks…" :
      net.scan_state === "failed" ? "Scan failed. Retry or enter a name." :
      names.length ? names.length + (names.length === 1 ? " network found." : " networks found.") :
      net.scan_state === "done" ? "No networks found." :
      "";
  } catch (e) {
    $("networkSetup").disabled = true;
    $("networkStatus").textContent = e.message + ". Check your connection.";
  } finally { wifiPoll = false; }
}
async function changeWifi(op,fields={}) {
  wifiRequest = true;
  wifiError = "";
  $("networkSetup").disabled = true;
  if (op === "wifi_scan") {
    scanGraceUntil = Date.now() + 12000;
    presentNetworks([],true);
    $("scanWifi").textContent = "Scanning…";
    $("scanStatus").textContent = "Searching for 2.4 GHz networks…";
  }
  try {
    if (op === "wifi_test" && wizardStep === "configure") savedNetwork = fields.ssid;
    await call(op,fields);
    if (op === "wifi_test") $("homePass").value = "";
  } catch (e) {
    if (op === "wifi_test") savedNetwork = null;
    wifiError = e.message === "BUSY" ? "The rover is busy. Try again shortly." : "Request failed: " + e.message;
    $("networkMessage").textContent = wifiError;
  } finally { wifiRequest = false; await refreshWifi(); }
}
$("showPass").onclick = () => {
  const reveal = $("homePass").type === "password";
  $("homePass").type = reveal ? "text" : "password";
  $("showPass").textContent = reveal ? "Hide" : "Show";
  $("showPass").setAttribute("aria-label", reveal ? "Hide password" : "Show password");
};
$("scanWifi").onclick = () => changeWifi("wifi_scan");
$("testWifi").onclick = () => {
  if (!$("homeName").value) { $("homeName").focus(); $("homeName").reportValidity(); return; }
  return changeWifi("wifi_test",{ssid:$("homeName").value,password:$("homePass").value});
};
$("forgetWifi").onclick = () => {
  $("forgetDialog").showModal();
};
$("keepNetwork").onclick = () => $("forgetDialog").close();
$("confirmForget").onclick = () => {
  $("forgetDialog").close();
  if (setupAllowed && session && !$("networkSetup").disabled) changeWifi("wifi_forget");
};
setInterval(refreshWifi, 1000);
function showPage(next) {
  page = next;
  $("driveToast").hidden = true;
  say("");
  render();
  document.querySelector("main").scrollTop = 0;
  if (page === "settings") refreshWifi();
}
for (const tab of document.querySelectorAll("nav [data-page]"))
  tab.onclick = () => showPage(tab.dataset.page);
function openCalibration() {
  document.querySelector('[data-panel="chassisPanel"]').click();
  showPage("cal");
  $("calBack").focus();
}
$("openCalibration").onclick = $("precisionCalibration").onclick = openCalibration;
$("calBack").onclick = () => {
  showPage("settings");
  $("openCalibration").focus();
};
