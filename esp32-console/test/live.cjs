// SPDX-License-Identifier: Apache-2.0
// Exercise the web page served on the computer and observe its actual encoder stream.
const assert = require("node:assert/strict");
const {chromium} = require("playwright");

async function run() {
  const [address, option, ...extra] = process.argv.slice(2);
  assert.ok(address && (!option || option === "--wheels-lifted") && !extra.length,
    "Usage: node test/live.cjs http://BOARD/ [--wheels-lifted]");
  const url = new URL(address);
  assert.equal(url.protocol, "http:");
  const browser = await chromium.launch({channel: process.env.CHROME_CHANNEL || undefined});
  try {
    const p = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    p.setDefaultTimeout(4000);
    let latest;
    p.on("websocket", socket => socket.on("framereceived", frame => {
      const msg = JSON.parse(frame.payload);
      if (msg.event === "encoders") latest = msg;
    }));
    await p.goto("http://127.0.0.1:8765/?board=" + encodeURIComponent(url.host),{timeout:6000});
    await p.locator("#connection").getByText("Connected",{exact:true}).waitFor();
    await p.locator("#driver").getByText("Online",{exact:true}).waitFor({state:"attached"});
    await p.locator("#vehicleTelemetry summary").tap();
    await p.locator("[data-drive-panel=actions]").tap();
    await p.locator("#amount").waitFor();
    await p.locator("button[data-page=cal]").tap();
    await p.locator("[data-stage=mapping]").waitFor();
    await p.locator("#settingsButton").tap();
    await p.locator("#networkStatus").waitFor();
    await p.locator("button[data-page=drive]").tap();
    await p.locator("[data-drive-panel=manual]").tap();
    await waitUntil(() => latest?.driver_online && latest.feedback_age_ms < 300, 2000, "fresh encoder telemetry");
    console.log("Local console, WebSocket, motor feedback and navigation passed.");
    if (!option) return;

    for (const [name,left,right,x,y] of [
      ["Forward",1,1,0.5,0.14],["Reverse",-1,-1,0.5,0.86],
      ["Left",-1,1,0.14,0.5],["Right",1,-1,0.86,0.5]]) {
      assert.ok(latest.owner === "free" && latest.settled && latest.manual_ready, "Chassis must be idle and ready");
      await p.locator("[data-speed=\"0.2\"]").tap();
      const pad = p.locator(".pad");
      await pad.scrollIntoViewIfNeeded();
      const box = await pad.boundingBox();
      await p.mouse.move(box.x+box.width*x,box.y+box.height*y);
      const start = latest.t_ms;
      try {
        await p.mouse.down();
        await waitUntil(() => latest.t_ms !== start && latest.owner === "self" &&
          latest.feedback_age_ms < 300 && latest.left_ticks_s*left > 0 && latest.right_ticks_s*right > 0,
          1000, name + " signed encoder speeds");
      } finally {
        await p.mouse.up();
        await p.locator("#padStop").tap();
      }
      await waitUntil(() => latest.owner === "free" && latest.settled &&
        latest.left_pwm === 0 && latest.right_pwm === 0, 2500, "confirmed stop");
      console.log(name + " and stop passed.");
    }
  } finally { await browser.close(); }
}

async function waitUntil(check, timeout, label) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw Error("Timed out waiting for " + label);
    await new Promise(resolve => setTimeout(resolve,20));
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
