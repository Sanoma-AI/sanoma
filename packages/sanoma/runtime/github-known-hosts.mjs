// github.com's SSH host keys as known_hosts lines on stdout, from GitHub's own list
// (`ssh_keys` of https://api.github.com/meta, over HTTPS): what entrypoint.sh trusts when it
// fetches with a deploy key, and the copy the image is built with, for when the API cannot answer.
const res = await fetch("https://api.github.com/meta", {
  headers: { accept: "application/vnd.github+json", "user-agent": "sanoma-runtime" },
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) throw new Error(`api.github.com answered ${res.status} to /meta`);
const { ssh_keys: keys } = await res.json();
if (!Array.isArray(keys) || !keys.length) throw new Error("api.github.com/meta lists no ssh_keys");
process.stdout.write(keys.map((key) => `github.com ${key}\n`).join(""));
