// SPDX-License-Identifier: Apache-2.0
"use strict";
const {spawn} = require("node:child_process");
const {createInterface} = require("node:readline");
const Controller = require("../../../esp32-android/test/controller.cjs");

function firmware(executable) {
    const child = spawn(executable, {stdio: ["pipe", "pipe", "inherit"]});
    const lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
    const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(Error("firmware exited: " + (signal || code))));
    });
    return {
        async exchange(message) {
            child.stdin.write(JSON.stringify(message) + "\n");
            const line = await lines.next();
            if (line.done) throw Error("firmware closed its output");
            return JSON.parse(line.value);
        },
        async close() { child.stdin.end(); await exited; }
    };
}

function android() {
    const peer = new Controller();
    let packets, starts = 0, elapsed = 0;
    peer.socket = {send(raw) {
        const packet = JSON.parse(raw);
        if (packet.action_state === "running" && packet.event && packet.action_id !== lastAction) {
            starts++;
            lastAction = packet.action_id;
        }
        packets.push(packet);
    }};
    let lastAction;
    return {
        exchange({frame, advance = 0}) {
            packets = [];
            if (frame) peer.receive(JSON.stringify(frame));
            for (let i = 0; i < advance; i++) {
                if (++elapsed % 100 === 0 && peer.state.owner === "self") peer.renew();
            }
            return {reply: packets.find(p => p.id !== undefined), events: packets.filter(p => p.event), starts};
        },
        close() {}
    };
}

async function scenario(name, endpoint, run) {
    const failures = new Set();
    const sessions = [], windows = [];
    let lease, seq = 0;
    function check(ok, detail) { if (!ok) failures.add(detail); }
    async function exchange(input, client = 0) {
        const result = await endpoint.exchange({...input, client});
        for (const e of result.events) {
            if (e.event === "control_window") windows[client] = e.window;
        }
        return result;
    }
    async function request(op, fields = {}, client = 0) {
        const frame = {v: 1, id: ++seq, op, session: sessions[client], ...fields};
        const result = await exchange({frame}, client);
        const r = result.reply;
        if (!r) throw Error("missing reply for " + op);
        check(r.v === 1 && r.id === frame.id && typeof r.ok === "boolean", "reply envelope");
        return result;
    }
    async function hello(client = 0) {
        const {reply} = await request("hello", {}, client);
        sessions[client] = reply.session;
        check(reply.ok && Number.isInteger(reply.session) && reply.session > 0, "hello session");
        return reply;
    }
    async function claim() {
        const {reply} = await request("claim", {precision: true});
        check(reply.ok && !!reply.lease && !!reply.window, "precision lease");
        lease = reply.lease;
        windows[0] = reply.window;
    }
    const move = (key, mm) => request("move_distance", {request_key:key, distance_mm:mm, lease, window:windows[0]});
    const beat = (window, client = 0) => request("heartbeat", {lease, window}, client);
    const advance = ms => exchange({advance:ms});
    try {
        await run({check, request, hello, claim, move, beat, advance, sessions, windows, lease:() => lease});
    } finally {
        await endpoint.close();
    }
    console.log(name + " " + (failures.size ? "FAIL  " + [...failures].join(", ") : "PASS"));
    return failures.size === 0;
}

const cases = {
    async C1({check, hello, request}) {
        const h = await hello();
        check(Number.isInteger(h.boot_id) && Array.isArray(h.capabilities), "boot and capabilities");
        for (const field of ["basic_ticks_min","basic_ticks_max","basic_ticks_default","max_abs_mm_s","max_twist_mm_s"])
            check(Number.isInteger(h[field]) && h[field] > 0, field);
        check((await request("status")).reply.ok, "status after hello");
    },
    async C2({check, hello, request, sessions}) {
        await hello();
        const {reply} = await request("status", {session:sessions[0] + 1});
        check(reply.ok === false && reply.error === "SESSION", "SESSION");
        const {reply:status} = await request("status");
        check(status.ok && status.owner === "free", "session recovery");
    },
    async C3({check, hello, claim, move, request}) {
        await hello();
        await claim();
        const first = await move("A", 250);
        const id = first.reply.action_id;
        check(first.reply.ok && Number.isInteger(id) && id > 0 && id !== first.reply.id, "assigned action_id in reply");
        const {reply:status} = await request("status");
        check(status.action_id === id && status.action_target_mm === 250 && status.action_state === "running", "action correlation");
        const repeat = await move("A", 250);
        check(repeat.reply.ok && repeat.reply.action_id === id && repeat.starts === 1 && first.starts === 1, "one action start");
    },
    async C4({check, hello, claim, move, request, advance}) {
        await hello();
        await claim();
        const a = await move("A", 250);
        const aId = a.reply.action_id ?? (await request("status")).reply.action_id;
        await request("stop");
        await advance(160);
        await claim();
        const b = await move("B", 500);
        const {reply:current, starts} = await request("status");
        check(current.action_id === b.reply.action_id && current.action_id !== aId &&
            current.action_target_mm === 500 && current.action_state === "running", "live B");
        for (const lookup of [{request_key:"A"}, {action_id:aId}]) {
            const {reply, starts:after} = await request("status", lookup);
            check(reply.ok && reply.action_id === aId && reply.action_target_mm === 250 &&
                reply.action_state === "cancelled" && reply.action_reason === "stop" &&
                reply.owner === "self" && after === starts, "history by " + Object.keys(lookup)[0]);
        }
        const {reply, starts:after} = await request("status", {request_key:"unknown"});
        check(reply.ok === false && reply.error === "UNKNOWN_RESULT" && after === starts, "UNKNOWN_RESULT");
    }
};

function windowCase(recover) {
    return async ({check, hello, claim, move, request, beat, advance, sessions, windows, lease}) => {
        await hello();
        await hello(1);
        check(sessions[0] !== sessions[1], "independent sessions");
        await claim();
        await move("A", 250);
        const old = windows[0];
        await advance(100);
        const current = windows[0];
        const accepted = await beat(current);
        check(current !== old && accepted.reply.ok, "accept newer window");
        await advance(30);
        const {reply} = await beat(old);
        check(reply.ok === false && reply.error === "STALE_WINDOW" && reply.lease === lease() &&
            reply.window === current, "reject superseded window");
        const foreign = (await beat(current, 1)).reply;
        check(foreign.ok === false && foreign.error === "NOT_OWNER" &&
            foreign.lease === undefined && foreign.window === undefined, "owner isolation");
        if (recover) {
            check((await beat(current)).reply.ok, "resume with current window");
        } else {
            await advance(419);
            check((await request("status")).reply.owner === "self", "valid before deadline");
            await advance(1);
            const status = (await request("status")).reply;
            check(status.owner === "free" && status.action_reason === "timeout", "original expiry");
        }
    };
}
cases["C5/expiry"] = windowCase(false);
cases["C5/recovery"] = windowCase(true);

async function main() {
    const [executable, selected = "both"] = process.argv.slice(2);
    if (!["both","firmware","android"].includes(selected)) throw Error("expected both, firmware or android");
    let passed = true;
    for (const [name, make] of [["firmware", () => firmware(executable)], ["android", android]]) {
        if (selected !== "both" && selected !== name) continue;
        for (const [id, run] of Object.entries(cases))
            if (!await scenario(name + " " + id, make(), run)) passed = false;
    }
    process.exitCode = passed ? 0 : 1;
}
main().catch(error => { console.error(error); process.exitCode = 2; });
