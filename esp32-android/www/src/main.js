// SPDX-License-Identifier: Apache-2.0
"use strict";

// Keep recent phone-side timings so the controller CSV can be matched by window ID.
const precisionTrace = [];
function tracePrecision(event, window, detail) {
  precisionTrace.push([Math.round(performance.now()), event, window, detail]);
  if (precisionTrace.length > 96) precisionTrace.shift();
}
let precisionRenewal;
async function renewPrecision() {
  const token = generation, sentWindow = windowId;
  if (!lease || mode !== "action" ||
      (precisionRenewal?.token === token && precisionRenewal.window === sentWindow)) return;
  precisionRenewal = {token, window:sentWindow};
  tracePrecision("send", sentWindow);
  try {
    await call("heartbeat");
    if (token === generation) tracePrecision("ack", sentWindow);
  } catch (e) {
    if (token === generation) tracePrecision("error", sentWindow, e.message);
    if (token !== generation || sentWindow !== windowId) return;
    if (e.message === "STALE_WINDOW" && e.lease === lease && e.window && e.window !== sentWindow) {
      windowId = e.window;
      return renewPrecision();
    }
    await guarded(() => releaseMine("heartbeat_failed"));
  }
}

setInterval(async () => {
  if (session && lastSample && Date.now() - lastSample > 1000) {
    const scanning = (page === "settings" || wizardStep === "configure") && Date.now() < scanGraceUntil;
    if (lease || mode || (!scanning && Date.now() - lastSample > 2200)) reconnectSilentSocket();
    else render();
    return;
  }
  if (mode === "manual") {
    if (performance.now() - lastDriveAt >= 125) await serviceManual();
    return;
  }
  if (mode === "action") {
    await renewPrecision();
    return;
  }
  if (!lease || queryPending) return;
  const token = generation;
  queryPending = true;
  try {
    try { await call("heartbeat"); }
    catch (e) {
      if (token !== generation || e.message !== "STALE_WINDOW" || !e.window || e.lease !== lease) throw e;
      windowId = e.window;
      await call("heartbeat");
    }
  } catch (e) {
    if (token !== generation) return;
    trialInterrupted(e.message);
    say(({NOT_OWNER:"Control ended. Press again.", STALE_WINDOW:"Connection delayed. Press again."})[e.message] || e.message);
    if (lease) await guarded(() => releaseMine("heartbeat_failed"));
  } finally {
    queryPending = false;
  }
}, 100);
showGears();
showGarage();
