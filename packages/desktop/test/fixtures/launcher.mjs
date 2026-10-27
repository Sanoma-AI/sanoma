// A fake `sanoma` launcher for the process manager's tests. FAKE_MODE says how it reports ready:
// "event" (the JSON line), "line" (0.6.0's human line), "silent" (only /healthz answers), "fail"
// (an error event, then exit 2), "stubborn" (as "event", but ignores the stop), "crash" (exits 1,
// leaving a process in its group). The stop is SIGTERM, or on Windows, which has none, stdin's end.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter } from "node:path";

const mode = process.env.FAKE_MODE ?? "event";
const port = Number(process.env.SANOMA_APP_PORT);
// Its own name for the app, unlike the shell's /healthz poll (127.0.0.1), so a test sees which way it got ready.
const url = `http://localhost:${port}`;

if (existsSync(".env")) process.loadEnvFile(".env");
console.log(`env ${process.env.SANOMA_APP_PORT} ${process.env.SANOMA_EVENTS} ${process.env.PATH?.split(delimiter)[0]}`);

if (mode === "fail") {
  console.log(JSON.stringify({ sanoma: 1, event: "error", message: "sanoma.config.ts: no workflows" }));
  process.exit(2);
}

// In the launcher's process group, as a worker or a pnpm it ran would be.
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(`pids ${process.pid} ${grandchild.pid}`);
// A crash: the launcher dies, its grandchild left behind in the group.
if (mode === "crash") setTimeout(() => process.exit(1), 100);

// As the launcher does, it stops what runs before it exits on the stop: here, a moment's wait, and
// on Windows its grandchild, which the shell cannot reach there once the launcher exited.
const stop = () => {
  if (mode === "stubborn") return console.log("ignoring the stop");
  if (process.platform === "win32") grandchild.kill();
  setTimeout(() => process.exit(143), 100);
};
process.stdin.on("end", () => {
  if (process.env.FAKE_STDIN) appendFileSync(process.env.FAKE_STDIN, "closed\n");
  if (process.platform === "win32") stop();
});
process.stdin.resume();
process.on("SIGTERM", stop);

createServer((req, res) => {
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(port, "127.0.0.1", () => {
  console.error("listening");
  if (mode === "event")
    console.log(JSON.stringify({ sanoma: 1, event: "ready", url, sites: { www: "http://www.localhost" } }));
  if (mode === "line") console.log(`acme at ${url}; ctrl-c to stop`);
});
