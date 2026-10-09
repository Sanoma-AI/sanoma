const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * The readme a published package shows: its AGENTS.md, without the `## Contents` table, whose links
 * point at repo files the package does not ship. A package's README.md is a symlink to its AGENTS.md,
 * and npm and pnpm leave symlinks out of a package.
 */
module.exports = {
  hooks: {
    beforePacking(manifest, dir) {
      const agents = join(dir, "AGENTS.md");
      if (!existsSync(agents)) return manifest;
      const text = readFileSync(agents, "utf8");
      return { ...manifest, readme: text.replace(/^## Contents[ \t]*\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m, "") };
    },
  },
};
