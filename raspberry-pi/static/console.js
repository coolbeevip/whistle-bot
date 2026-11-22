// SPDX-License-Identifier: Apache-2.0
const $ = (id) => document.getElementById(id),
  image = document.querySelector("img"),
  buttons = [...document.querySelectorAll("[data-dir]")];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function preview() {
  let after = -1,
    current;
  for (;;) {
    if (document.hidden || page !== "drive") {
      await wait(250);
      continue;
    }
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 6000);
    try {
      const width = $("previewWidth").value;
      const r = await fetch("/frame.jpg?after=" + after + "&width=" + width, {
        signal: abort.signal,
      });
      if (!r.ok) throw Error();
      const blob = await r.blob();
      if (width !== $("previewWidth").value) continue;
      const url = URL.createObjectURL(blob);
      image.src = url;
      if (current) URL.revokeObjectURL(current);
      current = url;
      await image.decode();
      const ratio = String(image.naturalWidth / image.naturalHeight);
      if (image.parentElement.style.getPropertyValue("--frame-ratio") !== ratio)
        image.parentElement.style.setProperty("--frame-ratio", ratio);
      after = r.headers.get("X-Frame");
      $("camera").textContent = "Live";
      $("camera").classList.add("live");
      $("resolution").textContent =
        image.naturalWidth + " × " + image.naturalHeight;
      $("resolution").hidden = false;
    } catch {
      $("camera").classList.remove("live");
      $("camera").textContent = "Reconnecting…";
      await wait(750);
    } finally {
      clearTimeout(timer);
    }
  }
}
const names = {
  busy: "Drive in use",
  hold_timeout: "Drive stopped · input timed out",
  expired: "Input expired",
};
let ws,
  state = {},
  held = null,
  source = null,
  pending = false,
  clickedPhase,
  requestAt;
function send(op, fields = {}, ms = Date.now()) {
  if (ws?.readyState !== 1) return false;
  ws.send(
    JSON.stringify({
      op,
      ...fields,
      browser_ms: ms,
      ticket: state.ticket || 0,
    }),
  );
  return true;
}
function eventMs(e) {
  return e.timeStamp > 1e12
    ? e.timeStamp
    : performance.timeOrigin + e.timeStamp;
}
let page = "drive",
  pointer = null;
const stick = $("stick");
let autoMode = false,
  autoPending = false;
let precisionMode = false,
  goalPending = false,
  goalSent = 0,
  goalKind = "distance";
// Distance is stored in millimetres so repeated adjustments do not accumulate rounding error.
const targets = {
  distance: {
    value: 500,
    min: 1,
    max: 3000,
    step: 10,
    presets: [100, 500, 1000, 2000],
    dirs: ["forward", "reverse"],
    side: 0,
  },
  angle: {
    value: 90,
    min: 1,
    max: 360,
    step: 1,
    presets: [15, 45, 90, 180],
    dirs: ["left", "right"],
    side: 0,
  },
};
const nudgeButtons = [...document.querySelectorAll("[data-nudge]")];
const kindButtons = [...document.querySelectorAll("[data-kind]")];
const dirButtons = [$("dirA"), $("dirB")];
const presetButtons = [
  ...document.querySelectorAll('[aria-label="Target presets"] button'),
];
let repeatTimer,
  repeated = false;
function endAdjust() {
  clearTimeout(repeatTimer);
}
function displayGoal(value, preset = false) {
  if (goalKind === "angle") return value + "°";
  const metres = value / 1000;
  return (preset ? metres : metres.toFixed(value % 10 ? 3 : 2)) + " m";
}
function renderGoal(active, canRun) {
  const target = targets[goalKind];
  for (const button of kindButtons)
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.kind === goalKind),
    );
  dirButtons.forEach((button, i) => {
    const dir = target.dirs[i];
    button.textContent = dir[0].toUpperCase() + dir.slice(1);
    button.setAttribute("aria-pressed", String(target.side === i));
  });
  presetButtons.forEach((button, i) => {
    button.textContent = displayGoal(target.presets[i], true);
    button.setAttribute(
      "aria-pressed",
      String(target.value === target.presets[i]),
    );
  });
  $("goalValue").value = displayGoal(target.value);
  for (const button of [...kindButtons, ...dirButtons, ...presetButtons])
    button.disabled = active;
  for (const button of nudgeButtons) {
    const steps = Number(button.dataset.nudge);
    button.disabled =
      active ||
      (steps < 0 ? target.value === target.min : target.value === target.max);
    const amount = displayGoal(Math.abs(steps) * target.step);
    button.setAttribute(
      "aria-label",
      (steps < 0 ? "Decrease" : "Increase") + " by " + amount,
    );
  }
  $("runGoal").disabled = !active && !canRun;
  const direction = dirButtons[target.side].textContent;
  $("runGoal").textContent = active
    ? "Stop"
    : `GO · ${direction} ${displayGoal(target.value)}`;
  $("runGoal").classList.toggle("stopping", active);
}
for (const button of kindButtons)
  button.onclick = () => {
    endAdjust();
    goalKind = button.dataset.kind;
    render();
  };
dirButtons.forEach(
  (button, i) =>
    (button.onclick = () => {
      targets[goalKind].side = i;
      render();
    }),
);
presetButtons.forEach(
  (button, i) =>
    (button.onclick = () => {
      const t = targets[goalKind];
      t.value = t.presets[i];
      render();
    }),
);
for (const button of nudgeButtons) {
  function adjust() {
    if (button.disabled) return;
    const t = targets[goalKind];
    const next = t.value + Number(button.dataset.nudge) * t.step;
    t.value = Math.max(t.min, Math.min(t.max, next));
    render();
  }
  button.onpointerdown = (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    endAdjust();
    repeated = false;
    button.setPointerCapture(e.pointerId);
    function repeat() {
      if (button.disabled) return;
      repeated = true;
      adjust();
      repeatTimer = setTimeout(repeat, 85);
    }
    repeatTimer = setTimeout(repeat, 380);
  };
  button.onpointerup =
    button.onpointercancel =
    button.onlostpointercapture =
      endAdjust;
  button.oncontextmenu = (e) => e.preventDefault();
  button.onclick = (e) => {
    if (!repeated || e.detail === 0) adjust();
    repeated = false;
  };
}
function stopGoal() {
  if (goalPending || state.precision_active) send("precision_stop");
  goalPending = false;
}
function selectMode(precise, automatic = false) {
  if (!automatic && (state.auto?.active || autoPending)) send("auto_stop");
  if (precisionMode === precise && autoMode === automatic) return;
  autoMode = automatic;
  $("autoPanel").hidden = !automatic;
  $("autoMode").setAttribute("aria-pressed", String(automatic));
  endAdjust();
  $("drive").classList.toggle("precise", precise || automatic);
  center("mode");
  stopGoal();
  precisionMode = precise;
  stick.hidden = $("transmission").hidden = precise || automatic;
  $("precision").hidden = !precise;
  $("joystickMode").setAttribute(
    "aria-pressed",
    String(!precise && !automatic),
  );
  $("precisionMode").setAttribute("aria-pressed", String(precise));
  render();
}
$("joystickMode").onclick = () => selectMode(false);
$("precisionMode").onclick = () => selectMode(true);
$("autoMode").onclick = () => selectMode(false, true);
$("autoRun").onclick = () => {
  if (state.auto?.active || autoPending) send("auto_stop");
  else
    autoPending = send("auto_start", {
      instruction: $("instruction").value.trim(),
    });
  render();
};
$("instruction").oninput = () => render();
async function aiRequest(test) {
  $("aiSave").disabled = $("aiTest").disabled = true;
  $("aiMessage").textContent = test ? "Testing…" : "Saving…";
  try {
    const r = await fetch(test ? "/ai/test" : "/ai/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: $("aiEndpoint").value,
        model: $("aiModel").value,
        key: $("aiKey").value,
      }),
    });
    if (!r.ok) throw Error(await r.text());
    $("aiMessage").textContent = test ? (await r.json()).status : "Saved";
    if (!test) $("aiKey").value = "";
  } catch (e) {
    $("aiMessage").textContent = e.message;
  } finally {
    $("aiSave").disabled = $("aiTest").disabled = false;
  }
}
$("aiSave").onclick = () => aiRequest(false);
$("aiTest").onclick = () => aiRequest(true);
fetch("/ai/settings")
  .then((r) => r.json())
  .then((s) => {
    if (!$("aiEndpoint").value) $("aiEndpoint").value = s.endpoint;
    if (!$("aiModel").value) $("aiModel").value = s.model;
  })
  .catch(() => {
    $("aiMessage").textContent = "Settings unavailable";
  });
$("runGoal").onclick = () => {
  if (goalPending || state.precision_active) {
    stopGoal();
    render();
    return;
  }
  if ($("runGoal").disabled) return;
  endAdjust();
  const t = targets[goalKind],
    amount = goalKind === "angle" ? t.value : t.value / 1000;
  goalPending = send("precision", { direction: t.dirs[t.side], amount });
  goalSent = Date.now();
  render();
};
function available() {
  return (
    !precisionMode &&
    !autoMode &&
    !autoPending &&
    !state.auto?.active &&
    page === "drive" &&
    ws?.readyState === 1 &&
    !!state.ticket &&
    (state.online || state.phase === "recording")
  );
}
function setDirection(dir, input, ms, reason) {
  if (held === dir) return;
  if (held) send("up", { direction: held, reason }, ms);
  held = null;
  source = null;
  if (dir && available() && send("down", { direction: dir }, ms)) {
    held = dir;
    source = input;
  }
  buttons.forEach((b) => b.classList.toggle("lit", b.dataset.dir === held));
}
function center(reason, ms = Date.now()) {
  if (
    ["blur", "pagehide", "hidden", "navigation", "disconnect"].includes(reason)
  ) {
    endAdjust();
    stopGoal();
  }
  setDirection(null, null, ms, reason);
  if (pointer !== null && stick.hasPointerCapture(pointer))
    stick.releasePointerCapture(pointer);
  pointer = null;
  stick.classList.remove("active");
  moveKnob(0, 0);
}
function moveKnob(x, y) {
  stick.style.setProperty("--dx", x + "px");
  stick.style.setProperty("--dy", y + "px");
}
function track(e) {
  const r = stick.getBoundingClientRect(),
    x = e.clientX - r.left - r.width / 2,
    y = e.clientY - r.top - r.height / 2;
  const length = Math.hypot(x, y),
    limit = r.width * 0.25,
    scale = Math.min(1, limit / (length || 1));
  moveKnob(x * scale, y * scale);
  const dir =
    length < r.width * 0.12
      ? null
      : Math.abs(x) > Math.abs(y)
        ? x > 0
          ? "right"
          : "left"
        : y > 0
          ? "reverse"
          : "forward";
  setDirection(dir, "stick", eventMs(e), dir ? "change" : "center");
}
stick.onpointerdown = (e) => {
  if (
    !available() ||
    !e.isPrimary ||
    e.button !== 0 ||
    held ||
    pointer !== null
  )
    return;
  e.preventDefault();
  pointer = e.pointerId;
  stick.setPointerCapture(pointer);
  stick.classList.add("active");
  track(e);
};
stick.onpointermove = (e) => {
  if (pointer === e.pointerId) track(e);
};
stick.onpointerup =
  stick.onpointercancel =
  stick.onlostpointercapture =
    (e) => {
      if (pointer === e.pointerId) center(e.type, eventMs(e));
    };
stick.oncontextmenu = (e) => e.preventDefault();
const arrows = {
  ArrowUp: ["forward", 0, -1],
  ArrowDown: ["reverse", 0, 1],
  ArrowLeft: ["left", -1, 0],
  ArrowRight: ["right", 1, 0],
};
window.onkeydown = (e) => {
  if (
    !available() ||
    pointer !== null ||
    !Object.hasOwn(arrows, e.key) ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey
  )
    return;
  e.preventDefault();
  if (e.repeat) return;
  const [dir, x, y] = arrows[e.key],
    scale = stick.clientWidth * 0.25;
  setDirection(dir, e.key, eventMs(e), "change");
  moveKnob(x * scale, y * scale);
  stick.classList.add("active");
};
window.onkeyup = (e) => {
  if (source === e.key) center("keyup", eventMs(e));
};
window.onblur = () => center("blur");
window.onpagehide = () => center("pagehide");
document.onvisibilitychange = () => {
  if (document.hidden) center("hidden");
};
setInterval(() => {
  if (
    precisionMode &&
    page === "drive" &&
    !document.hidden &&
    (goalPending || state.precision_active)
  )
    send("precision_keep");
  if (held && available() && !document.hidden)
    send("hold", { direction: held });
}, 75);
const gears = [...document.querySelectorAll("[data-gear]")];
let lastPrefs = "";
function updateSetting(key, value) {
  send("chassis_setting", { key, value });
}
for (const button of gears) {
  const key = button.dataset.gear,
    slider = $(key),
    output = slider.nextElementSibling;
  button.onclick = () => updateSetting("gear", key);
  slider.oninput = () => {
    output.value = (Number(slider.value) / 1000).toFixed(2) + " m/s";
    slider.setAttribute("aria-valuetext", output.value);
  };
  slider.onchange = () => updateSetting(key, Number(slider.value));
}
$("mode").onclick = () =>
  updateSetting(
    "acceleration",
    state.settings.acceleration === "smooth" ? "responsive" : "smooth",
  );
$("turn").onchange = () => updateSetting("turn", $("turn").value);
function renderPrefs() {
  const prefs = state.settings,
    limit = state.speed_limit_mm_s;
  const signature = JSON.stringify([prefs, limit]);
  if (signature === lastPrefs) return;
  lastPrefs = signature;
  $("drivePrefs").disabled = $("mode").disabled = !prefs;
  for (const button of gears) {
    button.disabled = !prefs;
    if (!prefs) continue;
    const key = button.dataset.gear,
      slider = $(key),
      speed = Math.min(limit, prefs[key]);
    button.setAttribute("aria-pressed", String(prefs.gear === key));
    button.querySelector("small").textContent =
      (speed / 1000).toFixed(2) + " m/s";
    slider.max = Math.floor(limit / 10) * 10 || limit;
    slider.min = Math.min(20, Number(slider.max));
    slider.value = speed;
    slider.oninput();
  }
  if (!prefs) return;
  const sport = prefs.acceleration === "responsive";
  $("mode").firstElementChild.textContent = sport ? "Sport" : "Comfort";
  $("mode").setAttribute("aria-pressed", String(sport));
  $("turn").value = prefs.turn;
}
function render() {
  renderPrefs();
  const open = ws?.readyState === 1 && !!state.ticket,
    recording = state.phase === "recording";
  $("chassis").textContent = !open
    ? "Disconnected"
    : state.online
      ? "Drive online"
      : "Drive offline";
  $("chassis").classList.toggle("online", open && state.online);
  $("record").disabled =
    !open || pending || ["saving", "starting"].includes(state.phase);
  $("record").textContent = recording
    ? "Stop recording"
    : state.phase === "saving"
      ? "Saving…"
      : "Record";
  $("record").classList.toggle("on", recording);
  $("clock").textContent = recording
    ? "REC · " +
      Math.floor(state.elapsed / 60) +
      ":" +
      String(state.elapsed % 60).padStart(2, "0")
    : !open
      ? "Unknown"
      : state.phase === "saving"
        ? "Saving…"
        : state.phase === "starting"
          ? "Starting…"
          : "Standby";
  $("clock").classList.toggle("on", recording);
  stick.setAttribute("aria-disabled", String(!available()));
  if (!available() && (pointer !== null || held)) center("unavailable");
  const mission = state.auto || {},
    running = mission.active || autoPending;
  $("autoRun").textContent = running ? "Stop" : "GO";
  $("autoRun").disabled =
    !open ||
    (!running &&
      (!mission.configured ||
        !state.online ||
        !state.settled ||
        state.drive_busy ||
        !$("instruction").value.trim()));
  if (mission.active && mission.instruction)
    $("instruction").value = mission.instruction;
  $("instruction").disabled = !!running;
  $("autoState").textContent =
    (mission.active && mission.step ? "Step " + mission.step + " · " : "") +
    (mission.status ||
      (!mission.configured
        ? "Set an endpoint in Settings → AI"
        : !state.online
          ? "Connect the chassis"
          : "Ready"));
  const ready = goalKind === "angle" ? state.angle_ready : state.distance_ready;
  const active = !!state.precision_active || goalPending;
  renderGoal(
    active,
    open && !autoPending && state.online && ready && !state.drive_busy,
  );
  const hint =
    !autoMode && mission.active
      ? mission.status === "Stopping…"
        ? "Stopping…"
        : "Auto in use"
      : precisionMode
        ? active
          ? "Moving…"
          : !state.online
            ? ""
            : !ready
              ? goalKind === "angle"
                ? "Angle calibration needed"
                : "Distance calibration needed"
              : state.drive_busy
                ? "Drive in use"
                : ""
        : "";
  const feedback =
    state.notice === "offline" ? "" : names[state.notice] || state.notice;
  $("notice").textContent =
    hint || feedback || (recording && !state.online ? "Inputs logged" : "");
}
function connect() {
  ws = new WebSocket("ws://" + location.host + "/control");
  ws.onmessage = (e) => {
    const next = JSON.parse(e.data);
    if (
      pending &&
      (clickedPhase !== next.phase ||
        Date.now() - requestAt > 3000 ||
        next.notice !== state.notice)
    )
      pending = false;
    if (
      (state.phase === "saving" && next.phase === "idle") ||
      (state.phase === "recording" && next.phase === "idle")
    )
      list();
    if (next.precision_active || next.notice || Date.now() - goalSent > 1000)
      goalPending = false;
    if (next.auto?.active || next.notice) autoPending = false;
    const joinMission = !state.ticket && next.auto?.active;
    state = next;
    if (joinMission) selectMode(false, true);
    render();
  };
  ws.onclose = () => {
    center("disconnect");
    state = {};
    pending = false;
    autoPending = false;
    render();
    setTimeout(connect, 900);
  };
}
$("record").onclick = (e) => {
  if (pending) return;
  clickedPhase = state.phase;
  requestAt = Date.now();
  pending = send(
    state.phase === "recording" ? "finish" : "record",
    { record_width: Number($("recordWidth").value) },
    eventMs(e),
  );
  render();
};
const selected = new Set();
let listed = [],
  deleting = false,
  playing = null,
  listVersion = 0;
function selection() {
  $("allFiles").checked = listed.length > 0 && selected.size === listed.length;
  $("allFiles").indeterminate =
    selected.size > 0 && selected.size < listed.length;
  $("delete").disabled = deleting || !selected.size;
  $("delete").textContent = selected.size
    ? "Delete (" + selected.size + ")"
    : "Delete selected";
}
function stopPlayback() {
  const player = $("player");
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.hidden = true;
  playing = null;
}
function play(id) {
  const player = $("player");
  playing = id;
  player.hidden = false;
  player.src = "/files/" + id + ".mp4?play=1";
  player.play().catch(() => {
    if (player.error)
      $("fileMessage").textContent =
        "Playback failed. Try downloading the MP4.";
  });
  player.scrollIntoView({ block: "nearest" });
}
async function list() {
  const version = ++listVersion;
  try {
    const r = await fetch("/recordings");
    if (!r.ok) throw Error();
    const ids = await r.json();
    if (version !== listVersion) return;
    listed = ids;
    for (const id of selected) if (!ids.includes(id)) selected.delete(id);
    if (playing && !ids.includes(playing)) stopPlayback();
    const box = $("files");
    box.replaceChildren();
    $("manage").hidden = !ids.length;
    box.classList.toggle("empty", !ids.length);
    if (!ids.length) box.textContent = "No recordings yet";
    for (const id of ids) {
      const row = document.createElement("div");
      row.className = "file";
      const label = document.createElement("label"),
        check = document.createElement("input");
      check.type = "checkbox";
      check.checked = selected.has(id);
      check.onchange = () => {
        if (check.checked) selected.add(id);
        else selected.delete(id);
        selection();
      };
      const date = id.slice(0, 4) + "-" + id.slice(4, 6) + "-" + id.slice(6, 8);
      const clock =
        id.slice(9, 11) +
        ":" +
        id.slice(11, 13) +
        ":" +
        id.slice(13, 15) +
        " UTC";
      const time = document.createElement("time"),
        detail = document.createElement("small");
      time.dateTime = date + "T" + clock.slice(0, 8) + "Z";
      detail.textContent = clock;
      time.append(date, detail);
      label.append(check, time);
      row.append(label);
      const watch = document.createElement("button");
      watch.textContent = "Play";
      watch.onclick = () => play(id);
      row.append(watch);
      for (const ext of ["mp4", "json"]) {
        const a = document.createElement("a");
        a.textContent = ext.toUpperCase();
        a.href = "/files/" + id + "." + ext;
        a.download = id + "." + ext;
        row.append(a);
      }
      box.append(row);
    }
    selection();
  } catch {
    $("fileMessage").textContent = "Could not load recordings";
  }
}
$("allFiles").onchange = () => {
  selected.clear();
  if ($("allFiles").checked) for (const id of listed) selected.add(id);
  for (const c of $("files").querySelectorAll("input"))
    c.checked = $("allFiles").checked;
  selection();
};
$("delete").onclick = async () => {
  const ids = [...selected];
  if (
    !ids.length ||
    deleting ||
    !confirm("Delete " + ids.length + " recording(s), including MP4 and JSON?")
  )
    return;
  deleting = true;
  selection();
  try {
    const r = await fetch("/recordings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids),
    });
    if (!r.ok) throw Error();
    $("fileMessage").textContent = "Deleted " + ids.length;
  } catch {
    $("fileMessage").textContent = "Deletion failed. Check the list and retry.";
  } finally {
    deleting = false;
    await list();
    selection();
  }
};
const tabs = [...document.querySelectorAll("nav button")];
function navigate(next) {
  center("navigation");
  if (page === "library" && playing) stopPlayback();
  page = next;
  for (const tab of tabs) {
    const selected = tab.dataset.page === page;
    $(tab.dataset.page).hidden = !selected;
    if (selected) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
    if (selected)
      $("title").textContent =
        page === "drive" ? "Whistle Bot" : tab.textContent.trim();
  }
  document.querySelector("main").scrollTop = 0;
  if (page === "library") list();
  render();
}
for (const tab of tabs) tab.onclick = () => navigate(tab.dataset.page);
for (const id of ["previewWidth", "recordWidth"]) {
  const select = $(id),
    key = "rover." + id;
  try {
    const saved = localStorage.getItem(key);
    if ([...select.options].some((option) => option.value === saved))
      select.value = saved;
  } catch {}
  let accepted = select.value;
  select.onchange = () => {
    const width = Number(select.value);
    if (width > 1280) {
      const effect =
        id === "previewWidth"
          ? "A larger preview uses more Wi-Fi bandwidth and may lag while driving."
          : width === 2592
            ? "Full sensor recording uses software encoding at a target of 5 fps. Preview may slow down."
            : "1080p recording uses more storage and may reduce preview smoothness.";
      if (
        !window.confirm(
          effect + " Use " + select.selectedOptions[0].textContent + "?",
        )
      ) {
        select.value = accepted;
        return;
      }
    }
    accepted = select.value;
    if (id === "previewWidth") {
      image.removeAttribute("src");
      $("resolution").hidden = true;
    }
    try {
      localStorage.setItem(key, select.value);
    } catch {}
  };
}
render();
connect();
preview();
