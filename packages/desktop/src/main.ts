// The shell's main process: wiring only. What it runs and how is in the modules it imports, which
// never import electron and are tested on their own.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  shell,
  type WebContents,
} from "electron";
import {
  type Company,
  companyName,
  partitionOf,
  portFor,
  readCompanies,
  remember,
  slugOf,
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
import { linkTarget } from "./links.ts";
import { type CompanyLog, hidePasswords, openLog } from "./logs.ts";
import { folderArgument, isCompanyFolder, syncedFolderWarning } from "./places.ts";
import { runtimeOf } from "./runtime.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { fastForward, prepareUpdate } from "./update-company.ts";
import {
  checkDue,
  fetchReleases,
  isLater,
  type Newer,
  newerRelease,
  readSettings,
  writeSettings,
} from "./update-check.ts";

const here = dirname(fileURLToPath(import.meta.url));
const companiesFile = () => join(app.getPath("userData"), "companies.json");
const logFile = (path: string) => join(app.getPath("logs"), `${slugOf(path)}.log`);
const settingsFile = () => join(app.getPath("userData"), "settings.json");

/** What the start window shows: the recent companies, and the one starting or stopped. */
export interface StartState {
  recent: Company[];
  company?: { path: string; name: string };
  phase: "idle" | "starting" | "failed";
  progress: string[];
  log: string[];
  message?: string;
  warnings: string[];
  /** A form the start window shows: a repository's address to clone, or who commits. */
  ask?: { kind: "clone"; url?: string; problem?: string } | ({ kind: "identity"; problem?: string } & Identity);
}

interface Running {
  session: Session;
  log: CompanyLog;
  /** Set when the shell itself stops it: closing the window, Restart, Quit. */
  stopping: boolean;
}

/** One session per company folder (by real path), and its window once the app answers. */
const running = new Map<string, Running>();
/** Each company's window, and where its app answers now: the link rule reads it, as Restart may move the port. */
const windows = new Map<string, { window: BrowserWindow; url: string }>();
/** Folders being opened: between the click and the session, a second click must not start another, and Quit waits. */
const opening = new Map<string, Promise<void>>();
/** Port choices, one at a time: two companies opened at once must not both take the same free port. */
let claiming: Promise<unknown> = Promise.resolve();
let quitting = false;

let startWindow: BrowserWindow | undefined;
let state: StartState = { recent: [], phase: "idle", progress: [], log: [], warnings: [] };
/** The start of a company the start window shows: its tail is read when the state is sent. */
let shownLog: CompanyLog | undefined;

const archWarning = () =>
  app.runningUnderARM64Translation
    ? [
        "This is the Intel build of Sanoma on an Apple silicon Mac: download the Apple silicon (arm64) build, which runs faster.",
      ]
    : [];

let sendTimer: NodeJS.Timeout | undefined;
function setState(next: Partial<StartState>) {
  state = { ...state, ...next };
  sendTimer ??= setTimeout(() => {
    sendTimer = undefined;
    if (shownLog) state = { ...state, log: shownLog.tail() };
    // A hidden start window gets the state when shown again (`showStart`).
    if (startWindow?.isVisible()) startWindow.webContents.send("start:state", state);
  }, 100);
}

function showStart() {
  setState({ recent: readCompanies(companiesFile()) });
  if (startWindow) {
    startWindow.show();
    startWindow.focus();
    return;
  }
  startWindow = new BrowserWindow({
    width: 640,
    height: 720,
    title: "Sanoma",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  startWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  startWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  startWindow.on("closed", () => {
    startWindow = undefined;
    // Its form goes with it: New Company or Clone, waiting on it, stops.
    answer?.(undefined);
  });
  void startWindow.loadFile(join(here, "..", "start", "index.html"));
}

/** Opens the company in `dir`: focuses its window when it runs already, else starts it. */
async function openCompany(dir: string) {
  if (!isCompanyFolder(dir)) {
    await dialog.showMessageBox({
      type: "warning",
      message: "This folder holds no company",
      detail: `${dir} has no sanoma.config.ts. Open the folder a company was started in.`,
    });
    return;
  }
  const path = realpathSync(dir);
  const shown = windows.get(path);
  if (shown) return shown.window.focus();
  if (running.has(path) || opening.has(path)) return showStart();
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
 * was ready, else `startSession`); a failure to start says why in the start window.
 */
async function begin(path: string, how?: Begin) {
  if (running.has(path) || opening.has(path) || quitting) return;
  if (how) beginnings.set(path, how);
  const started = start(path, beginnings.get(path) ?? startSession).catch((err: unknown) => {
    // Before its session (no Node staged, an unreadable folder): the start window says why.
    shownLog = undefined;
    const message = hidePasswords(`The company could not start: ${messageOf(err)}`);
    setState({ company: { path, name: companyName(path) }, phase: "failed", message, progress: [], log: [] });
    showStart();
  });
  opening.set(path, started);
  await started;
  opening.delete(path);
}

/** The company's port (`portFor`), remembered in companies.json with the company. */
async function claimPort(path: string) {
  const companies = readCompanies(companiesFile());
  const { port, moved } = await portFor(companies, path);
  const company: Company = { path, name: companyName(path), port, lastOpened: new Date().toISOString() };
  writeCompanies(companiesFile(), remember(companies, company));
  buildMenu();
  return { company, moved };
}

async function start(path: string, how: Begin) {
  /** A Restart, whose window stays: closing it meanwhile cancels the start. */
  const restarting = windows.has(path);
  const claimed = claiming.then(() => claimPort(path));
  claiming = claimed.catch(() => {});
  const { company, moved } = await claimed;
  const { port } = company;
  if (quitting || (restarting && !windows.has(path))) return;
  const log = openLog(app.getPath("logs"), slugOf(path));
  const warnings = [...archWarning(), syncedFolderWarning(path, homedir()) ?? []].flat();
  for (const warning of warnings) log.write("shell", `warning: ${warning}`);
  if (moved) log.write("shell", `the remembered port is taken: the app moves to ${port}, and asks who you are again`);
  /** Whether the start window shows this start: not a Restart's, which keeps the company's window. */
  const shown = () => shownLog === log;
  const show = (next: Partial<StartState>) => {
    shownLog = log;
    setState({ company: { path, name: company.name }, ...next });
    showStart();
  };
  if (!windows.has(path)) show({ phase: "starting", progress: [], warnings, message: undefined });

  const session = how({
    repo: path,
    port,
    ...runtimeOf({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
    bin: join(app.getPath("userData"), "bin"),
    env: process.env,
    onLine(stream, line) {
      log.write(stream, line);
      if (shown()) setState({});
    },
    onProgress(step) {
      log.write("shell", step);
      if (shown()) setState({ progress: [...state.progress, step] });
    },
  });
  const entry: Running = { session, log, stopping: false };
  running.set(path, entry);
  session.ready.then(
    (url) => {
      if (entry.stopping) return;
      beginnings.delete(path);
      log.write("shell", `ready at ${url}`);
      showCompany(path, company.name, url);
      if (shown()) setState({ phase: "idle" });
      if (startWindow && shown()) startWindow.hide();
    },
    () => {},
  );
  void session.ended.then((exit) => {
    if (running.get(path) === entry) running.delete(path);
    if (entry.stopping) {
      log.write("shell", "stopped");
      log.close();
      if (shown()) {
        shownLog = undefined;
        setState({ company: undefined, phase: "idle", progress: [], log: [], warnings: [] });
      }
      return;
    }
    const said = exit.error ?? "the log below says what";
    const why =
      exit.code === USAGE_EXIT
        ? `The company's configuration has a problem (${said}). Fix it, then start again.`
        : (exit.error ?? `The company stopped (${exit.signal ?? `exit code ${exit.code}`}).`);
    log.write("shell", why);
    log.close();
    windows.get(path)?.window.close();
    show({ phase: "failed", message: hidePasswords(why), progress: [], warnings });
  });
}

/** Stops the company's session, if it runs; resolves once everything it started has exited. */
async function stop(path: string) {
  const entry = running.get(path);
  if (!entry) return;
  entry.stopping = true;
  await entry.session.stop();
}

/** Stops the company and starts it again, its window kept: it loads the app again once it answers. */
async function restart(path: string) {
  await stop(path);
  await begin(path);
}

/** The company's window: the app, in the company's own storage, with no preload and no Node. */
function showCompany(path: string, name: string, url: string) {
  const existing = windows.get(path);
  if (existing) {
    existing.url = url;
    void existing.window.loadURL(url);
    return existing.window.focus();
  }
  const webPreferences = {
    partition: partitionOf(path),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
  const window = new BrowserWindow({ width: 1280, height: 840, title: name, webPreferences });
  windows.set(path, { window, url });
  guard(window.webContents, path, webPreferences);
  window.on("closed", () => {
    windows.delete(path);
    void stop(path);
  });
  void window.loadURL(url);
}

/**
 * Applies the link rule (`linkTarget`) to a company's page: navigation and `window.open` stay in
 * the shell for the app, its sites and GitHub (a new window in the same storage), the default
 * browser gets other web links, and anything else is refused.
 */
function guard(contents: WebContents, path: string, webPreferences: Electron.WebPreferences) {
  const target = (url: string) => linkTarget(url, windows.get(path)?.url ?? "");
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
  contents.setWindowOpenHandler(({ url }) => {
    if (target(url) === "window") {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences } };
    }
    outside(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    guard(child.webContents, path, webPreferences);
    // A window the app opened goes with the window that opened it.
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

const say = (message: string, detail?: string) => void dialog.showMessageBox({ type: "info", message, detail });

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Where the folder dialogs of New Company and Clone Company start. */
const parentFolder = () => defaultParent(readCompanies(companiesFile()), homedir());

/** Answers the form the start window shows (`ask`), once: with what was typed, or undefined (Cancel, closed). */
let answer: ((value: unknown) => void) | undefined;

/** Shows `form` in the start window; resolves with the answer, or undefined when the person cancels. */
function ask(form: NonNullable<StartState["ask"]>): Promise<unknown> {
  answer?.(undefined);
  return new Promise((resolve) => {
    answer = (value) => {
      answer = undefined;
      setState({ ask: undefined });
      resolve(value);
    };
    setState({ ask: form });
    showStart();
  });
}

const isIdentity = (value: unknown): value is Identity =>
  typeof (value as Identity)?.name === "string" && typeof (value as Identity)?.email === "string";

/**
 * Whether git has someone to commit as from `cwd`: `user.name` and `user.email`, asked for once in
 * the start window when either is missing and set globally (the form says so), as a new company's
 * first commit, and the app's later ones, need them.
 */
async function identityReady(cwd: string): Promise<boolean> {
  const env = gitEnv(process.env);
  let typed = await identityOf(cwd, env);
  if (typed.name && typed.email) return true;
  let problem: string | undefined;
  for (;;) {
    const value = await ask({ kind: "identity", ...typed, problem });
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
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Choose or make an empty folder for the new company",
    buttonLabel: "Start Company Here",
    defaultPath: parentFolder(),
    properties: ["openDirectory", "createDirectory"],
  });
  const dir = filePaths[0];
  if (canceled || !dir) return;
  const problem = isCompanyFolder(dir) ? `${dir} holds a company already: open it instead.` : newCompanyProblem(dir);
  if (problem) return say("Choose an empty folder", problem);
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
  await begin(realpathSync(dir), createSession);
}

/**
 * File → Clone Company…: the repository's address (the start window asks), the folder to clone
 * into (a dialog), then the clone, as the company's session (`cloneSession`), so the start window
 * shows it and a failure, and Start again clones again.
 */
async function cloneCompanyFlow(): Promise<void> {
  let url = "";
  let problem: string | undefined;
  do {
    const value = await ask({ kind: "clone", url, problem });
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
  const parent = realpathSync(filePaths[0]);
  const target = cloneTarget(url, parent);
  if ("problem" in target) return say("Sanoma cannot clone it there", target.problem);
  if (!(await identityReady(parent))) return;
  await begin(target.dir, cloneSession(url));
}

/** The companies Get Updates runs for now: a second click meanwhile does nothing. */
const updating = new Set<string>();

/**
 * Company → Get Updates: GitHub's `main`, fast-forward only, when this computer has nothing of
 * its own (`prepareUpdate` refuses in one line otherwise); then the company starts again, which
 * installs its packages (`startSession`), its window kept.
 */
async function getUpdates(path: string): Promise<void> {
  if (updating.has(path)) return;
  updating.add(path);
  try {
    if (!(await gitReady())) return;
    const env = gitEnv(process.env);
    const plan = await prepareUpdate(path, env);
    if ("refused" in plan) return say(plan.refused);
    if (!plan.behind) return say("This company is up to date with GitHub");
    await stop(path);
    const failed = await fastForward(path, env).then(
      () => undefined,
      (err: unknown) => gitFailure(messageOf(err), "The update did not apply"),
    );
    await begin(path);
    say(
      failed ??
        `Got ${plan.behind} new ${plan.behind === 1 ? "change" : "changes"} from GitHub; the company is starting again`,
    );
  } catch (err) {
    say("Sanoma could not get updates", messageOf(err));
  } finally {
    updating.delete(path);
  }
}

/** A menu action on the company of the focused window, when it is a company's. */
const forFocused = (act: (path: string) => unknown) => () => {
  const focused = BrowserWindow.getFocusedWindow();
  const path = [...windows].find(([, shown]) => shown.window === focused)?.[0];
  if (path) void act(path);
};

/** A newer Sanoma the update check found: the Help menu links to its page. */
let newer: Newer | undefined;
/** Its notification, held so that a click on it still reaches the shell once it is shown. */
let notification: Notification | undefined;

/**
 * The update check (`update-check.ts`), when a day has passed since the last, or when asked from
 * the Help menu, which then says what it found. A newer release gets one notification per version.
 */
async function checkForUpdate(asked: boolean) {
  const current = app.getVersion();
  const saved = readSettings(settingsFile());
  if (!asked && !checkDue(saved, Date.now())) return;
  let found: Newer | undefined;
  try {
    found = newerRelease(current, await fetchReleases(current));
    writeSettings(settingsFile(), { updateCheckedAt: new Date().toISOString(), newer: found });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (asked)
      void dialog.showMessageBox({ type: "warning", message: "Sanoma could not check for a newer version", detail });
    else console.error(`update check: ${detail}`);
    return;
  }
  newer = found;
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
  } else if (found && found.version !== saved.newer?.version && Notification.isSupported()) {
    notification = new Notification({
      title: `Sanoma ${found.version} is available`,
      body: "Click to open its release page.",
    });
    notification.on("click", () => void shell.openExternal(found.url));
    notification.show();
  }
}

/** The Help menu's update items: the newer release, when one is known, and the check. */
function updateItems(): MenuItemConstructorOptions[] {
  const known = newer;
  return [
    ...(known ? [{ label: `Download Sanoma ${known.version}…`, click: () => void shell.openExternal(known.url) }] : []),
    { label: "Check for a Newer Sanoma", click: () => void checkForUpdate(true) },
    { type: "separator" },
  ];
}

function buildMenu() {
  const recent = readCompanies(companiesFile());
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
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
        { label: "Show Start Window", click: showStart },
        { role: "close", label: "Close Window" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Company",
      submenu: [
        { label: "Restart", accelerator: "CmdOrCtrl+Shift+R", click: forFocused(restart) },
        { label: "Get Updates", click: forFocused(getUpdates) },
        { label: "Show in Finder", click: forFocused((path) => shell.openPath(path)) },
        { label: "Show Log", click: forFocused((path) => shell.openPath(logFile(path))) },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
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

/** The arguments after the executable (and, run from a checkout, the app's path). */
const argsOf = (argv: readonly string[]) => argv.slice(process.defaultApp ? 2 : 1);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    const folder = folderArgument(argsOf(argv), cwd);
    if (folder) void openCompany(folder);
    else if (windows.size) [...windows.values()].at(-1)!.window.focus();
    else showStart();
  });
  // A folder dropped on the Dock icon, or opened with the app.
  const dropped: string[] = [];
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (app.isReady()) void openCompany(path);
    else dropped.push(path);
  });

  ipcMain.handle("start:state", () => state);
  ipcMain.handle("start:choose", () => chooseFolder());
  ipcMain.handle("start:open", (_event, path: unknown) => typeof path === "string" && openCompany(path));
  ipcMain.handle("start:again", () => state.company && begin(state.company.path));
  ipcMain.handle("start:create", () => newCompany());
  ipcMain.handle("start:clone", () => cloneCompanyFlow());
  ipcMain.handle("start:answer", (_event, value: unknown) => answer?.(value));
  ipcMain.handle("start:cancel", () => answer?.(undefined));

  // Quit waits for each company: those still opening, then every session, stopped.
  let stopped = false;
  app.on("before-quit", (event) => {
    if (stopped || (!running.size && !opening.size)) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.all(opening.values())
      .then(() => Promise.all([...running.keys()].map(stop)))
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });
  // ctrl-c in the terminal that started the shell, or a kill: quit as the menu does, stopping each company.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().some((window) => window.isVisible())) showStart();
  });

  void app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "Sanoma", applicationVersion: app.getVersion() });
    // What the last check found, until the next one: unless this is that version or later.
    const saved = readSettings(settingsFile()).newer;
    if (saved && isLater(saved.version, app.getVersion())) newer = saved;
    buildMenu();
    void checkForUpdate(false);
    // Hourly, so a shell left open checks once a day too.
    setInterval(() => void checkForUpdate(false), 60 * 60 * 1000);
    const folder = folderArgument(argsOf(process.argv), process.cwd()) ?? dropped.at(-1);
    if (folder) void openCompany(folder);
    else showStart();
  });
}
