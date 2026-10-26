// A fake `sanoma` launcher for the shell's smoke test (test/e2e), installed as the fixture
// company's node_modules/sanoma by its `pnpm install` (a `link:`, offline). It serves one page on
// SANOMA_APP_PORT that names the Node it runs on, says it is ready as the launcher does, writes
// how it started to `started.json`, and appends to `stopped` when its stdin closes or SIGTERM comes.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.SANOMA_APP_PORT);
const url = `http://127.0.0.1:${port}`;
const stopped = (why) => appendFileSync("stopped", `${why}\n`);

process.stdin.on("end", () => {
  stopped("stdin");
  process.exit(0);
});
process.stdin.resume();
process.on("SIGTERM", () => {
  stopped("SIGTERM");
  process.exit(143);
});

createServer((req, res) => {
  if (req.url === "/healthz") return res.writeHead(200).end();
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>fixture</title><p id="node">${process.versions.node}</p>`);
}).listen(port, "127.0.0.1", () => {
  writeFileSync("started.json", JSON.stringify({ port, node: process.versions.node, execPath: process.execPath }));
  if (process.env.SANOMA_EVENTS === "1") console.log(JSON.stringify({ sanoma: 1, event: "ready", url, sites: {} }));
  console.log(`fixture at ${url}; ctrl-c to stop`);
});
