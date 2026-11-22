// SPDX-License-Identifier: Apache-2.0
"use strict";

setInterval(async () => {
  if (session && lastSample && Date.now() - lastSample > 1000) {
    last.driver_online = false;
    last.settled = false;
    render();
  }
  if (mode === "manual") {
    if (performance.now() - lastDriveAt >= 125) await serviceManual();
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
    if (lease) await guarded(releaseMine);
  } finally {
    queryPending = false;
  }
}, 100);
connect();
