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
import { USAGE_EXIT } from "./launcher.ts";
import { linkTarget } from "./links.ts";
import { type CompanyLog, openLog } from "./logs.ts";
import { folderArgument, isCompanyFolder, syncedFolderWarning } from "./places.ts";
import { runtimeOf } from "./runtime.ts";
import { type Session, startSession } from "./session.ts";

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
}

interface Running {
  session: Session;
  log: CompanyLog;
  /** Set when the shell itself stops it: closing the window, Restart, Quit. */
  stopping: boolean;
}

/** One session per company folder (by real path), and its window once the app answers. */
const running = new Map<string, Running>();
const windows = new Map<string, BrowserWindow>();
/** Where each company's app answers now: its window's link rule reads it, as Restart may move the port. */
const appUrls = new Map<string, string>();
/** Folders being opened: between the click and the session, a second click must not start another, and Quit waits. */
const opening = new Map<string, Promise<void>>();
/** Port choices, one at a time: two companies opened at once must not both take the same free port. */
let claiming: Promise<unknown> = Promise.resolve();
let quitting = false;

let startWindow: BrowserWindow | undefined;
let state: StartState = { recent: [], phase: "idle", progress: [], log: [], warnings: [] };
/** The log of the company the start window shows, its tail read when the state is sent. */
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
    startWindow?.webContents.send("start:state", state);
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
  const window = windows.get(path);
  if (window) return window.focus();
  if (running.has(path) || opening.has(path)) return showStart();
  await begin(path);
}

/** Starts the company unless it runs or is starting; a failure to start says why in a dialog. */
async function begin(path: string) {
  if (running.has(path) || opening.has(path) || quitting) return;
  const started = start(path).catch((err: unknown) =>
    dialog.showErrorBox("The company could not start", err instanceof Error ? err.message : String(err)),
  );
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
  return { company, moved };
}

async function start(path: string) {
  const claimed = claiming.then(() => claimPort(path));
  claiming = claimed.catch(() => {});
  const { company, moved } = await claimed;
  const { port } = company;
  if (quitting) return;
  buildMenu();
  const log = openLog(app.getPath("logs"), slugOf(path));
  const warnings = [...archWarning(), syncedFolderWarning(path, homedir()) ?? []].flat();
  for (const warning of warnings) log.write("shell", `warning: ${warning}`);
  if (moved) log.write("shell", `the remembered port is taken: the app moves to ${port}, and asks who you are again`);
  const shown = () => state.company?.path === path;
  if (!windows.has(path)) shownLog = log;
  setState({ company: { path, name: company.name }, phase: "starting", progress: [], warnings, message: undefined });
  if (!windows.has(path)) showStart();

  const session = startSession({
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
    ({ url }) => {
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
    if (entry.stopping) return log.write("shell", "stopped");
    const why =
      exit.error ??
      (exit.code === USAGE_EXIT
        ? "The company's configuration has a problem: the log below says what. Fix it, then start again."
        : `The company stopped (${exit.signal ?? `exit code ${exit.code}`}).`);
    log.write("shell", why);
    windows.get(path)?.close();
    shownLog = log;
    setState({ company: { path, name: company.name }, phase: "failed", message: why });
    showStart();
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
  appUrls.set(path, url);
  const existing = windows.get(path);
  if (existing) {
    void existing.loadURL(url);
    return existing.focus();
  }
  const webPreferences = {
    partition: partitionOf(path),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
  const window = new BrowserWindow({ width: 1280, height: 840, title: name, webPreferences });
  windows.set(path, window);
  guard(window.webContents, path, webPreferences);
  window.on("closed", () => {
    windows.delete(path);
    appUrls.delete(path);
    void stop(path);
    buildMenu();
  });
  void window.loadURL(url);
  buildMenu();
}

/**
 * Applies the link rule (`linkTarget`) to a company's page: navigation and `window.open` stay in
 * the shell for the app, its sites and GitHub (a new window in the same storage), the default
 * browser gets other web links, and anything else is refused.
 */
function guard(contents: WebContents, path: string, webPreferences: Electron.WebPreferences) {
  const target = (url: string) => linkTarget(url, appUrls.get(path) ?? "");
  const outside = (url: string) => {
    if (target(url) === "browser") void shell.openExternal(url);
  };
  contents.on("will-navigate", (event) => {
    if (target(event.url) === "window") return;
    event.preventDefault();
    outside(event.url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (target(url) === "window") {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences } };
    }
    outside(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => guard(child.webContents, path, webPreferences));
}

async function chooseFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Open a company",
    buttonLabel: "Open",
    properties: ["openDirectory"],
  });
  if (!canceled && filePaths[0]) await openCompany(filePaths[0]);
}

const nextLane = (what: string) => () =>
  void dialog.showMessageBox({
    message: `${what} comes in the next version of Sanoma`,
    detail: "For now, open a folder that holds a company.",
  });

/** The company of the focused window, if it is one. */
const focusedCompany = () => {
  const focused = BrowserWindow.getFocusedWindow();
  return [...windows].find(([, window]) => window === focused)?.[0];
};

const forFocused = (act: (path: string) => unknown) => () => {
  const path = focusedCompany();
  if (path) void act(path);
};

function buildMenu() {
  const recent = readCompanies(companiesFile());
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "New Company…", click: nextLane("New company") },
        { label: "Open Company…", accelerator: "CmdOrCtrl+O", click: () => void chooseFolder() },
        { label: "Clone Company…", click: nextLane("Cloning a company") },
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
    else if (windows.size) [...windows.values()].at(-1)!.focus();
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
    if (!BrowserWindow.getAllWindows().length) showStart();
  });

  void app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "Sanoma", applicationVersion: app.getVersion() });
    buildMenu();
    const folder = folderArgument(argsOf(process.argv), process.cwd()) ?? dropped.at(-1);
    if (folder) void openCompany(folder);
    else showStart();
  });
}
