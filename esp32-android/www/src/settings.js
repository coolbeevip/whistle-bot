// SPDX-License-Identifier: Apache-2.0
"use strict";

let setupAllowed = false;
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
  $("nearby").value = $("homeName").value;
}
$("homeName").oninput = highlightNetwork;
$("nearby").onchange = () => {
  const name = $("nearby").value;
  if (!name) return;
  if ($("homeName").value !== name) $("homePass").value = "";
  $("homeName").value = name;
  highlightNetwork();
  if (setupAllowed) $("homePass").focus();
};
function presentNetworks(names, scanning) {
  const list = $("nearby");
  list.disabled = scanning || !names.length;
  list.options[0].text = scanning ? "Scanning…" : names.length ? "Choose a network" : "Scan to find networks";
  if (names.length !== list.options.length - 1 ||
      names.some((name, i) => list.options[i + 1].value !== name)) {
    list.length = 1;
    for (const name of names) list.add(new Option(name, name));
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
      "To save a network, connect your phone to " + net.hotspot + " and identify it from Add rover." +
      (net.hotspot_on ? "" : " Hold BOOT for 5 seconds to enable the hotspot.") :
      (net.scan_state === "running" ? "" : net.message));
    if (wizardStep === "configure") offerSwitch(net);
    const names = net.networks || [];
    presentNetworks(names, net.scan_state === "running");
    $("scanWifi").textContent = net.scan_state === "running" ? "Scanning…" : "Scan";
    $("scanStatus").textContent = net.scan_state === "running" ? "" :
      net.scan_state === "failed" ? "Scan failed. Retry or enter a name." :
      names.length ? names.length + (names.length === 1 ? " network found." : " networks found.") :
      net.scan_state === "done" ? "No networks found." :
      "";
  } catch (e) {
    $("networkSetup").disabled = true;
    $("networkStatus").textContent = e.message + ". Reconnecting…";
  } finally { wifiPoll = false; }
}
async function changeWifi(op,fields={}) {
  wifiRequest = true;
  wifiError = "";
  $("networkSetup").disabled = true;
  if (op === "wifi_scan") {
    $("scanWifi").textContent = "Scanning…";
    $("scanStatus").textContent = "";
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
  if (window.confirm("Forget the saved home network?")) changeWifi("wifi_forget");
};
setInterval(refreshWifi, 1000);
function showPage(next) {
  page = next;
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
