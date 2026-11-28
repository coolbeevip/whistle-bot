// SPDX-License-Identifier: Apache-2.0
"use strict";

for (const button of document.querySelectorAll("[data-stage]")) {
  button.onclick = () => guarded(async () => {
    if (busy || lease) return;
    busy = true;
    render();
    try {
      if (!await acquire("cal", ++generation)) return;
      stage = button.dataset.stage;
      const c = savedParams();
      $("stageTitle").textContent = titles[stage];
      $("mappingForm").hidden = stage !== "mapping";
      $("sampleForm").hidden = stage === "mapping";
      $("leftChannel").value = c.left_channel;
      for (const k of ["left_motor_sign","right_motor_sign","left_encoder_sign","right_encoder_sign"])
        $(k).value = c[k] || 1;
      const turn = stage === "turn";
      $("spin").hidden = !turn;
      $("instructions").textContent = turn ?
        "Put the rover on the ground and mark its heading. Start sampling, hold Jog left, then enter the measured angle. Left turns are positive." :
        "Lift both wheels. Start sampling and turn each wheel one full revolution forward. For 67.5 mm tires, enter 212 mm. If you use effective track width, repeat its test after changing the distance scale.";
      $("measureLabel").textContent = turn ? "Measured angle" : "Measured distance";
      $("measureUnit").textContent = $("trialUnit").textContent = turn ? "deg" : "mm";
      $("measure").value = turn ? 90 : 212;
      $("trialLabel").textContent = turn ? "Left turn target" : "Forward target";
      $("trialAmount").value = turn ? 90 : 200;
      $("save").textContent = "Save";
      say("");
    } finally { busy = false; render(); }
  });
}
$("cancel").onclick = () =>
  guarded(() => endCalibration("cal_cancel"));
function sample(step, fields = {}) {
  return call("cal_sample", { step, ...fields });
}
for (const [key, label] of [
  ["left_motor_sign", "Left motor"],
  ["right_motor_sign", "Right motor"],
  ["left_encoder_sign", "Left encoder"],
  ["right_encoder_sign", "Right encoder"],
]) {
  const lab = document.createElement("label"),
    select = document.createElement("select");
  lab.textContent = label;
  select.id = key;
  select.add(new Option("Normal +1", "1"));
  select.add(new Option("Reversed −1", "-1"));
  lab.append(select);
  $("mapping").append(lab);
}
function jogButton(b, channel, spin) {
  b.onpointerdown = (e) =>
    guarded(async () => {
      if (!e.isPrimary || e.button !== 0) return;
      b.setPointerCapture(e.pointerId);
      await sample("jog", { channel, direction: 1, spin });
    });
  b.onpointerup = b.onpointercancel = e => {
    if (e.isPrimary && (e.type === "pointercancel" || e.button === 0))
      guarded(() => sample("jog_stop"));
  };
}
document
  .querySelectorAll("[data-jog]")
  .forEach((b) => jogButton(b, Number(b.dataset.jog), false));
jogButton($("spin"), 3, true);
function editStage(fn) {
  return guarded(async () => {
    if (busy || !stage) return;
    busy = true;
    render();
    try { await fn(); } finally { busy = false; render(); }
  });
}
$("startSample").onclick = () => editStage(async () => {
  await sample("start", {turn: stage === "turn"});
  samplingNow = true;
  say("Sampling");
});
$("calculate").onclick = () => editStage(async () => {
  const turn = stage === "turn";
  try {
    await sample("finish", {turn, [turn ? "angle_deg":"distance_mm"]: Number($("measure").value)});
    samplingNow = false;
    last = await call("status");
    say("Sample calculated. Ready to save.");
  } catch (e) {
    if (e.message === "BAD_SAMPLE") samplingNow = false;
    throw e;
  }
});
$("trial").onclick = () => editStage(async () => {
  const turn = stage === "turn", amount = Number($("trialAmount").value);
  if (!(amount >= 1 && amount <= (turn ? 360 : 3000))) throw Error("Test target out of range");
  trialStage = stage;
  try {
    await sample("trial", {turn, [turn ? "angle_deg":"distance_mm"]: amount,
      request_key: session+"-"+id+"-"+Date.now()});
  } catch (e) {
    trialStage = "";
    throw e;
  }
  last = await call("status");
});
$("save").onclick = () => editStage(async () => {
  if (stage === "mapping") {
    const m = {left_channel: Number($("leftChannel").value)};
    for (const k of ["left_motor_sign","right_motor_sign","left_encoder_sign","right_encoder_sign"])
      m[k] = Number($(k).value);
    await sample("map",m);
  }
  await endCalibration("cal_checkpoint");
});
