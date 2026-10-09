const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * The readme a published package shows: its AGENTS.md without the `## Contents` table, whose
 * links point at repo files the package does not ship. npm and pnpm leave a symlinked README.md
 * out of a package, and every README.md here is a symlink to its AGENTS.md.
 */
module.exports = {
  hooks: {
    beforePacking(manifest, dir) {
      const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
      return { ...manifest, readme: text.replace(/^## Contents\n[\s\S]*?(?=^## |(?![\s\S]))/m, "") };
    },
  },
};
