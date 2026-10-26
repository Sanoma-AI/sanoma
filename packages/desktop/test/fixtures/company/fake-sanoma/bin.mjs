// A fake `sanoma` launcher for the smoke test (test/e2e), linked into the fixture company by its
// `pnpm install`. The ready event and the human line name the app differently (127.0.0.1,
// localhost), and /healthz does not answer, so the URL the window loads says how the shell got ready.
// It serves once a `go` file is in the company's folder, so the test sees the start before the app.
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.SANOMA_APP_PORT);
const url = `http://127.0.0.1:${port}`;
const stop = () => {
  writeFileSync("stopped", "");
  process.exit(0);
};

process.stdin.on("end", stop);
process.stdin.resume();
process.on("SIGTERM", stop);

while (!existsSync("go")) await new Promise((resolve) => setTimeout(resolve, 50));

createServer((req, res) => {
  if (req.url === "/healthz") return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>fixture</title><p id="node">${process.versions.node}</p>`);
}).listen(port, "127.0.0.1", () => {
  writeFileSync("started.json", JSON.stringify({ port, execPath: process.execPath, pid: process.pid }));
  console.log(JSON.stringify({ sanoma: 1, event: "ready", url, sites: {} }));
  console.log(`fixture at http://localhost:${port}; ctrl-c to stop`);
});
