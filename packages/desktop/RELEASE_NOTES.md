The first preview of the Sanoma desktop app for macOS. Open a company folder and the app runs that company's own `sanoma` launcher and shows the app in a window. There is nothing to install first.

**Download** `Sanoma-0.1.0-arm64.dmg` on an Apple silicon Mac (M1 and later) or `Sanoma-0.1.0-x64.dmg` on an Intel Mac. Drag Sanoma to Applications. The zip files hold the same apps.

**The first open.** The build is not signed by Apple yet, so macOS blocks it the first time:

1. Open Sanoma from Applications and dismiss the warning.
2. Open System Settings → Privacy & Security, scroll to Security, and click "Open Anyway" next to the message about Sanoma.
3. Confirm with your password. From then on it opens normally.

If "Open Anyway" does not appear, run this in Terminal: `xattr -dr com.apple.quarantine /Applications/Sanoma.app`.

## What it does

- Opens a company: a folder with a `sanoma.config.ts`. You can use Open folder… in the start window, File → Open Company…, Open Recent, or drop a folder on the Dock icon.
- Installs and starts it with the Node 24 and pnpm the app ships, whatever the computer has (`pnpm install`, then the company's launcher).
- Shows the app in a window per company. Each company gets its own storage and keeps its port, so the app remembers who you are.
- Stops each company when its window closes or the app quits. Each start is logged to `~/Library/Logs/Sanoma/`.
- Checks GitHub Releases once a day for a newer version. Help → Check for a Newer Sanoma checks on demand, and Help links to a newer release when there is one.

## What it needs

Nothing to install for the app itself. Companies that use git need Apple's command line tools: macOS offers them the first time `git` runs.

## Known limits

- Unsigned and not notarized, so the first open goes through "Open Anyway".
- macOS only, 13.5 (Ventura) or later, as the Node 24 it ships requires. No Windows or Linux builds yet.
- No automatic updates: the app tells you about a newer version, and you download it and replace the app in Applications.
- The launcher on npm (sanoma 0.6.0) still starts PostgreSQL in Docker when nothing answers at the company's database URL, so a company needs Docker or a database URL in its `.env` until sanoma 0.7.0 brings embedded PostgreSQL.
- New company, Clone and Get Updates come in a later version. For now, open a folder that already holds a company.
