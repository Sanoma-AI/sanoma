// The shell's main process: wiring only. What it runs and how is in the modules it imports, which
// never import electron and are tested on their own.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BaseWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  screen,
  shell,
  Tray,
  type WebContents,
  WebContentsView,
  webContents,
} from "electron";
import squirrelStartup from "electron-squirrel-startup";
import {
  afterFailure,
  type Company,
  companyName,
  partitionOf,
  portFor,
  type RecentCompany,
  readCompanies,
  recentOf,
  remember,
  slugOf,
  toReopen,
  updated,
  writeCompanies,
} from "./companies.ts";
import {
  addressProblem,
  cloneSession,
  cloneTarget,
  createSession,
  defaultParent,
  newCompanyProblem,
} from "./create.ts";
import {
  gitEnv,
  gitFailure,
  type Identity,
  identityOf,
  identityProblem,
  installCommandLineTools,
  needsCommandLineTools,
  setIdentity,
} from "./git.ts";
import { USAGE_EXIT } from "./launcher.ts";
import { isAppPage, linkTarget } from "./links.ts";
import { type CompanyLog, hidePasswords, openLog } from "./logs.ts";
import { folderArgument, isCompanyFolder, realPathOf, syncedFolderWarning } from "./places.ts";
import { archWarnings, runtimeOf } from "./runtime.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { type Newer, readSettings, runCheck, savedNewer, type Settings, writeSettings } from "./update-check.ts";
import { fastForward, prepareUpdate } from "./update-company.ts";
import { nextShown, windowBounds } from "./window-state.ts";

const companiesFile = () => join(app.getPath("userData"), "companies.json");
const logFile = (path: string) => join(app.getPath("logs"), `${slugOf(path)}.log`);
const settingsFile = () => join(app.getPath("userData"), "settings.json");
/** The shell's own pages': the start screen and each company's progress page. */
const shellPreferences = { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true };
type ShellPage = "index.html" | "company.html";
/** Loads one of start/'s pages: from Vite's dev server under `pnpm start`, else from the build. */
const loadShellPage = (contents: Electron.WebContents, page: ShellPage) =>
  START_VITE_DEV_SERVER_URL
    ? contents.loadURL(`${START_VITE_DEV_SERVER_URL}/${page}`)
    : contents.loadFile(join(__dirname, "..", "renderer", START_VITE_NAME, page));

/** Changes the entry companies.json has for `path` (`updated`), read and written at once. */
const patchCompany = (path: string, patch: Partial<Company>) =>
  writeCompanies(companiesFile(), updated(readCompanies(companiesFile()), path, patch));
/** Changes the shell's settings, read and written at once. */
const patchSettings = (patch: Partial<Settings>) =>
  writeSettings(settingsFile(), { ...readSettings(settingsFile()), ...patch });

/** What the start screen shows: the recent companies, marked when they run, and a form. */
export interface StartState {
  recent: RecentCompany[];
  warnings: string[];
  /** One line the start screen shows: why what was asked did not happen (`problem`), or what did. */
  notice?: { text: string; problem: boolean };
  /** A form the start screen shows: a repository's address to clone, or who commits. */
  ask?: { kind: "clone"; url?: string; problem?: string } | ({ kind: "identity"; problem?: string } & Identity);
}

/** What a company's own page shows (`start/company.html`): its start, or why it stopped. */
export interface CompanyState {
  path: string;
  name: string;
  /** `running`: the app answers, and the window shows it once it has loaded (`showsApp`). */
  phase: "starting" | "running" | "failed" | "stopped";
  progress: string[];
  log: string[];
  message?: string;
  warnings: string[];
  /** Whether the next launch opens it again (`Company.open`): a failed one offers not to. */
  reopens: boolean;
}

/** A company in the window as its app's account menu lists it (`app-preload.ts`): an opaque id, never its path. */
export interface DesktopCompany {
  id: string;
  name: string;
  shown: boolean;
}

interface Running {
  session: Session;
  log: CompanyLog;
  /** Set when the shell itself stops it: Stop, Restart, Get Updates, Quit. */
  stopping: boolean;
}

/**
 * The shell's one window, made at launch and closed only by Quit (closing it hides it): a
 * `BaseWindow` holding the start screen and each company's two views, of which only the start
 * screen or the shown company's page or app is visible, filling it. No chrome of the shell's own:
 * the app's account menu switches companies, as do ⌘1…⌘9, the Window menu and the Dock menu.
 */
interface ShellWindow {
  window: BaseWindow;
  startView: WebContentsView;
}

/**
 * A company in the window, from its first start until Company → Stop: the shell's page for it
 * (progress, the log, why it stopped) and the app's view, in the company's own storage
 * (`partitionOf`: the `sanoma_actor` cookie ignores ports, so two companies must not share one).
 * Which of the two shows is swapped in place. Switching to another company hides both and keeps
 * them loaded, so switching back is instant and the app is where it was.
 */
interface CompanyViews {
  /** How its app names it to the shell (`DesktopCompany`): made up for this launch. */
  id: string;
  shellView: WebContentsView;
  appView: WebContentsView;
  /** Whether it shows its app, else the shell's page: the app answers and has loaded. */
  showsApp: boolean;
  /** Where its app answers now: the link rule reads it, as Restart may move the port. */
  url: string;
  state: CompanyState;
  /** The start whose tail the shell's page shows. */
  log?: CompanyLog;
  sendTimer?: NodeJS.Timeout;
}

/** One session per company folder (by real path). */
const running = new Map<string, Running>();
/** The window's companies, by real path, in the order they came: there from their first start until Company → Stop. */
const inWindow = new Map<string, CompanyViews>();
/** The company the window shows, by real path; none while it shows the start screen. */
let shownPath: string | undefined;
/** Folders being opened: between the click and the session, a second click must not start another, and Quit waits. */
const opening = new Map<string, Promise<void>>();
/** Port choices, one at a time: two companies opened at once must not both take the same free port. */
let claiming: Promise<unknown> = Promise.resolve();
/** Set once Quit begins: nothing starts, and the window closes. */
let quitting = false;

let shellWindow: ShellWindow | undefined;
/** Elsewhere than macOS, which has the Dock: the icon that brings the hidden window back. */
let tray: Tray | undefined;
let ask: StartState["ask"];
let notice: StartState["notice"];

const archWarning = () => archWarnings(app.runningUnderARM64Translation);

/** Whether the company runs or is starting now. */
const isLive = (path: string) => running.has(path) || opening.has(path);
/** The companies running or starting now, by real path. */
const live = () => new Set([...running.keys(), ...opening.keys()]);

let startTimer: NodeJS.Timeout | undefined;
/** Sends the start screen what it shows (soon, once for a burst of changes). */
function sendStart() {
  startTimer ??= setTimeout(() => {
    startTimer = undefined;
    const contents = shellWindow?.startView.webContents;
    if (contents && !contents.isDestroyed()) contents.send("start:state", startState());
  }, 100);
}

const startState = (): StartState => ({
  recent: recentOf(readCompanies(companiesFile()), live()),
  warnings: archWarning(),
  notice,
  ask,
});

/** The window's companies, for their apps' account menus. */
const desktopCompanies = (): DesktopCompany[] =>
  [...inWindow].map(([path, { id, state }]) => ({ id, name: state.name, shown: path === shownPath }));

/**
 * Menu items for the window's companies, the shown one checked: the Window menu's (`accelerators`:
 * ⌘1…⌘9, and the ids the smoke test clicks), and the Dock menu's and the tray's.
 */
const switchItems = (accelerators: boolean): MenuItemConstructorOptions[] =>
  [...inWindow].map(([path, { state }], index) => ({
    label: state.name,
    type: "checkbox",
    checked: path === shownPath,
    ...(accelerators && { id: `company-${index + 1}` }),
    ...(accelerators && index < 9 && { accelerator: `CmdOrCtrl+${index + 1}` }),
    click: () => show(path),
  }));

/**
 * Whatever lists the window's companies, after they or the one shown changed: each app's account
 * menu (while its view shows the app's own page), the Window menu (and the Company menu, which
 * acts on the one shown), the Dock menu and the tray's.
 */
function switchersChanged() {
  const companies = desktopCompanies();
  for (const { appView, url } of inWindow.values()) {
    const contents = appView.webContents;
    if (!contents.isDestroyed() && isAppPage(contents.getURL(), url)) contents.send("desktop:companies", companies);
  }
  buildMenu();
  app.dock?.setMenu(Menu.buildFromTemplate(switchItems(false)));
  tray?.setContextMenu(trayMenu());
}

const trayMenu = () =>
  Menu.buildFromTemplate([
    { label: "Show Sanoma", click: showWindow },
    ...(inWindow.size ? [{ type: "separator" } as const, ...switchItems(false)] : []),
    { type: "separator" },
    { role: "quit" },
  ]);

/** The tray icon, whose menu shows the window, lists the companies and quits; a click shows the window. */
async function makeTray() {
  // The app's own icon as the system shows it (Electron's, until the shell has one of its own).
  tray = new Tray(await app.getFileIcon(process.execPath, { size: "small" }));
  tray.setToolTip("Sanoma");
  tray.setContextMenu(trayMenu());
  tray.on("click", showWindow);
}

/** One of the shell's own pages: it never navigates and opens nothing. */
function shellPage(contents: WebContents) {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** A view showing one of the shell's own pages. */
function shellView(page: ShellPage) {
  const view = new WebContentsView({ webPreferences: shellPreferences });
  shellPage(view.webContents);
  void loadShellPage(view.webContents, page);
  return view;
}

/** The window, made the first time: at its saved bounds, showing the start screen. */
function windowOf(): ShellWindow {
  if (shellWindow) return shellWindow;
  const window = new BaseWindow({
    ...windowBounds(
      readSettings(settingsFile()).bounds,
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    title: "Sanoma",
  });
  const startView = shellView("index.html");
  window.contentView.addChildView(startView);
  shellWindow = { window, startView };
  let saveTimer: NodeJS.Timeout | undefined;
  /** Saves the window's bounds in the settings, for the next launch (`windowBounds`); a failure only loses them. */
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      if (!window.isDestroyed()) patchSettings({ bounds: window.getNormalBounds() });
    } catch (err) {
      console.error(`the window's bounds could not be saved: ${messageOf(err)}`);
    }
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 500);
  };
  window.on("resize", () => {
    layout();
    saveSoon();
  });
  window.on("move", saveSoon);
  // The View menu acts on the focused page: the one shown.
  window.on("focus", focusShown);
  window.on("close", (event) => {
    if (!quitting) event.preventDefault();
    saveBounds();
    if (quitting) return;
    // Elsewhere than macOS, with nothing to keep (no company, no form waiting on the start screen)
    // or no tray icon to come back from: closing it quits, as before the one window.
    if (process.platform !== "darwin" && ((!inWindow.size && !answer) || !tray)) return app.quit();
    // Else it hides, and every company goes on, its workflows with it. A full-screen window
    // hidden as it is would leave its Space behind, empty.
    if (!window.isFullScreen()) return window.hide();
    window.once("leave-full-screen", () => window.hide());
    window.setFullScreen(false);
  });
  window.on("closed", () => {
    const companies = [...inWindow.values()];
    for (const views of companies) clearTimeout(views.sendTimer);
    const views = [startView, ...companies.flatMap((company) => [company.shellView, company.appView])];
    for (const view of views) view.webContents.close();
  });
  layout();
  return shellWindow;
}

/** The company the window shows, if it shows one. */
const shownViews = () => (shownPath === undefined ? undefined : inWindow.get(shownPath));

/**
 * Lays the window out from what it shows: the start screen or the shown company's page or app,
 * filling it; every other view hidden.
 */
function layout() {
  const { window, startView } = windowOf();
  if (window.isDestroyed()) return;
  const shown = shownViews();
  const { width, height } = window.getContentBounds();
  const page = { x: 0, y: 0, width, height };
  startView.setVisible(!shown);
  startView.setBounds(page);
  for (const views of inWindow.values()) {
    views.shellView.setBounds(page);
    views.appView.setBounds(page);
    views.shellView.setVisible(views === shown && !views.showsApp);
    views.appView.setVisible(views === shown && views.showsApp);
  }
  window.setTitle(shown?.state.name ?? "Sanoma");
}

/** Gives the shown page the focus while the window has it, so the View menu and typing act on it. */
function focusShown() {
  const { window, startView } = windowOf();
  const shown = shownViews();
  const { webContents: contents } = !shown ? startView : shown.showsApp ? shown.appView : shown.shellView;
  if (!window.isDestroyed() && window.isFocused() && !contents.isDestroyed()) contents.focus();
}

/** The window, shown and focused: a hidden one comes back as it was. */
function showWindow() {
  const { window } = windowOf();
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Shows the company at `path` (one in the window), or the start screen, in the window, shown. */
function show(path: string | undefined) {
  shownPath = path;
  layout();
  switchersChanged();
  if (path === undefined) sendStart();
  showWindow();
  focusShown();
}

/** File → Add Company…, and the account menu's Add company…: the start screen, in the window. */
const showStart = () => show(undefined);

/** Shows the company's page or its app, in place of the other (while it is the one shown). */
function reveal(views: CompanyViews, showsApp: boolean) {
  views.showsApp = showsApp;
  layout();
  if (views === shownViews()) focusShown();
}

/** Changes what the company's page shows, and sends it soon; any phase but `running` shows that page. */
function setCompanyState(views: CompanyViews, next: Partial<CompanyState>) {
  views.state = { ...views.state, ...next };
  if (next.phase && next.phase !== "running") reveal(views, false);
  views.sendTimer ??= setTimeout(() => {
    views.sendTimer = undefined;
    if (views.log) views.state = { ...views.state, log: views.log.tail() };
    const contents = views.shellView.webContents;
    if (!contents.isDestroyed()) contents.send("start:state", views.state);
  }, 100);
}

/** Loads the app at `url` into the company's app view, and shows it there once it has loaded. */
function showApp(views: CompanyViews, url: string) {
  views.url = url;
  setCompanyState(views, { phase: "running" });
  void views.appView.webContents
    .loadURL(url)
    .catch(() => {})
    .finally(() => {
      // It may have stopped meanwhile, started again, or left the window.
      if (views.state.phase === "running" && views.url === url && !views.appView.webContents.isDestroyed()) {
        reveal(views, true);
      }
    });
}

/** The company's views, put in the window (last) the first time it starts, showing its page. */
function viewsFor(path: string): CompanyViews {
  const existing = inWindow.get(path);
  if (existing) return existing;
  /** Its storage, shared with the windows the app opens (GitHub's), which get no preload. */
  const webPreferences = {
    partition: partitionOf(path),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
  // Its companies API (app-preload.ts), which the shell answers for the app's own page only.
  const appView = new WebContentsView({
    webPreferences: { ...webPreferences, preload: join(__dirname, "app-preload.cjs") },
  });
  guard(appView.webContents, path, webPreferences);
  // A page until the app's: a view that never loaded one is a page Playwright's smoke test waits on.
  void appView.webContents.loadURL("about:blank");
  const views: CompanyViews = {
    id: randomUUID(),
    shellView: shellView("company.html"),
    appView,
    showsApp: false,
    url: "",
    state: {
      path,
      name: companyName(path),
      phase: "starting",
      progress: [],
      log: [],
      warnings: [],
      reopens: true,
    },
  };
  const { contentView } = windowOf().window;
  contentView.addChildView(appView);
  contentView.addChildView(views.shellView);
  inWindow.set(path, views);
  layout();
  switchersChanged();
  return views;
}

/**
 * Takes the company out of the window (Company → Stop): its views close, and when it was the one
 * shown, the next company shows (`nextShown`), or the start screen when none is left.
 */
function removeFromWindow(path: string) {
  const views = inWindow.get(path);
  if (!views) return;
  const order = [...inWindow.keys()];
  inWindow.delete(path);
  clearTimeout(views.sendTimer);
  const { window } = windowOf();
  for (const view of [views.shellView, views.appView]) {
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    view.webContents.close();
  }
  if (shownPath === path) return show(nextShown(order, path));
  layout();
  switchersChanged();
}

/**
 * Says `text` on the start screen, shown, in place of what it said last: in the window, never a
 * native dialog, which would hold up the shell (and its smoke test) until someone clicks it.
 */
function tell(text: string, problem = true) {
  notice = { text, problem };
  showStart();
}

/**
 * Opens the company in `dir`: switches to it when it is in the window already (starting it again
 * when it stopped on its own), else starts it there.
 */
async function openCompany(dir: string) {
  notice = undefined;
  if (!isCompanyFolder(dir)) {
    return tell(`${dir} holds no company (no sanoma.config.ts): open the folder a company was started in.`);
  }
  const path = realPathOf(dir);
  if (inWindow.has(path)) show(path);
  // Stopped a moment ago (Company → Stop): its session is still ending.
  else await running.get(path)?.session.ended;
  await begin(path);
}

/** How a session begins (`startSession`, `createSession`, `cloneSession`). */
type Begin = (options: SessionOptions) => Session;

/**
 * How each company's next start begins while it is not the usual one: a new company's init or a
 * clone, until it is ready, so Start again after a failure tries that again.
 */
const beginnings = new Map<string, Begin>();

/**
 * Starts the company unless it runs or is starting, with `how` (else as it began last, until that
 * was ready, else `startSession`), in the window, whose page for it shows the start and then the
 * app; a failure to start says why there. A company new to the window shows at once; one starting
 * again (Restart, Start again, Get Updates) stays where it is.
 */
async function begin(path: string, how?: Begin) {
  if (isLive(path) || quitting) return;
  if (how) beginnings.set(path, how);
  const added = !inWindow.has(path);
  const views = viewsFor(path);
  setCompanyState(views, { phase: "starting", progress: [], log: [], message: undefined, reopens: true });
  views.log = undefined;
  if (added) show(path);
  const started = start(path, views, beginnings.get(path) ?? startSession).catch((err: unknown) => {
    // Before its session (no Node staged, an unreadable folder): its page says why.
    const message = hidePasswords(`The company could not start: ${messageOf(err)}`);
    setCompanyState(views, { phase: "failed", message, progress: [], log: [], reopens: reopensAfterEnd(path) });
  });
  opening.set(path, started);
  sendStart();
  await started;
  opening.delete(path);
  sendStart();
}

/**
 * Once a session has ended (failed, or stopped), whether the next launch still opens the company:
 * not when its folder holds no company (a clone or init that failed or was stopped), which also
 * leaves Recent (`afterFailure`).
 */
function reopensAfterEnd(path: string): boolean {
  const companies = readCompanies(companiesFile());
  const kept = afterFailure(companies, path);
  if (kept.length !== companies.length) {
    writeCompanies(companiesFile(), kept);
    buildMenu();
    sendStart();
  }
  return kept.some((c) => c.path === path && c.open);
}

/** The company's port (`portFor`), remembered in companies.json with the company, marked open. */
async function claimPort(path: string) {
  const { port, moved } = await portFor(readCompanies(companiesFile()), path);
  // Read again: another company may have been saved meanwhile.
  const companies = readCompanies(companiesFile());
  const before = companies.find((c) => c.path === path);
  const company: Company = {
    ...before,
    path,
    name: companyName(path),
    port,
    // Opened now, unless it was open already (a launch reopening it, Restart, Start again, Get
    // Updates): the companies reopen in the order they were opened (`toReopen`, oldest first).
    lastOpened: before?.open ? before.lastOpened : new Date().toISOString(),
    open: true,
  };
  writeCompanies(companiesFile(), remember(companies, company));
  buildMenu();
  return { company, moved };
}

async function start(path: string, views: CompanyViews, how: Begin) {
  const claimed = claiming.then(() => claimPort(path));
  claiming = claimed.catch(() => {});
  const { company, moved } = await claimed;
  const { port } = company;
  if (quitting) return;
  const log = openLog(app.getPath("logs"), slugOf(path));
  const warnings = [...archWarning(), syncedFolderWarning(path, homedir()) ?? []].flat();
  for (const warning of warnings) log.write("shell", `warning: ${warning}`);
  if (moved) log.write("shell", `the remembered port is taken: the app moves to ${port}, and asks who you are again`);
  views.log = log;
  setCompanyState(views, { name: company.name, warnings });
  layout();
  switchersChanged();
  /** Whether the company's page shows this start: a later one replaces it, and Stop takes the page away. */
  const current = () => views.log === log && inWindow.get(path) === views;

  const session = how({
    repo: path,
    port,
    ...runtimeOf({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
    bin: join(app.getPath("userData"), "bin"),
    env: process.env,
    onLine(stream, line) {
      log.write(stream, line);
      // The page gets the log's tail while it shows; once it shows again, the next state carries it.
      if (current() && views.state.phase !== "running") setCompanyState(views, {});
    },
    onProgress(step) {
      log.write("shell", step);
      if (current()) setCompanyState(views, { progress: [...views.state.progress, step] });
    },
  });
  const entry: Running = { session, log, stopping: false };
  running.set(path, entry);
  session.ready.then(
    (url) => {
      if (entry.stopping) return;
      beginnings.delete(path);
      log.write("shell", `ready at ${url}`);
      if (current()) showApp(views, url);
    },
    () => {},
  );
  void session.ended.then((exit) => {
    if (running.get(path) === entry) running.delete(path);
    sendStart();
    if (entry.stopping) {
      log.write("shell", "stopped");
      log.close();
      // A clone or a new company stopped before it was there leaves Recent too.
      const reopens = reopensAfterEnd(path);
      if (current()) setCompanyState(views, { phase: "stopped", progress: [], reopens });
      return;
    }
    const said = exit.error ?? "the log below says what";
    const why =
      exit.code === USAGE_EXIT
        ? `The company's configuration has a problem (${said}). Fix it, then start again.`
        : (exit.error ?? `The company stopped (${exit.signal ?? `exit code ${exit.code}`}).`);
    log.write("shell", why);
    log.close();
    const reopens = reopensAfterEnd(path);
    if (!current()) return;
    setCompanyState(views, { phase: "failed", message: hidePasswords(why), progress: [], reopens });
    // A company that stops on its own says why on its page. It comes to the front when the window
    // is hidden or shows no other company; it never takes the window from the one in use, where
    // its page waits until it is switched to.
    const other = shownPath !== undefined && shownPath !== path;
    if (!other || !shellWindow?.window.isVisible()) show(path);
  });
}

/** Stops the company's session, if it runs; resolves once everything it started has exited. */
async function stop(path: string) {
  const entry = running.get(path);
  if (!entry) return;
  entry.stopping = true;
  await entry.session.stop();
}

/** The next launch does not open the company (`Company.open`), and its page says so. */
function dontReopen(path: string) {
  patchCompany(path, { open: false });
  const views = inWindow.get(path);
  if (views) setCompanyState(views, { reopens: false });
}

/**
 * Company → Stop: the company leaves the window (the next one shows, or the start screen) and
 * stops, and the next launch does not open it. One that stopped on its own just leaves.
 */
async function stopCompany(path: string) {
  // Still choosing its port: its session is not there to stop yet.
  await opening.get(path);
  dontReopen(path);
  removeFromWindow(path);
  await stop(path);
}

/** Stops the company and starts it again in its place, whose page shows the start, then the app again. */
async function restart(path: string) {
  await opening.get(path);
  await stop(path);
  await begin(path);
}

/**
 * Applies the link rule (`linkTarget`) to a company's page: navigation and `window.open` stay in
 * the shell for the app, its sites and GitHub (a new window in the same storage), the default
 * browser gets other web links, and anything else is refused.
 */
function guard(contents: WebContents, path: string, webPreferences: Electron.WebPreferences) {
  const target = (url: string) => linkTarget(url, inWindow.get(path)?.url ?? "");
  const outside = (url: string) => {
    if (target(url) === "browser") void shell.openExternal(url);
  };
  const navigate = (event: Electron.Event<{ url: string }>) => {
    if (target(event.url) === "window") return;
    event.preventDefault();
    outside(event.url);
  };
  contents.on("will-navigate", navigate);
  contents.on("will-redirect", navigate);
  // A page's beforeunload never holds up Quit, which would leave the shell half quit.
  contents.on("will-prevent-unload", (event) => {
    if (quitting) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (target(url) === "window") {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences } };
    }
    outside(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    guard(child.webContents, path, webPreferences);
    // A window the app opened goes with the page that opened it.
    contents.once("destroyed", () => child.isDestroyed() || child.close());
  });
}

async function chooseFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Open a company",
    buttonLabel: "Open",
    properties: ["openDirectory"],
  });
  if (!canceled && filePaths[0]) await openCompany(filePaths[0]);
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Where the folder dialogs of New Company and Clone Company start. */
const parentFolder = () => defaultParent(readCompanies(companiesFile()), homedir());

/** Answers the form the start screen shows (`ask`), once: with what was typed, or undefined (Cancel, another form). */
let answer: ((value: unknown) => void) | undefined;

/** Shows `form` on the start screen; resolves with the answer, or undefined when the person cancels. */
function askFor(form: NonNullable<StartState["ask"]>): Promise<unknown> {
  answer?.(undefined);
  return new Promise((resolve) => {
    answer = (value) => {
      answer = undefined;
      ask = undefined;
      sendStart();
      resolve(value);
    };
    ask = form;
    showStart();
  });
}

const isIdentity = (value: unknown): value is Identity =>
  typeof (value as Identity)?.name === "string" && typeof (value as Identity)?.email === "string";

/**
 * Whether git has someone to commit as from `cwd`: `user.name` and `user.email`, asked for once on
 * the start screen when either is missing and set globally (the form says so), as a new company's
 * first commit, and the app's later ones, need them.
 */
async function identityReady(cwd: string): Promise<boolean> {
  const env = gitEnv(process.env);
  let typed = await identityOf(cwd, env);
  if (typed.name && typed.email) return true;
  let problem: string | undefined;
  for (;;) {
    const value = await askFor({ kind: "identity", ...typed, problem });
    if (!isIdentity(value)) return false;
    typed = value;
    problem =
      identityProblem(value) ??
      (await setIdentity(value, env).then(
        () => undefined,
        (err: unknown) => `git could not save it: ${messageOf(err)}`,
      ));
    if (!problem) return true;
  }
}

/**
 * Whether git can run: on macOS, Apple's command line tools must be there; when they are not, a
 * dialog offers their installer and to check again.
 */
async function gitReady(): Promise<boolean> {
  while (await needsCommandLineTools()) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Sanoma needs Apple's command line tools for git",
      detail: "Install opens Apple's installer. Once it has finished, choose Check Again.",
      buttons: ["Install", "Check Again", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return false;
    if (response === 0) await installCommandLineTools();
  }
  return true;
}

/** File → New Company…: an empty folder (made in the dialog, or chosen), then the launcher's init there. */
async function newCompany(): Promise<void> {
  notice = undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Choose or make an empty folder for the new company",
    buttonLabel: "Start Company Here",
    defaultPath: parentFolder(),
    properties: ["openDirectory", "createDirectory"],
  });
  const dir = filePaths[0];
  if (canceled || !dir) return;
  const problem = isCompanyFolder(dir) ? `${dir} holds a company already: open it instead.` : newCompanyProblem(dir);
  if (problem) return tell(problem);
  const warning = syncedFolderWarning(dir, homedir());
  if (warning) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: "This folder is in iCloud",
      detail: warning,
      buttons: ["Choose Another Folder", "Use This Folder"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 0) return newCompany();
  }
  if (!(await gitReady()) || !(await identityReady(dir))) return;
  await begin(realPathOf(dir), createSession);
}

/**
 * File → Clone Company…: the repository's address (the start screen asks), the folder to clone
 * into (a dialog), then the clone, as the company's session (`cloneSession`), so its page shows
 * it and a failure, and Start again clones again.
 */
async function cloneCompanyFlow(): Promise<void> {
  notice = undefined;
  let url = "";
  let problem: string | undefined;
  do {
    const value = await askFor({ kind: "clone", url, problem });
    if (typeof value !== "string") return;
    url = value.trim();
    problem = addressProblem(url);
  } while (problem);
  if (!(await gitReady())) return;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Choose the folder to clone the company into",
    buttonLabel: "Clone Here",
    defaultPath: parentFolder(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled || !filePaths[0]) return;
  const parent = realPathOf(filePaths[0]);
  const target = cloneTarget(url, parent);
  if ("problem" in target) return tell(target.problem);
  if (!(await identityReady(parent))) return;
  await begin(target.dir, cloneSession(url));
}

/** The companies Get Updates runs for now: a second click meanwhile does nothing. */
const updating = new Set<string>();

/**
 * Company → Get Updates: GitHub's `main`, fast-forward only, when this computer has nothing of
 * its own (`prepareUpdate` refuses in one line, on the start screen, otherwise); then the company
 * starts again, which installs its packages (`startSession`), in its place in the window.
 */
async function getUpdates(path: string): Promise<void> {
  if (updating.has(path)) return;
  updating.add(path);
  const name = inWindow.get(path)?.state.name ?? companyName(path);
  const say = (text: string, problem = false) => tell(`${name}: ${text}`, problem);
  try {
    if (!(await gitReady())) return;
    const env = gitEnv(process.env);
    const plan = await prepareUpdate(path, env);
    if ("refused" in plan) return say(plan.refused, true);
    if (!plan.behind) return say("This company is up to date with GitHub");
    await opening.get(path);
    await stop(path);
    const failed = await fastForward(path, env).then(
      () => undefined,
      (err: unknown) => gitFailure(messageOf(err), "The update did not apply"),
    );
    await begin(path);
    // Updated, the company starts again in its place, its page showing the start: the window
    // stays on it. Only a fast-forward that failed is said on the start screen.
    if (failed) say(failed, true);
  } catch (err) {
    say(`Sanoma could not get updates: ${messageOf(err)}`, true);
  } finally {
    updating.delete(path);
  }
}

/** A Company menu action on the company the window shows. */
const forShown = (act: (path: string) => unknown) => () => {
  if (shownPath !== undefined) void act(shownPath);
};

/**
 * A View menu action on the page that has the focus: the menu's own roles act on a
 * `BrowserWindow`'s page only, and the window is a `BaseWindow` holding several.
 */
const forPage = (act: (contents: WebContents) => void) => () => {
  const contents = webContents.getFocusedWebContents();
  if (contents) act(contents);
};
const zoomBy = (step: number) => forPage((contents) => contents.setZoomLevel(contents.getZoomLevel() + step));

/** Its notification, held so that a click on it still reaches the shell once it is shown. */
let notification: Notification | undefined;

/** Checks one at a time, so two never both notify for the same version; what they found is shown outside the queue. */
let checking: Promise<unknown> = Promise.resolve();
function checkForUpdate(asked: boolean) {
  const current = app.getVersion();
  const run = checking.then(() => runCheck({ file: settingsFile(), current, asked }));
  checking = run.catch(() => {});
  void run.then(
    (result) => result && showCheck(asked, current, result),
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (asked)
        void dialog.showMessageBox({ type: "warning", message: "Sanoma could not check for a newer version", detail });
      else console.error(`update check: ${detail}`);
    },
  );
}

/** What a check found (`runCheck`): the Help menu, then a dialog when asked or a notification when due. */
async function showCheck(asked: boolean, current: string, { found, notify }: { found?: Newer; notify: boolean }) {
  buildMenu();
  if (asked) {
    const { response } = await dialog.showMessageBox(
      found
        ? {
            message: `Sanoma ${found.version} is available`,
            detail: `You have ${current}. Download it from its release page, then replace Sanoma in Applications.`,
            buttons: ["Open Release Page", "Later"],
          }
        : { message: `Sanoma ${current} is the newest version` },
    );
    if (found && response === 0) void shell.openExternal(found.url);
  } else if (found && notify && Notification.isSupported()) {
    notification = new Notification({
      title: `Sanoma ${found.version} is available`,
      body: "Click to open its release page.",
    });
    notification.on("click", () => void shell.openExternal(found.url));
    notification.show();
  }
}

/** The Help menu's update items: the release the last check found, while newer, and the check. */
function updateItems(): MenuItemConstructorOptions[] {
  const known = savedNewer(readSettings(settingsFile()), app.getVersion());
  return [
    ...(known ? [{ label: `Download Sanoma ${known.version}…`, click: () => void shell.openExternal(known.url) }] : []),
    { label: "Check for a Newer Sanoma", click: () => checkForUpdate(true) },
    { type: "separator" },
  ];
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const recent = readCompanies(companiesFile());
  /** The Company menu acts on the company shown: none while the window shows the start screen. */
  const shown = shownPath !== undefined;
  const template: MenuItemConstructorOptions[] = [
    // macOS's app menu holds Quit; elsewhere File does.
    ...(isMac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        { label: "New Company…", accelerator: "CmdOrCtrl+N", click: () => void newCompany() },
        { label: "Open Company…", accelerator: "CmdOrCtrl+O", click: () => void chooseFolder() },
        { label: "Clone Company…", click: () => void cloneCompanyFlow() },
        {
          label: "Open Recent",
          submenu: recent.length
            ? recent.map((c) => ({ label: c.name, sublabel: c.path, click: () => void openCompany(c.path) }))
            : [{ label: "No recent companies", enabled: false }],
        },
        { type: "separator" },
        { label: "Add Company…", click: showStart },
        { role: "close", label: "Close Window" },
        ...(isMac ? [] : [{ type: "separator" } as const, { role: "quit" } as const]),
      ],
    },
    { role: "editMenu" },
    {
      label: "Company",
      submenu: [
        { label: "Restart", accelerator: "CmdOrCtrl+Shift+R", enabled: shown, click: forShown(restart) },
        { id: "stop", label: "Stop", enabled: shown, click: forShown(stopCompany) },
        { label: "Get Updates", enabled: shown, click: forShown(getUpdates) },
        {
          label: isMac ? "Show in Finder" : "Show in Folder",
          enabled: shown,
          click: forShown((path) => shell.openPath(path)),
        },
        { label: "Show Log", enabled: shown, click: forShown((path) => shell.openPath(logFile(path))) },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: forPage((contents) => contents.reload()) },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: forPage((contents) => contents.setZoomLevel(0)) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: zoomBy(0.5) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoomBy(-0.5) },
        { type: "separator" },
        { role: "togglefullscreen" },
        {
          label: "Toggle Developer Tools",
          accelerator: "Alt+CmdOrCtrl+I",
          click: forPage((contents) => contents.toggleDevTools()),
        },
      ],
    },
    {
      // The window's companies, as the account menu and the Dock menu list them, ⌘1…⌘9 switching:
      // a company on an app release without the account menu's Companies has these.
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(inWindow.size ? [{ type: "separator" } as const, ...switchItems(true)] : []),
        ...(isMac ? [{ type: "separator" } as const, { role: "front" } as const] : []),
      ],
    },
    {
      role: "help",
      submenu: [
        ...updateItems(),
        { label: "Show Logs Folder", click: () => void shell.openPath(app.getPath("logs")) },
        { role: "about", label: `About Sanoma ${app.getVersion()}` },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The arguments after the executable; a checkout's app path among them is `ownPath`, which `folderArgument` skips. */
const argsOf = (argv: readonly string[]) => argv.slice(1);
/** The app's own path on a checkout's command line (`electron <app path>`), which is no company folder. */
const ownPath = () => (process.defaultApp ? app.getAppPath() : undefined);

// Windows: the Squirrel installer runs the app to add or remove its shortcuts, then expects it to quit.
if (squirrelStartup || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    const folder = folderArgument(argsOf(argv), cwd, ownPath());
    if (folder) void openCompany(folder);
    else showWindow();
  });
  // A folder dropped on the Dock icon, or opened with the app.
  const dropped: string[] = [];
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (app.isReady()) void openCompany(path);
    else dropped.push(path);
  });

  /** The company whose page sent an IPC message, if it is one. */
  const companyOf = (sender: WebContents) => [...inWindow].find(([, views]) => views.shellView.webContents === sender);
  ipcMain.handle("start:state", ({ sender }) => {
    if (sender === shellWindow?.startView.webContents) return startState();
    return companyOf(sender)?.[1].state;
  });
  ipcMain.handle("start:choose", () => chooseFolder());
  ipcMain.handle("start:open", (_event, path: unknown) => typeof path === "string" && openCompany(path));
  ipcMain.handle("start:again", ({ sender }) => {
    const [path] = companyOf(sender) ?? [];
    if (path) void begin(path);
  });
  // A company that failed: the next launch does not open it.
  ipcMain.handle("start:skip", ({ sender }) => {
    const [path] = companyOf(sender) ?? [];
    if (path) dontReopen(path);
  });
  ipcMain.handle("start:create", () => newCompany());
  ipcMain.handle("start:clone", () => cloneCompanyFlow());
  ipcMain.handle("start:answer", (_event, value: unknown) => answer?.(value));
  ipcMain.handle("start:cancel", () => answer?.(undefined));

  /**
   * The company whose app sent a `desktop:` message from its own page, in its top frame: nothing
   * else in its view (GitHub, a public site, a frame) or in a window it opened is answered.
   */
  const appOf = ({ sender, senderFrame }: Electron.IpcMainInvokeEvent) => {
    const views = [...inWindow.values()].find(({ appView }) => appView.webContents === sender);
    return views && senderFrame === sender.mainFrame && isAppPage(senderFrame.url, views.url) ? views : undefined;
  };
  ipcMain.handle("desktop:companies", (event) => {
    if (!appOf(event)) throw new Error("only a company's app, at its own address, lists the companies");
    return desktopCompanies();
  });
  ipcMain.handle("desktop:switch", (event, id: unknown) => {
    const path = [...inWindow].find(([, views]) => views.id === id)?.[0];
    if (appOf(event) && path) show(path);
  });
  ipcMain.handle("desktop:add", (event) => {
    if (appOf(event)) showStart();
  });

  // Quit waits for each company: those still opening, then every session, stopped. What is open
  // stays marked so (`Company.open`), for the next launch.
  let stopped = false;
  let stoppingAll: Promise<unknown> | undefined;
  app.on("before-quit", (event) => {
    quitting = true;
    if (!stopped && (running.size || opening.size)) {
      event.preventDefault();
      stoppingAll ??= Promise.all(opening.values())
        .then(() => Promise.all([...running.keys()].map(stop)))
        .finally(() => {
          stopped = true;
          app.quit();
        });
    }
  });
  // ctrl-c in the terminal that started the shell, or a kill: quit as the menu does, stopping each company.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  // The window closes only once Quit has begun (closing it hides it, or quits where there is no
  // Dock and no company): Electron must not quit on its own meanwhile.
  app.on("window-all-closed", () => {});
  // A click on the Dock icon (or the app opened again from Finder) shows the window.
  app.on("activate", () => app.isReady() && showWindow());

  void app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "Sanoma", applicationVersion: app.getVersion() });
    buildMenu();
    // No Dock elsewhere: the tray icon brings the hidden window back.
    if (process.platform !== "darwin") makeTray().catch((err: unknown) => console.error(`tray: ${messageOf(err)}`));
    // The built app only: a checkout's shell (start, the smoke test) shares its settings and asks GitHub only from Help.
    if (app.isPackaged) {
      checkForUpdate(false);
      // Hourly against the saved time, not a day-long timer, which would not count the hours asleep.
      setInterval(() => checkForUpdate(false), 60 * 60 * 1000);
    }
    // The window, at its saved bounds, and in it the companies open at the last Quit, oldest
    // first, so they keep their order and the latest opened shows.
    windowOf();
    for (const path of toReopen(readCompanies(companiesFile())).toReversed()) void begin(path);
    const folder = folderArgument(argsOf(process.argv), process.cwd(), ownPath()) ?? dropped.at(-1);
    if (folder) void openCompany(folder);
    showWindow();
  });
}
