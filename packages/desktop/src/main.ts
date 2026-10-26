// The shell's main process: wiring only. What it runs and how is in the modules it imports, which
// never import electron and are tested on their own.
import { mkdirSync, realpathSync } from "node:fs";
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
  cloneCompany,
  cloneTarget,
  createSession,
  defaultParent,
  newCompanyProblem,
} from "./create.ts";
import {
  gitEnv,
  type Identity,
  identityOf,
  identityProblem,
  installCommandLineTools,
  needsCommandLineTools,
  setIdentity,
} from "./git.ts";
import { USAGE_EXIT } from "./launcher.ts";
import { linkTarget } from "./links.ts";
import { type CompanyLog, openLog } from "./logs.ts";
import { folderArgument, isCompanyFolder, syncedFolderWarning } from "./places.ts";
import { runtimeOf } from "./runtime.ts";
import { type Session, startSession } from "./session.ts";
import { fastForward, prepareUpdate } from "./update-company.ts";

const here = dirname(fileURLToPath(import.meta.url));
const companiesFile = () => join(app.getPath("userData"), "companies.json");
const logFile = (path: string) => join(app.getPath("logs"), `${slugOf(path)}.log`);

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
  startWindow.on("closed", () => (startWindow = undefined));
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

/** Starts the company unless it runs or is starting; a failure to start says why in a dialog. */
async function begin(path: string) {
  if (running.has(path) || opening.has(path) || quitting) return;
  const started = start(path).catch((err: unknown) => {
    // Before its session (no Node staged, an unreadable folder): the start window says why.
    shownLog = undefined;
    const message = `The company could not start: ${err instanceof Error ? err.message : String(err)}`;
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

async function start(path: string) {
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

  // An empty folder is a new company (`newCompany`): the launcher's init starts it, then serves it.
  const session = (isCompanyFolder(path) ? startSession : createSession)({
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
    show({ phase: "failed", message: why, progress: [], warnings });
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

/** Where the folder dialogs of New Company and Clone Company start. */
const parentFolder = () => defaultParent(readCompanies(companiesFile()), homedir());

/** Answers the identity form the start window shows (`askIdentity`), once. */
let answerIdentity: ((identity: Identity | undefined) => void) | undefined;

/** Asks the start window who commits; undefined when the person cancels. */
function askIdentity(known: Identity): Promise<Identity | undefined> {
  answerIdentity?.(undefined);
  return new Promise((resolve) => {
    answerIdentity = (identity) => {
      answerIdentity = undefined;
      setState({ ask: undefined });
      resolve(identity);
    };
    setState({ ask: { kind: "identity", ...known } });
    showStart();
  });
}

/** The identity form's answer: checked, then set globally (the form says so), or the form again with why not. */
async function answered(answer: Identity | undefined) {
  if (!answerIdentity || state.ask?.kind !== "identity") return;
  if (!answer) return answerIdentity(undefined);
  const problem = identityProblem(answer);
  if (problem) return setState({ ask: { ...state.ask, ...answer, problem } });
  try {
    await setIdentity(answer, gitEnv(process.env));
    answerIdentity(answer);
  } catch (err) {
    setState({ ask: { ...state.ask, ...answer, problem: `git could not save it: ${(err as Error).message}` } });
  }
}

/**
 * Whether git can run: on macOS, Apple's command line tools must be there (a dialog offers their
 * installer and to check again); with `identity`, git's user name and email too (asked for once,
 * in the start window, when either is missing), as a new company's first commit needs them.
 */
async function gitReady(cwd: string, { identity }: { identity: boolean }): Promise<boolean> {
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
  if (!identity) return true;
  const known = await identityOf(cwd, gitEnv(process.env));
  return Boolean((known.name && known.email) || (await askIdentity(known)));
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
  mkdirSync(dir, { recursive: true });
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
  if (!(await gitReady(dir, { identity: true }))) return;
  await begin(realpathSync(dir));
}

/** File → Clone Company…: the start window asks for the repository's address (`clone` takes it). */
function askClone() {
  answerIdentity?.(undefined);
  setState({ ask: { kind: "clone" } });
  showStart();
}

/** Clones `url` into a folder the person chooses, with the system git, then opens it. */
async function clone(url: string): Promise<void> {
  url = url.trim();
  const problem = addressProblem(url);
  if (problem) return setState({ ask: { kind: "clone", url, problem } });
  setState({ ask: undefined });
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
  if (!(await gitReady(parent, { identity: true }))) return;
  const { dir } = target;
  if (opening.has(dir) || quitting) return;

  const log = openLog(app.getPath("logs"), slugOf(dir));
  shownLog = log;
  const warnings = [syncedFolderWarning(dir, homedir()) ?? []].flat();
  setState({
    company: { path: dir, name: companyName(dir) },
    phase: "starting",
    message: `Cloning ${url} into ${dir}`,
    progress: ["Cloning"],
    warnings,
  });
  showStart();
  log.write("shell", `git clone ${url} ${dir}`);
  const cloning = cloneCompany(url, dir, {
    env: gitEnv(process.env),
    onLine(stream, line) {
      log.write(stream, line);
      setState({});
    },
  });
  // Quit waits for it, and a second Clone of the same folder does nothing meanwhile.
  opening.set(
    dir,
    cloning.done.then(() => {}),
  );
  const failed = await cloning.done;
  opening.delete(dir);
  log.write("shell", failed ?? "cloned");
  log.close();
  if (shownLog === log) {
    shownLog = undefined;
    setState({ company: undefined, phase: "idle", progress: [], log: [], message: undefined, warnings: [] });
  }
  if (failed) return say("The company could not be cloned", failed);
  await openCompany(dir);
}

/** The companies Get Updates runs for now: a second click waits for nothing, it does nothing. */
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
    if (!(await gitReady(path, { identity: false }))) return;
    const env = gitEnv(process.env);
    const plan = await prepareUpdate(path, env);
    if ("refused" in plan) return say(plan.refused);
    if (!plan.behind) return say("This company is up to date with GitHub");
    await stop(path);
    const failed = await fastForward(path, env).then(
      () => undefined,
      (err: unknown) => (err as Error).message,
    );
    await begin(path);
    say(
      failed
        ? `The update did not apply: ${failed}`
        : `Got ${plan.behind} new ${plan.behind === 1 ? "change" : "changes"} from GitHub; the company is starting again`,
    );
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

function buildMenu() {
  const recent = readCompanies(companiesFile());
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "New Company…", accelerator: "CmdOrCtrl+N", click: () => void newCompany() },
        { label: "Open Company…", accelerator: "CmdOrCtrl+O", click: () => void chooseFolder() },
        { label: "Clone Company…", click: askClone },
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
  ipcMain.handle("start:ask-clone", () => askClone());
  ipcMain.handle("start:clone", (_event, url: unknown) => typeof url === "string" && clone(url));
  ipcMain.handle("start:identity", (_event, answer: unknown) => {
    const { name, email } = (answer ?? {}) as Partial<Identity>;
    return answered(typeof name === "string" && typeof email === "string" ? { name, email } : undefined);
  });
  ipcMain.handle("start:cancel", () => (answerIdentity ? answerIdentity(undefined) : setState({ ask: undefined })));

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
    buildMenu();
    const folder = folderArgument(argsOf(process.argv), process.cwd()) ?? dropped.at(-1);
    if (folder) void openCompany(folder);
    else showStart();
  });
}
