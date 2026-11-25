// SPDX-License-Identifier: Apache-2.0
const {createServer} = require("node:http");
const {readFile} = require("node:fs/promises");
const path = require("node:path");

function createConsoleServer() {
  return createServer(async (req, res) => {
    const file = req.url.split("?")[0];
    const asset = file === "/" ? "index.html" : /^\/src\/[a-z]+\.(css|js)$/.test(file) && file.slice(1);
    if (!asset || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(path.join(__dirname, "../www", asset));
      const type = {".html":"text/html", ".css":"text/css", ".js":"text/javascript"}[path.extname(asset)];
      res.writeHead(200, {"Content-Type": type + "; charset=utf-8", "Cache-Control":"no-store"}).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

module.exports = {createConsoleServer};
