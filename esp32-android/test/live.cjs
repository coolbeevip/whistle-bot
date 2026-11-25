// SPDX-License-Identifier: Apache-2.0
// Inspect the installed debug app through its Android WebView.
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {chromium} = require("playwright");

async function run() {
  const [option, ...extra] = process.argv.slice(2);
  assert.ok((!option || option === "--wheels-lifted") && !extra.length,
    "Usage: node test/live.cjs [--wheels-lifted]");
  const adb = (...args) => execFileSync("adb", args, {encoding:"utf8"}).trim();
  const pid = adb("shell", "pidof", "io.whistlebot.console");
  assert.match(pid, /^\d+$/, "Open the debug app on the connected phone");
  const port = adb("forward", "tcp:0", "localabstract:webview_devtools_remote_" + pid);
  let browser;
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const p = browser.contexts().flatMap(context => context.pages())
      .find(page => new URL(page.url()).hostname === "whistle-console.localhost");
    assert.ok(p, "Whistle Bot WebView must be open");
    p.setDefaultTimeout(4000);
    const telemetry = () => p.evaluate(() => Date.now() - lastSample <= 1000 ? last : null);
    await p.locator("#connection").getByText("Connected",{exact:true}).waitFor();
    await p.locator("#driver").getByText("Online",{exact:true}).waitFor({state:"attached"});
    const idle = await telemetry();
    assert.ok(idle?.owner === "free" && idle.settled, "Chassis must be connected and idle");
    await p.locator("#imuReadings").waitFor();
    await p.locator("[data-drive-panel=actions]").click();
    await p.locator("#goalValue").waitFor();
    await p.locator("button[data-page=cal]").click();
    await p.locator("[data-stage=mapping]").waitFor();
    await p.locator("#settingsButton").click();
    await p.locator("#networkStatus").waitFor();
    await p.locator("button[data-page=drive]").click();
    await p.locator("[data-drive-panel=manual]").click();
    await waitUntil(async () => {
      const sample = await telemetry();
      return sample?.driver_online && sample.t_ms !== idle.t_ms && sample.feedback_age_ms < 300;
    }, 4000, "fresh encoder telemetry");
    console.log("Android app, WebSocket, motor feedback and navigation passed.");
    if (!option) return;

    for (const [name,left,right,x,y] of [
      ["Forward",1,1,0.5,0.14],["Reverse",-1,-1,0.5,0.86],
      ["Left",-1,1,0.14,0.5],["Right",1,-1,0.86,0.5]]) {
      const latest = await telemetry();
      assert.ok(latest?.owner === "free" && latest.settled && latest.manual_ready, "Chassis must be idle and ready");
      await p.locator("[data-gear=\"0\"]").click();
      const pad = p.locator(".pad");
      await pad.scrollIntoViewIfNeeded();
      const box = await pad.boundingBox();
      await p.mouse.move(box.x+box.width*x,box.y+box.height*y);
      const start = latest.t_ms;
      try {
        await p.mouse.down();
        await waitUntil(async () => {
          const sample = await telemetry();
          return sample?.owner === "self" && sample.t_ms !== start && sample.feedback_age_ms < 300 &&
            sample.left_ticks_s*left > 0 && sample.right_ticks_s*right > 0;
        },
          1000, name + " signed encoder speeds");
      } finally {
        await p.mouse.up();
        await p.locator("#padStop").click();
      }
      await waitUntil(async () => {
        const sample = await telemetry();
        return sample?.owner === "free" && sample.settled && sample.left_pwm === 0 && sample.right_pwm === 0;
      }, 2500, "confirmed stop");
      console.log(name + " and stop passed.");
    }
  } finally {
    try { await browser?.close(); } finally { adb("forward", "--remove", "tcp:" + port); }
  }
}

async function waitUntil(check, timeout, label) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= end) throw Error("Timed out waiting for " + label);
    await new Promise(resolve => setTimeout(resolve,20));
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
