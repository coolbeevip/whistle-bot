// SPDX-License-Identifier: Apache-2.0
const {test, before, after} = require("node:test");
const assert = require("node:assert/strict");
const {createConsoleServer} = require("./assets.cjs");
const {setTimeout: sleep} = require("node:timers/promises");
const {chromium} = require("playwright");
const Controller = require("./controller.cjs");

const server = createConsoleServer();
let consoleUrl;
let browser;
before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  consoleUrl = "http://127.0.0.1:" + server.address().port + "/";
  browser = await chromium.launch({channel: process.env.CHROME_CHANNEL || undefined});
});
after(async () => { await browser?.close(); server.close(); });

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
  await p.routeWebSocket("ws://rover.test/ws", socket => {
    board.socket = socket;
    socket.onMessage(raw => board.receive(raw));
  });
  await p.goto(consoleUrl + "?board=rover.test");
  const packet = (op, fields = {}, from = 0) => until(() => board.packets.slice(from).find(m =>
    m.op === op && Object.entries(fields).every(([k,v]) => m[k] === v)), op + " " + JSON.stringify(fields));
  await packet("subscribe", {topic: "encoders"});
  return {p, board, packet};
}

test("Refreshing Drive keeps the toolbar stop hidden before the controller connects", async t => {
  const {p} = await open(t);
  let releaseScript;
  const gate = new Promise(resolve => { releaseScript = resolve; });
  await p.route("**/src/main.js", async route => {
    await gate;
    await route.continue();
  });
  await p.reload({waitUntil: "commit"});
  const telemetry = p.locator("#vehicleTelemetry");
  await telemetry.waitFor();
  let top;
  try {
    assert.ok(await p.locator("#stop").isHidden());
    assert.ok(await p.locator(".drive-summary").isHidden());
    top = (await telemetry.boundingBox()).y;
  } finally {
    releaseScript();
  }
  await p.locator("body[data-connected=true]").waitFor();
  assert.ok(await p.locator("#stop").isHidden());
  assert.equal((await telemetry.boundingBox()).y, top);
  await p.getByRole("button", {name:"Precision"}).tap();
  assert.ok(await p.locator("#stop").isHidden());
  assert.ok(await p.locator("#execute").isVisible());
  assert.ok(await p.locator("#precisionStop").isHidden());
});

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
    await p.locator("[data-gear=\"2\"]").tap();
    await p.getByRole("button",{name:"Comfort",exact:true}).tap();
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

test("Leaving a direction releases it and requires a fresh press to turn", async t => {
  const {p,board,packet} = await open(t);
  const box = await p.locator(".pad").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await p.mouse.move(x,y - box.height * 0.3);
  await p.mouse.down();
  const forward = await packet("drive",{left_mm_s:400,right_mm_s:400});
  assert.equal(await p.locator(".pad .steering").getAttribute("aria-label"), "Forward");
  await p.mouse.move(x + box.width * 0.3,y);
  await packet("release",{lease:forward.lease});
  assert.equal(await p.locator(".pad .steering").count(), 0);
  await p.mouse.up();
  assert.equal(board.packets.filter(m => m.op === "claim").length,1);
  await p.mouse.down();
  await packet("drive",{left_mm_s:400,right_mm_s:-400});
  await p.mouse.up();
  await p.mouse.move(x,y);
  await p.mouse.down();
  await packet("stop");
  await p.mouse.move(x,y - box.height * 0.3);
  await p.mouse.up();
  assert.equal(board.packets.filter(m => m.op === "claim").length,2);
});

test("Basic drive uses the configured gear and stops renewing after a timeout", async t => {
  const {p,board,packet} = await open(t,b => { b.state.distance_ready = false; });
  await p.getByRole("button",{name:"Settings"}).tap();
  await p.getByRole("button",{name:"Chassis",exact:true}).tap();
  await p.getByRole("button",{name:"Decrease G4 speed"}).tap();
  assert.equal(await p.locator("#gear3").inputValue(),"0.75");
  await p.getByText("G4 saved · 0.75 m/s").waitFor();
  await p.locator("[data-gear-setting='3']").fill("0.79");
  await p.locator("[data-gear-setting='3']").blur();
  await p.getByRole("button",{name:"Drive",exact:true}).tap();
  const gear = p.locator("[data-gear='3']");
  await gear.tap();
  assert.match(await gear.textContent(), /0.79 m\/s/);
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
    await p.locator('[data-gear="0"]').tap();
    await p.getByRole("button",{name:"Precision"}).tap();
    if (key === "angle_deg") {
      await p.getByRole("button",{name:"Turn",exact:true}).tap();
      await p.getByRole("button",{name:"45°",exact:true}).tap();
    } else {
      await p.getByRole("button",{name:"0.1 m",exact:true}).tap();
      await p.getByRole("button",{name:"Increase by 0.10 m"}).tap();
      for (let i = 0; i < 5; i++) await p.getByRole("button",{name:"Increase by 0.01 m"}).tap();
    }
    await p.getByRole("group",{name:"Direction",exact:true}).getByRole("button",{name:kind[0].toUpperCase()+kind.slice(1),exact:true}).tap();
    assert.equal(board.packets.some(m => m.op === "claim"), false);
    await p.locator("#execute").tap();
    const command = await packet(op,{[key]:value});
    await packet("claim", {precision:true});
    assert.equal(command.speed_mm_s, key === "distance_mm" ? 200 : undefined);
    assert.ok(command.request_key);
    await p.getByText("Movement · running").waitFor();
    await packet("heartbeat",{lease:command.lease});
    assert.ok(await p.locator("#execute").isHidden());
    assert.ok(await p.locator("#actions #precisionStop").isVisible());
    if (kind === "reverse") {
      await p.locator("#precisionStop").tap();
      await packet("stop");
    } else board.event({owner:"free", action_state:"completed", settled:true});
    await until(() => p.locator("#execute").isEnabled(), "next action enabled");
    assert.ok(await p.locator("#execute").isVisible());
    assert.ok(await p.locator("#precisionStop").isHidden());
  });
}

async function enterStage(p, stage) {
  if (await p.locator("#cal").isHidden()) {
    await p.locator("#settingsButton").tap();
    await p.locator("[data-panel=chassisPanel]").tap();
    await p.locator("#openCalibration").tap();
  }
  if (stage === "turn" && await p.locator("[data-stage=turn]").isHidden())
    await p.locator("#overview summary").tap();
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

test("Joystick gear selection remains available when the board disconnects", async t => {
  const {p, board} = await open(t);
  board.socket.close();
  await p.locator("#connection").getByText("Disconnected").waitFor();
  assert.equal(await p.locator("[data-gear]:visible").count(), 4);
  await p.locator('[data-gear="2"]').tap();
  assert.equal(await p.locator('[data-gear="2"]').getAttribute("aria-pressed"), "true");
  assert.ok(await p.locator(".up").isDisabled());
});

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

test("LAN scan lists networks while credential changes require the rover hotspot", async t => {
  const {p, packet} = await open(t, board => Object.assign(board.net, {
    setup_allowed:false, scan_allowed:true, hotspot:"Whistle-Test"
  }));
  await p.locator("#settingsButton").tap();
  await p.locator("#scanWifi").tap();
  await packet("wifi_scan");
  await p.locator("#nearby").selectOption("Test AP");
  assert.equal(await p.locator("#homeName").inputValue(), "Test AP");
  assert.ok(await p.locator("#testWifi").isDisabled());
  assert.ok(await p.locator("#homePass").isDisabled());
});

test("Settings: scan, select, save, forget and hotspot recovery", async t => {
  const {p,packet} = await open(t);
  await p.locator("#settingsButton").tap();
  await p.locator("#scanWifi").tap();
  await packet("wifi_scan");
  await p.locator("#nearby").selectOption("Test AP");
  await p.fill("#homePass","fixture-only");
  await p.getByRole("button",{name:"Show password"}).tap();
  assert.equal(await p.locator("#homePass").getAttribute("type"),"text");
  await p.getByRole("button",{name:"Hide password"}).tap();
  await p.locator("#testWifi").tap();
  await packet("wifi_test",{ssid:"Test AP",password:"fixture-only"});
  p.once("dialog", d => d.accept());
  await p.locator("#forgetWifi").tap();
  await packet("wifi_forget");
  await p.locator("#recoveryPanel summary").tap();
  assert.ok(await p.getByText("Hold BOOT for 5 seconds", {exact:false}).isVisible());
  await p.getByRole("button",{name:"Chassis",exact:true}).tap();
  assert.ok(await p.locator("#wifiPanel").isHidden());
  assert.equal(await p.locator("#chassisPanel input:visible").count(), 4);
  await p.getByRole("button",{name:"Wi-Fi",exact:true}).tap();
  assert.ok(await p.locator("#networkSetup").isVisible());
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

test("Motor telemetry and battery alarm", async t => {
  const {p,board} = await open(t);
  board.event({driver_online:true,m3_ticks:123,m4_ticks:456,left_pwm:75,right_pwm:90,
    battery_valid:true,battery_low:true,battery_v:9.8,battery_percent:3,settled:false});
  await p.locator("#batteryAlarm").waitFor();
  assert.equal(await p.textContent("header .rover-power #battery"), "3%");
  await p.locator("#imuReadings").waitFor();
  assert.equal(await p.textContent("#m3"),"123");
  assert.equal(await p.textContent("#m4"),"456");
  assert.equal(await p.textContent("#wheelPwm"),"75 / 90");
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
  assert.equal(await menuCancelled("#acceleration"),false);
  assert.equal(board.packets.slice(offset).some(m => m.op === "claim"),false);
  for (const selector of ["[data-jog=\"3\"]","[data-jog=\"4\"]","#spin"])
    assert.ok(await menuCancelled(selector));
});

test("A failed handshake reconnects and tolerates a slow status reply", async t => {
  const {p,board} = await open(t, b => {
    const receive = b.receive.bind(b);
    let first = true;
    b.receive = raw => {
      const m = JSON.parse(raw);
      if (first && m.op === "hello") {
        first = false;
        return b.send({id:m.id,ok:false,error:"BUSY"});
      }
      if (m.op === "status") return setTimeout(() => receive(raw), 900);
      receive(raw);
    };
  });
  await p.locator("#connection").getByText("Connected",{exact:true}).waitFor();
  assert.ok(await p.locator(".up").isEnabled());
  assert.equal(board.packets.some(m => m.op === "claim"), false);
});

test("Changing controller address reconnects from the local page and remembers the selection", async t => {
  const {p} = await open(t);
  const other = new Controller();
  await p.routeWebSocket("ws://second.test/ws", socket => {
    other.socket = socket;
    socket.onMessage(raw => other.receive(raw));
  });
  await p.locator("#settingsButton").tap();
  await p.locator("#controllerPanel summary").tap();
  await p.locator("#boardHost").fill("second.test");
  await p.getByRole("button",{name:"Connect",exact:true}).tap();
  await until(() => other.packets.some(m => m.op === "subscribe"), "second board handshake");
  await p.goto(consoleUrl);
  await until(() => other.packets.filter(m => m.op === "hello").length === 2, "remembered board handshake");
  assert.equal(await p.locator("#boardHost").inputValue(), "second.test");
});

test("IMU telemetry shows signed values on each axis and clears stale samples", async t => {
  const {p,board} = await open(t);
  await p.locator("#imuReadings").waitFor();
  board.event({imu:{accel_g:[-0.125,0,1.014],gyro_dps:[2.56,-3.25,0]}});
  const accel = p.locator("#imuAccel td");
  const gyro = p.locator("#imuGyro td");
  await until(async () => (await accel.allTextContents())[0] === "-0.125", "IMU sample");
  assert.deepEqual(await accel.allTextContents(), ["-0.125","0.000","1.014"]);
  assert.deepEqual(await gyro.allTextContents(), ["2.56","-3.25","0.00"]);
  await until(async () => (await gyro.allTextContents())[0] === "—", "stale IMU sample cleared");
  assert.deepEqual(await accel.allTextContents(), ["—","—","—"]);
});

test("Precision gates on gyro readiness and can turn without encoder track calibration", async t => {
  const {p,board} = await open(t,b => Object.assign(b.state, {
    distance_ready:true, calibrated:false, yaw_ready:false, precision_ready:false
  }));
  await p.getByRole("button",{name:"Precision"}).tap();
  await p.getByRole("button",{name:"Turn",exact:true}).tap();
  await p.locator("#dirB").tap();
  assert.ok(await p.locator("#execute").isDisabled());
  await p.getByText("Keep the IMU still on level ground").waitFor();
  board.event({yaw_ready:true,precision_ready:true});
  await until(() => p.locator("#execute").isEnabled(), "gyro turn enabled");
  board.event({action_id:2,action_state:"failed",reason:"imu_lost",action_yaw_deg:-18.5,
    yaw_ready:false,precision_ready:false});
  await p.getByText("Movement · failed · Yaw -18.5° · imu_lost").waitFor();
  board.event({action_state:"cancelled", action_target_deg:-45, action_yaw_deg:-5.7,
    action_reason:"heartbeat_failed", reason:"ready"});
  await p.getByText("#2 · cancelled · Target -45° · Yaw -5.7° · heartbeat_failed").waitFor();
  assert.ok(await p.locator("#execute").isDisabled());
});

test("Console content uses a shared typeface and size across panels", async t => {
  const {p} = await open(t);
  const mismatches = await p.evaluate(() => {
    const mainStyle = getComputedStyle(document.querySelector("main"));
    const text = document.querySelectorAll("main :is(h2,caption,th,td,dt,dd,p,output,small,button,label,legend,input,select)");
    return [...text].filter(el => {
      const style = getComputedStyle(el);
      return style.fontFamily !== mainStyle.fontFamily || style.fontSize !== mainStyle.fontSize;
    }).map(el => el.id || el.tagName);
  });
  assert.deepEqual(mismatches, []);
});

test("Joystick shows notices only when needed and keeps the pad stationary", async t => {
  const {p,board} = await open(t);
  const slot = p.locator("#stickFooter .status-slot");
  const pad = p.locator(".pad");
  assert.ok(await slot.isHidden());
  const before = await pad.boundingBox();
  board.event({owner:"usb"});
  await slot.getByText("USB host is driving").waitFor();
  assert.deepEqual(await pad.boundingBox(), before);
  board.event({owner:"free"});
  await slot.waitFor({state:"hidden"});
  await p.evaluate(() => say("Drive timed out. Release and press again."));
  await slot.getByText("Drive timed out. Release and press again.").waitFor();
  assert.deepEqual(await pad.boundingBox(), before);
});

test("Four corner gears surround the centered pad above the mode row", async t => {
  const {p,board} = await open(t);
  for (const [width,height] of [[320,640],[363,792],[390,844],[390,932]]) {
    await p.setViewportSize({width,height});
    const frame = await p.locator(".stick-board").boundingBox();
    const pad = await p.locator(".pad").boundingBox();
    assert.ok(Math.abs(frame.x+frame.width/2-pad.x-pad.width/2)<1);
    assert.ok(Math.abs(frame.y+frame.height/2-pad.y-pad.height/2)<1);
    const modes = await p.locator("#acceleration").boundingBox();
    assert.ok(frame.y + frame.height <= modes.y + 1);
    assert.ok(modes.y + modes.height <= (await p.locator("nav").boundingBox()).y);
    for (let i=0; i<4; i++) {
      const key = p.locator('[data-gear="'+i+'"]');
      const cell = await key.boundingBox();
      await key.tap({position:{x:cell.width*(i%2 ? 0.78 : 0.22),y:cell.height/2}});
      assert.equal(await key.getAttribute("aria-pressed"), "true");
    }
  }
  assert.ok(!board.packets.some(m => m.op === "claim"));
});

test("Narrow layout keeps related drive controls on one line", async t => {
  const {p} = await open(t);
  await p.setViewportSize({width:320,height:640});
  async function sameRow(selectors) {
    const boxes = await Promise.all(selectors.map(selector => p.locator(selector).boundingBox()));
    assert.ok(boxes.every(Boolean));
    const top = Math.max(...boxes.map(box => box.y));
    const bottom = Math.min(...boxes.map(box => box.y + box.height));
    assert.ok(top < bottom, selectors.join(" / "));
  }
  const telemetry = await p.locator("#vehicleTelemetry").boundingBox();
  const pad = await p.locator(".pad").boundingBox();
  const tabs = await p.locator(".drive-switch").boundingBox();
  assert.ok(telemetry.y + telemetry.height <= tabs.y);
  assert.ok(tabs.y + tabs.height <= pad.y);
  await sameRow(["[data-gear='0']","[data-gear='1']"]);
  await sameRow(["[data-gear='2']","[data-gear='3']"]);
  await sameRow(["[data-mode='smooth']","[data-mode='responsive']"]);
  await p.getByRole("button",{name:"Precision"}).tap();
  assert.ok(await p.locator("#speedSetting").isHidden());
  await sameRow(["[data-nudge='-10']", "#goalValue", "[data-nudge='10']"]);
  await p.getByRole("button",{name:"Settings"}).tap();
  await sameRow(["#nearby","#scanWifi"]);
  await sameRow(["#homePass","#showPass"]);
  await p.locator("#controllerPanel summary").tap();
  await sameRow(["#boardHost","#boardForm button"]);
});

test("Telemetry values stay on one line without shifting the drive controls", async t => {
  const {p,board} = await open(t);
  for (const width of [320, 390, 760]) {
    await p.setViewportSize({width,height:844});
    board.event({owner:"free",settled:true,m3_ticks:1,m4_ticks:2});
    await p.locator("#m3").getByText("1",{exact:true}).waitFor();
    const before = await p.locator(".drive-switch").boundingBox();
    board.event({owner:"wifi",settled:false,m3_ticks:-2147483648,m4_ticks:2147483647,
      left_pwm:-1000,right_pwm:1000,left_target_ticks_s:-9000,right_target_ticks_s:9000,
      left_ticks_s:-8999,right_ticks_s:8999,rate_window_ms:100,feedback_age_ms:999,
      imu:{accel_g:[-15.999,15.999,-15.999],gyro_dps:[-1999.99,-1999.99,1999.99]}});
    await p.locator("#m3").getByText("-2147483648",{exact:true}).waitFor();
    const after = await p.locator(".drive-switch").boundingBox();
    assert.equal(after.y,before.y);
    const fits = await p.locator("#vehicleTelemetry").evaluate(region =>
      [...region.querySelectorAll("dl > div, th, td")].every(cell => cell.scrollWidth <= cell.clientWidth + 1));
    assert.ok(fits, "readings fit at " + width + "px");
  }
});

test("Precision fits the portrait viewport with action feedback and a low battery", async t => {
  const {p, board} = await open(t);
  await p.getByRole("button", {name:"Precision"}).tap();
  board.event({action_id:1, action_state:"failed", reason:"imu_lost", action_yaw_deg:-18.5,
    battery_valid:true, battery_percent:3, battery_v:6.1, battery_low:true});
  await p.locator("#batteryAlarm").waitFor();
  for (const [width,height] of [[363,792], [390,844], [320,640]]) {
    await p.setViewportSize({width,height});
    const metrics = () => p.locator("#vehicleTelemetry, #vehicleTelemetry .instrument-card, #vehicleTelemetry tr, #chassisReadings > div").evaluateAll(elements =>
      elements.map(el => [el.getBoundingClientRect().y, el.getBoundingClientRect().height]));
    await p.getByRole("button", {name:"Joystick"}).tap();
    const manual = await metrics();
    await p.getByRole("button", {name:"Precision"}).tap();
    assert.deepEqual(await metrics(), manual);
    const kind = await p.getByRole("group", {name:"Movement type"}).boundingBox();
    const direction = await p.getByRole("group", {name:"Direction", exact:true}).boundingBox();
    assert.ok(direction.y >= kind.y + kind.height, "Direction is below Move and Turn");
    const run = await p.locator("#execute").boundingBox();
    const nav = await p.locator("nav").boundingBox();
    assert.ok(Math.abs(run.y + run.height - nav.y) <= 1, "Run is aligned with the bottom of the panel");
    const overflow = await p.locator("main").evaluate(el => el.scrollHeight - el.clientHeight);
    assert.ok(overflow <= 1, width + "px wide: overflow " + overflow);
  }
});

test("Running turn keeps the whole Stop button above Android navigation", async t => {
  const {p, board} = await open(t);
  await p.setViewportSize({width:363,height:792});
  await p.addStyleTag({content:"header { padding-top: 49px } nav { padding-bottom: 24px }"});
  await p.getByRole("button", {name:"Precision"}).tap();
  board.event({owner:"self", settled:false, action_id:3, action_state:"running",
    action_target_deg:45, action_yaw_deg:32.9});
  await p.locator("#progress").getByText(/running/).waitFor();
  assert.ok(await p.locator("#availability").isHidden());
  const stop = p.locator("#precisionStop");
  assert.ok(await stop.evaluate(el => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2;
    return r.height >= 44 && [r.top+1,r.bottom-1].every(y => document.elementFromPoint(x,y) === el);
  }));
  const overflow = await p.locator("main, #precisionControls").evaluateAll(els =>
    els.map(el => el.scrollHeight - el.clientHeight));
  assert.ok(overflow.every(n => n <= 1), JSON.stringify(overflow));
});

test("Precision renews fresh windows during a delayed heartbeat and shows one timeout result", async t => {
  const {p, board, packet} = await open(t);
  board.delayHeartbeat = true;
  await p.getByRole("button", {name:"Precision"}).tap();
  await p.getByRole("button", {name:"Turn", exact:true}).tap();
  await p.locator("#execute").tap();
  const first = await packet("heartbeat");
  board.renew();
  await packet("heartbeat", {window:board.window});
  board.send({id:first.id, ok:false, error:"STALE_WINDOW", lease:first.lease, window:first.window});
  board.renew();
  await packet("heartbeat", {window:board.window});
  assert.ok(!board.packets.some(m => m.op === "release"));
  board.event({owner:"free", driver_online:false, action_id:4, action_state:"cancelled",
    action_target_deg:-45, action_yaw_deg:-39.45, action_reason:"timeout", reason:"timeout"});
  await p.locator("#progress").getByText(/#4.*timeout/).waitFor();
  const trace = await p.evaluate(() => JSON.parse(localStorage.getItem("esp32.lastPrecisionTrace")));
  assert.equal(trace.action, 4);
  assert.equal(trace.reason, "timeout");
  assert.ok(trace.events.some(([, event, window]) => event === "window" && window === board.window));
  assert.ok(trace.events.some(([, event, window]) => event === "send" && window === board.window));
  assert.ok(await p.locator(".drive-summary").isHidden());
});

test("A silent open socket expires and telemetry resumes without replaying movement", async t => {
  const {p, board, packet} = await open(t);
  const start = board.packets.length;
  await p.getByText("Telemetry delayed", {exact:true}).waitFor();
  assert.ok(await p.locator(".up").isDisabled());
  assert.equal(await p.textContent("#m3"), "—");
  await packet("subscribe", {topic:"encoders"}, start);
  await until(async () => await p.locator(".up").isEnabled(), "fresh feedback after reconnect");
  assert.ok(board.packets.slice(start).every(m => ["hello","status","subscribe"].includes(m.op)));
});

test("Precision links to calibration when distance verification is missing", async t => {
  const {p} = await open(t, board => Object.assign(board.state, {
    distance_ready:false, precision_ready:false, yaw_ready:false
  }));
  await p.locator("[data-drive-panel=actions]").tap();
  await p.getByText("Verify distance calibration", {exact:true}).waitFor();
  await p.locator("#precisionCalibration").tap();
  assert.equal(await p.locator("#settingsButton").getAttribute("aria-current"), "page");
  assert.ok(await p.locator("[data-stage=turn]").isHidden());
  await p.locator("#calBack").tap();
  assert.ok(await p.locator("#openCalibration").isVisible());
});

for (const control of ["manual", "precision", "calibration"]) {
  test("Rotating releases " + control + " and requires a new portrait input", async t => {
    const {p, board, packet} = await open(t);
    if (control === "manual") {
      await p.locator(".up").focus();
      await p.keyboard.down("Space");
      await packet("drive");
    } else if (control === "precision") {
      await p.locator("[data-drive-panel=actions]").tap();
      await p.locator("#execute").tap();
      await packet("move_distance");
    } else {
      await enterStage(p, "distance");
      await p.locator("#trial").tap();
      await packet("cal_sample", {step:"trial"});
    }
    await p.setViewportSize({width:844,height:390});
    // Hiding a held direction can release its focus before the orientation event.
    await packet("release");
    await p.locator("#orientationNotice").waitFor();
    assert.ok(await p.locator("#stop").isVisible());
    assert.ok(await p.locator("#manual").isHidden());
    assert.ok(await p.locator("#execute").isHidden());
    assert.ok(await p.locator("[data-stage=distance]").isDisabled());
    const offset = board.packets.length;
    await p.setViewportSize({width:390,height:844});
    await p.locator("#orientationNotice").waitFor({state:"hidden"});
    await sleep(180);
    assert.ok(!board.packets.slice(offset).some(m => ["drive","move_distance","cal_sample","claim","cal_begin"].includes(m.op)));
  });
}
