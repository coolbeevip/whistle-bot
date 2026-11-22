// SPDX-License-Identifier: Apache-2.0
"use strict";

let wifiPoll = false, wifiRequest = false, wifiError = "";
const panelButtons = [...document.querySelectorAll("button[data-panel]")];
for (const button of panelButtons) button.onclick = () => {
  for (const other of panelButtons) {
    $(other.dataset.panel).hidden = other !== button;
    other.setAttribute("aria-pressed", String(other === button));
  }
};
function highlightNetwork() {
  for (const button of $("nearby").children)
    button.setAttribute("aria-pressed", String(button.textContent === $("homeName").value));
}
$("homeName").oninput = highlightNetwork;
function presentNetworks(names) {
  const list = $("nearby");
  if (names.length === list.children.length &&
      names.every((name, i) => list.children[i].textContent === name)) return;
  list.replaceChildren(...names.map(name => {
    const button = document.createElement("button");
    button.textContent = name;
    button.onclick = () => {
      if ($("homeName").value !== name) $("homePass").value = "";
      $("homeName").value = name;
      highlightNetwork();
      $("homePass").focus();
    };
    return button;
  }));
  highlightNetwork();
}
async function refreshWifi() {
  if (wifiPoll || wifiRequest || page !== "settings" || !session) return;
  wifiPoll = true;
  try {
    const net = await call("wifi_status");
    if (wifiRequest) return;
    const occupied = last.owner !== "free";
    $("networkSetup").disabled = net.busy || !net.setup_allowed || occupied;
    $("networkStatus").textContent = (net.home_ip ? "Connected to " + net.home_ssid :
      net.home_ssid ? "Saved network: " + net.home_ssid : "No saved network") +
      (net.hotspot_on ? " · Hotspot: " + net.hotspot : "");
    $("networkAddress").hidden = !net.home_ip;
    $("homeLink").href = net.home_ip ? "?board=" + encodeURIComponent(net.home_ip) : "";
    $("homeLink").textContent = net.home_ip;
    $("forgetWifi").disabled = !net.home_ssid;
    $("networkMessage").textContent = !net.setup_allowed ?
      "Connect to the rover hotspot to change Wi-Fi settings." : occupied ?
      "Finish driving or calibration first." : wifiError || (net.scan_state === "running" ? "" : net.message);
    const names = net.networks || [];
    presentNetworks(names);
    $("scanWifi").textContent = net.scan_state === "running" ? "Scanning…" : "Scan networks";
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
    await call(op,fields);
    if (op === "wifi_test") $("homePass").value = "";
  } catch (e) {
    wifiError = e.message === "BUSY" ? "The rover is busy. Try again shortly." : "Request failed: " + e.message;
    $("networkMessage").textContent = wifiError;
  } finally { wifiRequest = false; await refreshWifi(); }
}
$("scanWifi").onclick = () => changeWifi("wifi_scan");
$("testWifi").onclick = () => {
  if (!$("homeName").value) { $("homeName").focus(); $("homeName").reportValidity(); return; }
  return changeWifi("wifi_test",{ssid:$("homeName").value,password:$("homePass").value});
};
$("forgetWifi").onclick = () => {
  if (window.confirm("Forget the saved home network?")) changeWifi("wifi_forget");
};
setInterval(refreshWifi, 1000);
for (const tab of document.querySelectorAll("button[data-page]"))
  tab.onclick = () => { page = tab.dataset.page; say(""); render(); document.querySelector("main").scrollTop = 0; if (page === "settings") refreshWifi(); };
