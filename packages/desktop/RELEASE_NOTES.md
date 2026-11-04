The first preview of the Sanoma desktop app for macOS. Open a company folder and the app runs that company's own `sanoma` launcher and shows the app in a window. There is nothing to install first.

**Download** the `arm64` dmg on an Apple silicon Mac (M1 and later), or the `x64` dmg on an Intel Mac. Drag Sanoma to Applications and open it. The app is signed and notarized by Apple, so macOS opens it like any app from the web, after asking once whether to open something downloaded. The zip files hold the same apps.

## What it does

- Opens a company: a folder with a `sanoma.config.ts`. You can use Open folder… on the start screen, File → Open Company…, Open Recent, or drop a folder on the Dock icon.
- Starts a new company or clones one (File → New Company…, Clone Company…), and brings in a company's changes (Company → Get Updates).
- Installs and starts it with the Node 26 and pnpm the app ships, whatever the computer has (`pnpm install`, then the company's launcher).
- Shows the app in one window. Open several companies and switch between them from the account menu under your initials (or ⌘1…⌘9, the Window menu, the Dock menu); each keeps running, gets its own storage and keeps its port, so the app remembers who you are.
- Closing the window keeps every company running; Company → Stop stops one, and quitting stops them all. Each start is logged to `~/Library/Logs/Sanoma/`.
- Updates itself. In Applications, the app downloads a newer version in the background and installs it the next time you quit it, so it opens as the new version. Nothing restarts on its own; Help → Restart to Update, once an update is downloaded, restarts it at once. Run from the dmg or another folder, it cannot replace itself: it checks GitHub Releases once a day and links to a newer version instead (Help → Check for a Newer Sanoma).

## What it needs

Nothing to install for the app itself. Companies that use git need Apple's command line tools: macOS offers them the first time `git` runs.

## Known limits

- macOS only, 13.5 (Ventura) or later, as the Node 26 it ships requires. No Windows or Linux builds yet.
- Sanoma 0.1.0 does not update itself, nor hear of this release: download this one and replace it in Applications once. Later versions arrive on their own.
