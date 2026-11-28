// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {once} from "node:events";

const url = new URL(process.argv[2]);
const device = process.argv[3];
assert.equal(url.protocol, "ws:");
assert.match(device, /^Whistle-[0-9A-F]{6}$/);
const sockets = [];
const options = () => ({signal:AbortSignal.timeout(8000)});

function response(ws, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, Error("No reply to request " + id)), 8000);
    function finish(value, error) {
      clearTimeout(timer);
      ws.removeEventListener("message", message);
      ws.removeEventListener("close", closed);
      if (error) reject(error);
      else resolve(value);
    }
    function message(event) {
      const frame = JSON.parse(event.data);
      if (frame.id === id || frame.event === "rover_busy") finish(frame);
    }
    function closed(event) { finish(null, Error("Closed before reply: " + event.code)); }
    ws.addEventListener("message", message);
    ws.addEventListener("close", closed);
  });
}

async function attempt() {
  const ws = new WebSocket(url);
  sockets.push(ws);
  await once(ws, "open", options());
  const result = response(ws, 1);
  ws.send(JSON.stringify({v:1,id:1,op:"hello"}));
  return {ws, response:await result};
}

try {
  const contenders = await Promise.all([attempt(), attempt()]);
  const winners = contenders.filter(c => c.response.ok);
  assert.equal(winners.length, 1);
  const [winner] = winners;
  assert.equal(winner.response.device_id, device);
  assert.ok(winner.response.capabilities.includes("exclusive_ws"));
  assert.deepEqual(contenders.find(c => c !== winner).response, {v:1,event:"rover_busy",device_id:device});
  contenders.find(c => c !== winner).ws.close();
  const status = response(winner.ws, 2);
  winner.ws.send(JSON.stringify({v:1,id:2,op:"status",session:winner.response.session}));
  assert.equal((await status).ok,true);
  const closed = once(winner.ws, "close", options());
  winner.ws.close();
  await closed;
  const next = await attempt();
  assert.equal(next.response.ok,true);
  assert.equal(next.response.device_id,device);
  console.log("Concurrent admission, retained session and manual re-entry passed.");
} finally {
  for (const ws of sockets) ws.close();
}
