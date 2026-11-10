A preview of the Sanoma desktop app for macOS and Windows. Open a company folder and the app runs that company's own `sanoma` launcher and shows the app in a window. There is nothing to install first.

**Download** the `arm64` dmg on an Apple silicon Mac (M1 and later), or the `x64` dmg on an Intel Mac. Drag Sanoma to Applications and open it. The app is signed and notarized by Apple, so macOS opens it like any app from the web, after asking once whether to open something downloaded. The zip files hold the same apps.

On a Windows x64 PC, download `Sanoma-windows-x64.exe` and run it: it installs for you alone, with no administrator prompt, and opens from the Start menu.

## What it does

- Opens a company: a folder with a `sanoma.config.ts`. You can use Open folder… on the start screen, File → Open Company…, Open Recent, or drop a folder on the Dock icon.
- Starts a new company or copies one from GitHub (File → New Company…, Copy from GitHub…), and brings in a company's changes (Company → Get Updates). A new company asks its name, your name and your email once, and shows each step of setting it up as it happens.
- Lists your companies with where each runs, as the app's badge says it: Local, or Live · drafting copy with its address, and whether it runs on this computer now.
- Installs and starts it with the Node 26 and pnpm the app ships, whatever the computer has (`pnpm install`, then the company's launcher).
- Shows the app in one window. Open several companies and switch between them from the account menu under your initials (or ⌘1…⌘9, the Window menu, the Dock menu); each keeps running, gets its own storage and keeps its port, so the app remembers who you are.
- Closing the window keeps every company running; Company → Stop stops one, and quitting stops them all. Each start is logged to `~/Library/Logs/Sanoma/` (on Windows, `%APPDATA%\Sanoma\logs`).
- Updates itself. In Applications, the app downloads a newer version in the background and installs it the next time you quit it, so it opens as the new version. Nothing restarts on its own; Help → Restart to Update, once an update is downloaded, restarts it at once. Run from the dmg or another folder, it cannot replace itself: it checks GitHub Releases once a day and links to a newer version instead (Help → Check for a Newer Sanoma). On Windows, the installed app downloads a newer version the same way, and the next launch is that version.

## What it needs

Nothing to install for the app itself. Companies that use git need Apple's command line tools: macOS offers them the first time `git` runs. On Windows, install [Git for Windows](https://git-scm.com/downloads/win); the app asks when it is missing.

## Known limits

- macOS 13.5 (Ventura) or later, as the Node 26 it ships requires, and Windows x64. No Linux or Windows on Arm builds yet.
- On Windows, the agent and anything that uses Resources (Go live among them) do not work yet. Where Smart App Control is on, it may block PostgreSQL and other programs a company installs, which stops the company from starting.
- Sanoma 0.1.0 does not update itself, nor hear of this release: download this one and replace it in Applications once. Later versions arrive on their own.
