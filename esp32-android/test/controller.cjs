// SPDX-License-Identifier: Apache-2.0
// The browser talks to this protocol peer instead of energizing real motors.
const assert = require("node:assert/strict");

class Controller {
  constructor() {
    this.saved = {mapped: true, checks: 3, revision: 1, left_channel: 3,
      left_motor_sign: -1, right_motor_sign: 1, left_encoder_sign: -1, right_encoder_sign: 1,
      left_mm_tick: 0.12, right_mm_tick: 0.12, track_mm: 140};
    this.state = {driver_online: true, manual_ready: true, distance_ready: true, calibrated: true,
      manual_max_mm_s: 1000, settled: true, owner: "free", action_state: "idle", reason: "ready"};
    this.net = {setup_allowed: true, networks: [], scan_state: "idle", home_ssid: ""};
    this.packets = [];
    this.lease = 0;
    this.window = 1;
    this.clock = 1;
  }

  snapshot() {
    return {...this.state, t_ms: ++this.clock, calibration: this.draft || this.saved, saved_calibration: this.saved};
  }

  event(fields = {}) {
    Object.assign(this.state, fields);
    this.send({event: "encoders", ...this.snapshot()});
  }

  renew() {
    this.send({event: "control_window", lease: this.lease, window: ++this.window});
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  receive(raw) {
    const m = JSON.parse(raw);
    this.packets.push(m);
    const reply = data => this.send({id: m.id, ok: true, ...data});
    const reject = error => this.send({id: m.id, ok: false, error, owner: this.state.owner});
    if (m.op !== "hello" && m.session !== 41) return reject("BAD_SESSION");
    switch (m.op) {
      case "hello": return reply({session: 41, basic_ticks_max: 9000, capabilities: []});
      case "status": return reply(this.snapshot());
      case "subscribe": return reply();
      case "wifi_status": return reply(this.net);
      case "wifi_scan": Object.assign(this.net, {scan_state: "done", networks: ["Test AP"]}); return reply();
      case "wifi_test": this.net.home_ssid = m.ssid; return reply();
      case "wifi_forget": this.net.home_ssid = ""; return reply();
      case "claim": case "cal_begin":
        if (this.state.owner !== "free") return reject("BUSY");
        this.state.owner = "self";
        if (m.op === "cal_begin") this.draft = {...this.saved};
        return reply({lease: ++this.lease, window: this.window, accepted_ms: ++this.clock});
      case "stop":
        reply();
        return this.event({owner: "free", settled: true, action_state: "idle"});
    }
    if (m.lease !== this.lease || this.state.owner !== "self") return reject("NOT_OWNER");
    switch (m.op) {
      case "heartbeat": if (this.delayHeartbeat) return; return reply();
      case "drive": case "drive_low":
        if (this.delayDrive) return;
        return reply();
      case "turn_angle": case "move_distance":
        reply();
        return this.event({action_id: m.id, action_state: "running", settled: false});
      case "cal_sample":
        if (m.step === "map") this.draft.left_channel = m.left_channel;
        if (m.step === "finish") this.draft.checks &= ~(m.turn ? 2 : 1);
        if (m.step === "trial") {
          reply();
          return this.event({action_id: m.id, action_state: "running", settled: false});
        }
        return reply();
      case "cal_checkpoint": case "cal_cancel": case "release":
        if (m.op === "cal_checkpoint") this.saved = {...this.draft, revision: this.saved.revision + 1};
        this.draft = null;
        reply();
        return this.event({owner: "free", settled: true, reason: m.op === "cal_checkpoint" ? "saved" : "released"});
      default: assert.fail("Unexpected operation " + m.op);
    }
  }
}
module.exports = Controller;
