// A fake `sanoma` launcher for the process manager's tests. FAKE_MODE says how it reports ready:
// "event" (the JSON line), "line" (0.6.0's human line), "silent" (only /healthz answers), "fail"
// (an error event, then exit 2), "stubborn" (as "event", but ignores SIGTERM), "crash" (exits 1,
// leaving a process in its group).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";

const mode = process.env.FAKE_MODE ?? "event";
const port = Number(process.env.SANOMA_APP_PORT);
// Its own name for the app, unlike the shell's /healthz poll (127.0.0.1), so a test sees which way it got ready.
const url = `http://localhost:${port}`;

if (existsSync(".env")) process.loadEnvFile(".env");
console.log(`env ${process.env.SANOMA_APP_PORT} ${process.env.SANOMA_EVENTS} ${process.env.PATH?.split(":")[0]}`);

if (mode === "fail") {
  console.log(JSON.stringify({ sanoma: 1, event: "error", message: "sanoma.config.ts: no workflows" }));
  process.exit(2);
}

// In the launcher's process group, as a worker or a pnpm it ran would be.
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(`pids ${process.pid} ${grandchild.pid}`);
// A crash: the launcher dies, its grandchild left behind in the group.
if (mode === "crash") setTimeout(() => process.exit(1), 100);

process.stdin.on("end", () => process.env.FAKE_STDIN && appendFileSync(process.env.FAKE_STDIN, "closed\n"));
process.stdin.resume();
// As the launcher does, it stops what runs before it exits on SIGTERM: here, a moment's wait.
process.on("SIGTERM", () =>
  mode === "stubborn" ? console.log("ignoring SIGTERM") : setTimeout(() => process.exit(143), 100),
);

createServer((req, res) => {
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(port, "127.0.0.1", () => {
  console.error("listening");
  if (mode === "event")
    console.log(JSON.stringify({ sanoma: 1, event: "ready", url, sites: { www: "http://www.localhost" } }));
  if (mode === "line") console.log(`acme at ${url}; ctrl-c to stop`);
});
