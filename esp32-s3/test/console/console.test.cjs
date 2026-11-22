// SPDX-License-Identifier: Apache-2.0
const {test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const {setTimeout: sleep} = require("node:timers/promises");
const {chromium} = require("playwright");
const Controller = require("./controller.cjs");

const html = readFileSync(path.join(__dirname, "../../web/index.html"));
let browser;
before(async () => { browser = await chromium.launch({channel: process.env.CHROME_CHANNEL || undefined}); });
after(async () => { await browser?.close(); });

async function until(probe, description) {
  const deadline = Date.now() + 3500;
  do {
    const value = await probe();
    if (value) return value;
    await sleep(15);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for " + description);
}

async function open(t, configure = () => {}) {
  const board = new Controller();
  configure(board);
  const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  const errors = [];
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  const p = await context.newPage();
  p.setDefaultTimeout(3500);
  p.on("pageerror", error => errors.push(error.message));
  await p.route("http://rover.test/", route => route.fulfill({contentType: "text/html", body: html}));
  await p.routeWebSocket("ws://rover.test/ws", socket => {
    board.socket = socket;
    socket.onMessage(raw => board.receive(raw));
  });
  await p.goto("http://rover.test/");
  const packet = (op, fields = {}, from = 0) => until(() => board.packets.slice(from).find(m =>
    m.op === op && Object.entries(fields).every(([k,v]) => m[k] === v)), op + " " + JSON.stringify(fields));
  await packet("subscribe", {topic: "encoders"});
  return {p, board, packet};
}

const directions = {Forward: [1,1,0.5,0.14], Reverse: [-1,-1,0.5,0.86],
  Left: [-1,1,0.14,0.5], Right: [1,-1,0.86,0.5]};

async function touchPad(p, x, y) {
  const box = await p.locator(".pad").boundingBox();
  const client = await p.context().newCDPSession(p);
  await client.send("Input.dispatchTouchEvent", {type: "touchStart",
    touchPoints: [{x: box.x + box.width*x, y: box.y + box.height*y}]});
  return async (type = "touchEnd") => {
    await client.send("Input.dispatchTouchEvent", {type, touchPoints: []});
    await client.detach();
  };
}

for (const [direction, [left,right,x,y]] of Object.entries(directions)) {
  test("Touch pad: " + direction, async t => {
    const {p,board,packet} = await open(t);
    await p.locator("[data-speed=\"0.6\"]").tap();
    await p.selectOption("#acceleration", "smooth");
    board.delayDrive = true;
    const lift = await touchPad(p,x,y);
    const fields = {left_mm_s: left*600, right_mm_s: right*600, acceleration: "smooth"};
    await packet("claim", {manual_pad:true});
    const first = await packet("drive", fields);
    board.renew();
    await packet("drive", {...fields, window: board.window, lease: first.lease});
    board.send({id: first.id, ok: false, error: "STALE_WINDOW", lease: first.lease, window: first.window});
    board.renew();
    await packet("drive", {...fields, window: board.window, lease: first.lease});
    assert.equal(board.packets.some(m => m.op === "release"), false);
    await lift(direction === "Left" ? "touchCancel" : "touchEnd");
    await packet("release", {lease: first.lease});
    const count = board.packets.length;
    board.renew();
    await sleep(220);
    assert.equal(board.packets.slice(count).some(m => m.op === "drive"), false);
    await p.locator("#padStop").tap();
    await packet("stop");
  });
}

test("Basic drive, target slider, speed presets and lease timeout", async t => {
  const {p,board,packet} = await open(t,b => { b.state.distance_ready = false; });
  for (const speed of ["0.2","0.4","0.6","0.8"]) {
    await p.locator(`[data-speed="${speed}"]`).tap();
    assert.equal(await p.inputValue("#speed"), speed);
  }
  await p.locator("#speed").focus();
  await p.keyboard.press("ArrowLeft");
  const target = Number(await p.inputValue("#speed"));
  assert.equal(target,0.79);
  const lift = await touchPad(p,0.5,0.14);
  await packet("drive_low",{left_dir:1,right_dir:1,acceleration:"responsive",
    ticks_s: Math.round(790 / ((Math.PI*67.5/1784 + Math.PI*67.5/1782)/2))});
  board.event({owner:"free", reason:"timeout"});
  await p.getByText("Drive timed out. Release and press again.").waitFor();
  const count = board.packets.length;
  board.renew();
  await sleep(220);
  assert.equal(board.packets.slice(count).some(m => m.op === "drive_low"), false);
  await lift();
});

for (const [kind, op, key, value] of [
  ["forward","move_distance","distance_mm",250], ["reverse","move_distance","distance_mm",-250],
  ["left","turn_angle","angle_deg",45], ["right","turn_angle","angle_deg",-45]]) {
  test("Precision: " + kind, async t => {
    const {p,board,packet} = await open(t);
    await p.getByRole("button",{name:"Precision"}).tap();
    await p.selectOption("#actionType",kind);
    await p.fill("#amount","0");
    await p.locator("#execute").tap();
    await until(async () => (await p.textContent("#feedback")).includes("Enter"), "range feedback");
    assert.equal(board.packets.some(m => m.op === "claim"), false);
    await p.fill("#amount",key === "angle_deg" ? "45" : "0.25");
    await p.locator("#execute").tap();
    const command = await packet(op,{[key]:value});
    await packet("claim", {precision:true});
    assert.ok(command.request_key);
    await p.getByText("Movement · running").waitFor();
    await packet("heartbeat",{lease:command.lease});
    if (kind === "reverse") {
      await p.locator("#stop").tap();
      await packet("stop");
    } else board.event({owner:"free", action_state:"completed", settled:true});
    await until(() => p.locator("#execute").isEnabled(), "next action enabled");
  });
}

async function enterStage(p, stage) {
  await p.locator("[data-page=cal]:is(button)").tap();
  await p.locator(`[data-stage="${stage}"]`).tap();
  await p.locator("#wizard").waitFor();
}

test("Wheel mapping: individual motor jog, release, save and discard", async t => {
  const {p,packet,board} = await open(t);
  await enterStage(p,"mapping");
  for (const channel of [3,4]) {
    const offset = board.packets.length;
    await p.locator(`[data-jog="${channel}"]`).tap();
    await packet("cal_sample",{step:"jog",channel,direction:1,spin:false},offset);
    await packet("cal_sample",{step:"jog_stop"},offset);
  }
  await p.selectOption("#leftChannel","4");
  await p.selectOption("#right_motor_sign","-1");
  await p.locator("#save").tap();
  await packet("cal_sample",{step:"map",left_channel:4,left_motor_sign:-1,right_motor_sign:-1,left_encoder_sign:-1,right_encoder_sign:1});
  await packet("cal_checkpoint");
  await enterStage(p,"mapping");
  assert.equal(await p.inputValue("#leftChannel"),"4");
  await p.locator("#cancel").tap();
  await packet("cal_cancel");
});

for (const turn of [false,true]) {
  const stage = turn ? "turn" : "distance";
  test("Calibration: sample, calculate, test and save " + stage, async t => {
    const {p,packet,board} = await open(t);
    await enterStage(p,stage);
    await p.locator("#startSample").tap();
    await packet("cal_sample",{step:"start",turn});
    if (turn) {
      await p.locator("#spin").tap();
      await packet("cal_sample",{step:"jog",channel:3,spin:true});
      await packet("cal_sample",{step:"jog_stop"});
    }
    const field = turn ? "angle_deg" : "distance_mm";
    await p.fill("#measure",turn ? "95" : "210");
    await p.locator("#calculate").tap();
    await packet("cal_sample",{step:"finish",turn,[field]:turn ? 95 : 210});
    await p.fill("#trialAmount",turn ? "30" : "150");
    await p.locator("#trial").tap();
    await packet("cal_sample",{step:"trial",turn,[field]:turn ? 30 : 150});
    await p.getByText("Test in progress").waitFor();
    assert.ok(await p.locator("#save").isDisabled());
    board.draft.checks |= turn ? 2 : 1;
    board.event({action_state:"completed",settled:true});
    await p.locator("#save").tap();
    await packet("cal_checkpoint");
    await until(async () => (await p.textContent("#"+stage+"State")) === "Saved · verified","saved stage");
  });
}

test("Locks, disconnect and reconnect", async t => {
  const {p,board} = await open(t,b => { b.state.owner = "usb"; });
  assert.ok(await p.locator(".up").isDisabled());
  board.event({owner:"free",driver_online:false});
  await p.getByText("Motor driver offline",{exact:true}).waitFor();
  assert.ok(await p.locator(".down").isDisabled());
  board.event({driver_online:true,distance_ready:false,calibrated:false});
  await p.getByRole("button",{name:"Precision"}).tap();
  assert.ok(await p.locator("#execute").isDisabled());
  board.socket.close();
  await p.locator("#connection").getByText("Disconnected").waitFor();
  await p.locator("#connection").getByText("Connected",{exact:true}).waitFor();
  assert.equal(board.packets.some(m => ["claim","drive","drive_low"].includes(m.op)),false);
});

test("Settings: scan, select, save, forget and hotspot recovery", async t => {
  const {p,packet} = await open(t);
  await p.locator("#settingsButton").tap();
  await p.locator("#scanWifi").tap();
  await packet("wifi_scan");
  await p.getByRole("button",{name:"Test AP"}).tap();
  await p.fill("#homePass","fixture-only");
  await p.locator("#testWifi").tap();
  await packet("wifi_test",{ssid:"Test AP",password:"fixture-only"});
  p.once("dialog", d => d.accept());
  await p.locator("#forgetWifi").tap();
  await packet("wifi_forget");
  await p.getByRole("button",{name:"Hotspot recovery"}).tap();
  assert.ok(await p.locator("#recoveryPanel").isVisible());
});

test("Losing focus releases a held direction; late replies cannot restart it", async t => {
  const {p,board,packet} = await open(t,b => { b.delayDrive = true; });
  const lift = await touchPad(p,0.5,0.14);
  const first = await packet("drive");
  await p.evaluate(() => window.dispatchEvent(new Event("blur")));
  await packet("release",{lease:first.lease});
  const offset = board.packets.length;
  board.send({id:first.id,ok:false,error:"STALE_WINDOW",lease:first.lease,window:99});
  board.renew();
  await sleep(220);
  await lift();
  assert.equal(board.packets.slice(offset).some(m => m.op === "drive"),false);
});

test("An interrupted calibration trial shows its cause and returns to the stages", async t => {
  const {p,board,packet} = await open(t);
  await enterStage(p,"turn");
  await p.locator("#trial").tap();
  await packet("cal_sample",{step:"trial",turn:true});
  board.event({owner:"free",action_state:"failed",reason:"wheel_stalled"});
  await p.getByText(/Wheel stalled.*Result not saved/).waitFor();
  await p.locator("#trialBack").tap();
  assert.ok(await p.locator("#overview").isVisible());
  assert.equal(board.packets.some(m => m.op === "cal_checkpoint"),false);
});

test("Motor telemetry, battery alarm and downloadable drive trace", async t => {
  const {p,board} = await open(t);
  board.event({driver_online:true,m3_ticks:123,m4_ticks:456,left_pwm:75,right_pwm:90,
    battery_valid:true,battery_low:true,battery_v:9.8,battery_percent:3,settled:false});
  await p.locator("#batteryAlarm").waitFor();
  await p.locator("#vehicleTelemetry summary").tap();
  assert.equal(await p.textContent("#m3"),"123");
  assert.equal(await p.textContent("#m4"),"456");
  assert.equal(await p.textContent("#wheelPwm"),"75 / 90");
  const download = p.waitForEvent("download");
  await p.locator("#exportRun").tap();
  const file = await download;
  assert.equal(file.suggestedFilename(),"wheel-trace.csv");
  const [header,row] = readFileSync(await file.path(),"utf8").trim().split("\n");
  const columns = header.split(",");
  assert.equal(row.split(",")[columns.indexOf("right_pwm")],"90");
});

test("Holding Forward suppresses the context menu and still releases control", async t => {
  const {p,board,packet} = await open(t);
  const menuCancelled = selector => p.locator(selector).evaluate(el =>
    !el.dispatchEvent(new MouseEvent("contextmenu", {bubbles:true, cancelable:true})));
  const lift = await touchPad(p,0.5,0.14);
  const first = await packet("drive");
  await sleep(650);
  assert.ok(await menuCancelled(".up .key"));
  board.renew();
  await packet("drive",{lease:first.lease,window:board.window});
  await lift();
  await packet("release",{lease:first.lease});

  const offset = board.packets.length;
  const box = await p.locator(".pad").boundingBox();
  await p.mouse.click(box.x + box.width/2, box.y + box.height*0.14, {button:"right"});
  assert.equal(await menuCancelled("#speed"),false);
  assert.equal(board.packets.slice(offset).some(m => m.op === "claim"),false);
  for (const selector of ["[data-jog=\"3\"]","[data-jog=\"4\"]","#spin"])
    assert.ok(await menuCancelled(selector));
});
