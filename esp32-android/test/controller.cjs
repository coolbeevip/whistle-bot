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
    this.sessions = new Map();
    this.nextSession = 41;
    this.ownerClient = null;
    this.windows = new Map();
    this.actions = new Map();
    this.nextAction = 0;
  }

  owner(client) {
    if (this.state.owner === "self" && this.ownerClient !== null && this.ownerClient !== client) return "wifi";
    return this.state.owner;
  }

  snapshot(client) {
    const ownDraft = this.draft && this.owner(client) === "self";
    return {...this.state, owner:this.owner(client), t_ms:this.clock,
      calibration:ownDraft ? this.draft : this.saved, ...(ownDraft && {saved_calibration:this.saved})};
  }

  event(fields = {}) {
    Object.assign(this.state, fields);
    if (this.state.owner !== "self") this.ownerClient = null;
    const action = this.actions.get(this.state.action_id);
    if (action) {
      action.fields.action_state = this.state.action_state;
      action.fields.action_reason = this.state.action_reason;
    }
    for (const client of this.sessions.keys())
      this.send({event:"encoders", ...this.snapshot(client)}, client);
  }

  stop(reason) {
    const outcome = this.state.action_state === "running" ? {action_state:"cancelled", action_reason:reason} : {};
    this.draft = null;
    this.event({...outcome, owner:"free", settled:true, reason});
  }

  advance(ms) {
    const end = this.clock + ms;
    while (this.ownerClient !== null) {
      const next = Math.min(this.nextWindowAt, this.expires);
      if (next > end) break;
      this.clock = next;
      if (next === this.expires) this.stop("timeout");
      else this.openWindow();
    }
    this.clock = end;
  }

  openWindow() {
    this.windows.set(++this.window, this.clock);
    if (this.windows.size > (this.duration === 450 ? 5 : 2))
      this.windows.delete(this.windows.keys().next().value);
    this.nextWindowAt = this.clock + 100;
    this.send({event:"control_window", t_ms:this.clock, lease:this.lease, window:this.window,
      expires_at_ms:this.clock + this.duration}, this.ownerClient);
  }

  renew() {
    if (this.ownerClient !== null) this.advance(this.nextWindowAt - this.clock);
  }

  send(message, client = 0) {
    const socket = this.sockets?.[client] ?? this.socket;
    socket.send(JSON.stringify({v:1, ...message}));
  }

  actionByKey(key) {
    return [...this.actions.values()].find(action => action.key === key);
  }

  receive(raw, client = 0) {
    const m = JSON.parse(raw);
    this.packets.push(m);
    const reply = data => this.send({id:m.id, ok:true, ...data}, client);
    const reject = (error, fields) => this.send({id:m.id, ok:false, error, ...fields}, client);
    if (m.op !== "hello" && (!this.sessions.has(client) || m.session !== this.sessions.get(client)))
      return reject("SESSION");
    switch (m.op) {
      case "hello": {
        if (client === this.ownerClient) this.stop("disconnect");
        const session = this.nextSession;
        this.nextSession += 2;
        this.sessions.set(client, session);
        return reply({session, boot_id:1, basic_ticks_min:150, basic_ticks_max:9000, basic_ticks_default:325,
          max_abs_mm_s:this.state.manual_max_mm_s, max_twist_mm_s:100,
          capabilities:["drive","drive_low","encoders","calibration","move_distance","move_speed","turn_angle"]});
      }
      case "status": {
        const status = this.snapshot(client);
        if (m.request_key === undefined && m.action_id === undefined) return reply(status);
        const action = m.request_key === undefined ? this.actions.get(m.action_id) :
          this.actionByKey(m.request_key);
        if (!action) return reject("UNKNOWN_RESULT");
        for (const k of ["action_target_deg","action_target_mm","action_yaw_deg"]) delete status[k];
        return reply({...status, ...action.fields});
      }
      case "subscribe": return reply();
      case "wifi_status": return reply(this.net);
      case "wifi_scan": Object.assign(this.net, {scan_state: "done", networks: ["Test AP"]}); return reply();
      case "wifi_test": this.net.home_ssid = m.ssid; return reply();
      case "wifi_forget": this.net.home_ssid = ""; return reply();
      case "claim": case "cal_begin":
        if (this.state.owner !== "free") return reject("BUSY", {owner:this.owner(client)});
        this.state.owner = "self";
        if (m.op === "cal_begin") this.draft = {...this.saved};
        this.ownerClient = client;
        this.duration = m.precision || m.manual_pad ? 450 : 300;
        this.expires = this.clock + this.duration;
        this.nextWindowAt = this.clock + 100;
        this.windows.clear();
        this.windows.set(++this.window, this.clock);
        return reply({lease:++this.lease, window:this.window, accepted_ms:this.clock, expires_at_ms:this.expires});
      case "stop":
        reply();
        return this.stop("stop");
    }
    const owner = this.owner(client);
    if (client !== this.ownerClient || m.lease !== this.lease) return reject("NOT_OWNER", {owner});
    const motion = ["turn_angle","move_distance"].includes(m.op) || (m.op === "cal_sample" && m.step === "trial");
    const turn = m.op === "turn_angle" || m.turn === true;
    const target = turn ? m.angle_deg : m.distance_mm;
    if (motion) {
      const prior = this.actionByKey(m.request_key);
      if (prior) {
        if (prior.session !== m.session || prior.turn !== turn || prior.target !== target || prior.speed !== m.speed_mm_s)
          return reject("CONFLICT", {owner});
        return reply({action_id:prior.fields.action_id});
      }
    }
    if (!["release","cal_cancel"].includes(m.op) && !(m.op === "cal_sample" && m.step === "jog_stop")) {
      const opened = this.windows.get(m.window);
      const deadline = opened + this.duration;
      if (opened === undefined || deadline <= this.clock || (this.duration === 450 && deadline < this.expires))
        return reject("STALE_WINDOW", {owner, lease:this.lease, window:this.window});
      this.expires = deadline;
    }
    if (motion) {
      const id = ++this.nextAction;
      const fields = {action_id:id, action_state:"running", action_reason:"running",
        [turn ? "action_target_deg" : "action_target_mm"]:target};
      this.actions.set(id, {key:m.request_key, session:m.session, turn, target, speed:m.speed_mm_s, fields});
      if (this.actions.size > 16) this.actions.delete(this.actions.keys().next().value);
      delete this.state.action_target_deg;
      delete this.state.action_target_mm;
      reply({action_id:id});
      return this.event({...fields, settled:false});
    }
    switch (m.op) {
      case "heartbeat": if (this.delayHeartbeat) return; return reply();
      case "drive": case "drive_low":
        if (this.delayDrive) return;
        return reply();
      case "cal_sample":
        if (m.step === "map") this.draft.left_channel = m.left_channel;
        if (m.step === "finish") this.draft.checks &= ~(m.turn ? 2 : 1);
        return reply();
      case "cal_checkpoint": case "cal_cancel": case "release":
        if (m.op === "cal_checkpoint") this.saved = {...this.draft, revision: this.saved.revision + 1};
        reply();
        return this.stop(m.op === "cal_checkpoint" ? "saved" : "released");
      default: assert.fail("Unexpected operation " + m.op);
    }
  }
}
module.exports = Controller;
