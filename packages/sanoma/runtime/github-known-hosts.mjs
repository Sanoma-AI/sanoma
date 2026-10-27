// GitHub's SSH host keys as known_hosts lines on stdout, for its SSH endpoint over the HTTPS port
// (`[ssh.github.com]:443`, which has github.com's keys), from GitHub's own list (`ssh_keys` of
// https://api.github.com/meta, over HTTPS): what entrypoint.sh trusts when it fetches with a
// deploy key. `node github-known-hosts.mjs > github_known_hosts` refreshes the image's copy, which
// a start trusts when the API cannot answer.
const res = await fetch("https://api.github.com/meta", {
  headers: { accept: "application/vnd.github+json", "user-agent": "sanoma-runtime" },
  // Short: the image has a copy to fall back on.
  signal: AbortSignal.timeout(3_000),
});
if (!res.ok) throw new Error(`api.github.com answered ${res.status} to /meta`);
const { ssh_keys: keys } = await res.json();
if (!Array.isArray(keys) || !keys.length) throw new Error("api.github.com/meta lists no ssh_keys");
process.stdout.write(keys.map((key) => `[ssh.github.com]:443 ${key}\n`).join(""));
