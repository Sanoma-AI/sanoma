// The shell's main process: wiring only. What it runs and how is in the modules it imports, which
// never import electron and are tested on their own.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  screen,
  shell,
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
import { linkTarget } from "./links.ts";
import { type CompanyLog, hidePasswords, openLog } from "./logs.ts";
import { folderArgument, isCompanyFolder, syncedFolderWarning } from "./places.ts";
import { runtimeOf } from "./runtime.ts";
import { type Session, type SessionOptions, startSession } from "./session.ts";
import { type Newer, readSettings, runCheck, savedNewer } from "./update-check.ts";
import { fastForward, prepareUpdate } from "./update-company.ts";
import { windowBounds } from "./window-state.ts";

const companiesFile = () => join(app.getPath("userData"), "companies.json");
const logFile = (path: string) => join(app.getPath("logs"), `${slugOf(path)}.log`);
const settingsFile = () => join(app.getPath("userData"), "settings.json");
/** The shell's own pages': the start window's and each company window's progress page. */
const shellPreferences = { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true };
/** Loads one of start/'s pages: from Vite's dev server under `pnpm start`, else from the build. */
const loadShellPage = (contents: Electron.WebContents, page: "index.html" | "company.html") =>
  START_VITE_DEV_SERVER_URL
    ? contents.loadURL(`${START_VITE_DEV_SERVER_URL}/${page}`)
    : contents.loadFile(join(__dirname, "..", "renderer", START_VITE_NAME, page));

/** Changes the entry companies.json has for `path` (`updated`), read and written at once. */
const patchCompany = (path: string, patch: Partial<Company>) =>
  writeCompanies(companiesFile(), updated(readCompanies(companiesFile()), path, patch));

/** What the start window shows: the recent companies, marked when they run, and a form. */
export interface StartState {
  recent: RecentCompany[];
  warnings: string[];
  /** One line the start window shows: why what was asked did not happen (`problem`), or what did. */
  notice?: { text: string; problem: boolean };
  /** A form the start window shows: a repository's address to clone, or who commits. */
  ask?: { kind: "clone"; url?: string; problem?: string } | ({ kind: "identity"; problem?: string } & Identity);
}

/** What a company window's own page shows (`start/company.html`): its start, or why it stopped. */
export interface CompanyState {
  path: string;
  name: string;
  /** `running`: the app answers, and the window shows it once it has loaded. */
  phase: "starting" | "running" | "failed" | "stopped";
  progress: string[];
  log: string[];
  message?: string;
  warnings: string[];
  /** Whether the next launch opens it again (`Company.open`): a failed one offers not to. */
  reopens: boolean;
}

interface Running {
  session: Session;
  log: CompanyLog;
  /** Set when the shell itself stops it: Stop, Restart, Get Updates, Quit. */
  stopping: boolean;
}

/**
 * A company's window, from the click to the app and for as long as it runs: one `BaseWindow`
 * holding the shell's page (progress, the log, why it stopped) and the app's view over it, in the
 * company's own storage (`partitionOf`: the `sanoma_actor` cookie ignores ports, so two companies
 * must not share one). Which one shows is swapped in place; closing it hides it while the company
 * runs.
 */
interface CompanyWindow {
  window: BaseWindow;
  shellView: WebContentsView;
  appView: WebContentsView;
  /** Where its app answers now: the link rule reads it, as Restart may move the port. */
  url: string;
  state: CompanyState;
  /** The start whose tail the shell's page shows. */
  log?: CompanyLog;
  sendTimer?: NodeJS.Timeout;
  saveTimer?: NodeJS.Timeout;
}

/** One session per company folder (by real path). */
const running = new Map<string, Running>();
/** Each company's window, by real path: there from its first start until it is closed while it does not run. */
const windows = new Map<string, CompanyWindow>();
/** Folders being opened: between the click and the session, a second click must not start another, and Quit waits. */
const opening = new Map<string, Promise<void>>();
/** Port choices, one at a time: two companies opened at once must not both take the same free port. */
let claiming: Promise<unknown> = Promise.resolve();
/** Set once Quit begins: nothing starts, and windows close without changing what the next launch opens. */
let quitting = false;

let startWindow: BrowserWindow | undefined;
let ask: StartState["ask"];
let notice: StartState["notice"];

const archWarning = () =>
  app.runningUnderARM64Translation
    ? [
        "This is the Intel build of Sanoma on an Apple silicon Mac: download the Apple silicon (arm64) build, which runs faster.",
      ]
    : [];

/** Whether the company runs or is starting now. */
const isLive = (path: string) => running.has(path) || opening.has(path);
/** The companies running or starting now, by real path. */
const live = () => new Set([...running.keys(), ...opening.keys()]);

let startTimer: NodeJS.Timeout | undefined;
/** Sends the start window what it shows (soon, once for a burst of changes), while it is visible. */
function sendStart() {
  startTimer ??= setTimeout(() => {
    startTimer = undefined;
    // A hidden start window gets the state when shown again (`showStart`).
    if (startWindow?.isVisible()) startWindow.webContents.send("start:state", startState());
  }, 100);
}

const startState = (): StartState => ({
  recent: recentOf(readCompanies(companiesFile()), live()),
  warnings: archWarning(),
  notice,
  ask,
});

/** What changes when a company starts or stops: the start window's Recent marks and the Dock menu. */
function runningChanged() {
  sendStart();
  const names = [...live()].map((path) => ({ path, name: windows.get(path)?.state.name ?? companyName(path) }));
  app.dock?.setMenu(
    Menu.buildFromTemplate(names.map(({ path, name }) => ({ label: name, click: () => showWindow(path) }))),
  );
}

function showStart() {
  sendStart();
  if (startWindow) {
    startWindow.show();
    startWindow.focus();
    return;
  }
  startWindow = new BrowserWindow({
    width: 640,
    height: 720,
    title: "Sanoma",
    webPreferences: shellPreferences,
  });
  shellPage(startWindow.webContents);
  startWindow.on("closed", () => {
    startWindow = undefined;
    // Its form goes with it: New Company or Clone, waiting on it, stops.
    answer?.(undefined);
  });
  void loadShellPage(startWindow.webContents, "index.html");
}

/** One of the shell's own pages: it never navigates and opens nothing. */
function shellPage(contents: WebContents) {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Shows one of the window's two views, the shell's page or the app, in place of the other. */
function reveal(shown: CompanyWindow, view: WebContentsView) {
  const other = view === shown.appView ? shown.shellView : shown.appView;
  other.setVisible(false);
  view.setVisible(true);
  // The View menu acts on the focused page: the one shown (in the focused window only, never raising another).
  if (shown.window.isFocused() && !view.webContents.isDestroyed()) view.webContents.focus();
}

/** Changes what the company's page shows, and sends it soon; any phase but `running` shows that page. */
function setCompanyState(shown: CompanyWindow, next: Partial<CompanyState>) {
  shown.state = { ...shown.state, ...next };
  if (next.phase && next.phase !== "running") reveal(shown, shown.shellView);
  shown.sendTimer ??= setTimeout(() => {
    shown.sendTimer = undefined;
    if (shown.log) shown.state = { ...shown.state, log: shown.log.tail() };
    const contents = shown.shellView.webContents;
    if (!contents.isDestroyed()) contents.send("start:state", shown.state);
  }, 100);
}

/** Loads the app at `url` into the company's window, and shows it there once it has loaded. */
function showApp(shown: CompanyWindow, url: string) {
  shown.url = url;
  setCompanyState(shown, { phase: "running" });
  void shown.appView.webContents
    .loadURL(url)
    .catch(() => {})
    .finally(() => {
      // It may have stopped meanwhile, or started again.
      if (shown.state.phase === "running" && shown.url === url && !shown.window.isDestroyed()) {
        reveal(shown, shown.appView);
      }
    });
}

/** The company's window, shown and focused: a hidden one comes back as it was, on its app. */
function showWindow(path: string) {
  const shown = windows.get(path);
  if (!shown) return;
  shown.window.show();
  shown.window.focus();
}

/** Saves the window's bounds in companies.json, for its next opening (`windowBounds`). */
function saveBounds(path: string, shown: CompanyWindow) {
  clearTimeout(shown.saveTimer);
  shown.saveTimer = undefined;
  if (!shown.window.isDestroyed()) patchCompany(path, { bounds: shown.window.getNormalBounds() });
}

/** The company's window, made the first time it starts: at its saved bounds, showing its page. */
function windowFor(path: string): CompanyWindow {
  const existing = windows.get(path);
  if (existing) return existing;
  const name = companyName(path);
  const saved = readCompanies(companiesFile()).find((c) => c.path === path)?.bounds;
  const window = new BaseWindow({
    ...windowBounds(
      saved,
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    title: name,
  });
  const shellView = new WebContentsView({ webPreferences: shellPreferences });
  shellPage(shellView.webContents);
  const webPreferences = {
    partition: partitionOf(path),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
  const appView = new WebContentsView({ webPreferences });
  guard(appView.webContents, path, webPreferences);
  appView.setVisible(false);
  // A page until the app's: a view that never loaded one is a page Playwright's smoke test waits on.
  void appView.webContents.loadURL("about:blank");
  window.contentView.addChildView(appView);
  window.contentView.addChildView(shellView);
  const fit = () => {
    const { width, height } = window.getContentBounds();
    for (const view of [shellView, appView]) view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  const shown: CompanyWindow = {
    window,
    shellView,
    appView,
    url: "",
    state: { path, name, phase: "starting", progress: [], log: [], warnings: [], reopens: true },
  };
  windows.set(path, shown);
  const saveSoon = () => {
    clearTimeout(shown.saveTimer);
    shown.saveTimer = setTimeout(() => saveBounds(path, shown), 500);
  };
  window.on("resize", () => {
    fit();
    saveSoon();
  });
  window.on("move", saveSoon);
  window.on("close", (event) => {
    saveBounds(path, shown);
    // While it runs (or starts), closing hides it: the company goes on, its workflows with it.
    if (!quitting && isLive(path)) {
      event.preventDefault();
      // A full-screen window hidden as it is would leave its Space behind, empty.
      if (!window.isFullScreen()) return window.hide();
      window.once("leave-full-screen", () => window.hide());
      window.setFullScreen(false);
    }
  });
  window.on("closed", () => {
    windows.delete(path);
    clearTimeout(shown.sendTimer);
    shellView.webContents.close();
    appView.webContents.close();
    // Closed while it does not run: the next launch does not open it. Quit keeps what is open.
    if (!quitting) patchCompany(path, { open: false });
  });
  void loadShellPage(shellView.webContents, "company.html");
  return shown;
}

/**
 * Says `text` in the start window, shown, in place of what it said last: in the window, never a
 * native dialog, which would hold up the shell (and its smoke test) until someone clicks it.
 */
function tell(text: string, problem = true) {
  notice = { text, problem };
  showStart();
}

/** Opens the company in `dir`: shows its window when it runs already, else starts it in its window. */
async function openCompany(dir: string) {
  notice = undefined;
  if (!isCompanyFolder(dir)) {
    return tell(`${dir} holds no company (no sanoma.config.ts): open the folder a company was started in.`);
  }
  const path = realpathSync(dir);
  if (isLive(path)) return showWindow(path);
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
 * was ready, else `startSession`), in its window, which shows the start and then the app; a
 * failure to start says why there.
 */
async function begin(path: string, how?: Begin) {
  if (isLive(path) || quitting) return;
  if (how) beginnings.set(path, how);
  const shown = windowFor(path);
  setCompanyState(shown, { phase: "starting", progress: [], log: [], message: undefined, reopens: true });
  shown.log = undefined;
  showWindow(path);
  const started = start(path, shown, beginnings.get(path) ?? startSession).catch((err: unknown) => {
    // Before its session (no Node staged, an unreadable folder): its window says why.
    const message = hidePasswords(`The company could not start: ${messageOf(err)}`);
    setCompanyState(shown, { phase: "failed", message, progress: [], log: [], reopens: reopensAfterEnd(path) });
  });
  opening.set(path, started);
  runningChanged();
  await started;
  opening.delete(path);
  runningChanged();
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
  // Read again: bounds may have been saved meanwhile.
  const companies = readCompanies(companiesFile());
  const before = companies.find((c) => c.path === path);
  const company: Company = {
    ...before,
    path,
    name: companyName(path),
    port,
    lastOpened: new Date().toISOString(),
    open: true,
  };
  writeCompanies(companiesFile(), remember(companies, company));
  buildMenu();
  return { company, moved };
}

async function start(path: string, shown: CompanyWindow, how: Begin) {
  const claimed = claiming.then(() => claimPort(path));
  claiming = claimed.catch(() => {});
  const { company, moved } = await claimed;
  const { port } = company;
  if (quitting) return;
  const log = openLog(app.getPath("logs"), slugOf(path));
  const warnings = [...archWarning(), syncedFolderWarning(path, homedir()) ?? []].flat();
  for (const warning of warnings) log.write("shell", `warning: ${warning}`);
  if (moved) log.write("shell", `the remembered port is taken: the app moves to ${port}, and asks who you are again`);
  shown.log = log;
  setCompanyState(shown, { name: company.name, warnings });
  shown.window.setTitle(company.name);
  /** Whether the window shows this start: a later one replaces it. */
  const current = () => shown.log === log;

  const session = how({
    repo: path,
    port,
    ...runtimeOf({ packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }),
    bin: join(app.getPath("userData"), "bin"),
    env: process.env,
    onLine(stream, line) {
      log.write(stream, line);
      // The page gets the log's tail while it shows; once it shows again, the next state carries it.
      if (current() && shown.state.phase !== "running") setCompanyState(shown, {});
    },
    onProgress(step) {
      log.write("shell", step);
      if (current()) setCompanyState(shown, { progress: [...shown.state.progress, step] });
    },
  });
  const entry: Running = { session, log, stopping: false };
  running.set(path, entry);
  session.ready.then(
    (url) => {
      if (entry.stopping) return;
      beginnings.delete(path);
      log.write("shell", `ready at ${url}`);
      if (current()) showApp(shown, url);
    },
    () => {},
  );
  void session.ended.then((exit) => {
    if (running.get(path) === entry) running.delete(path);
    runningChanged();
    if (entry.stopping) {
      log.write("shell", "stopped");
      log.close();
      // A clone or a new company stopped before it was there leaves Recent too.
      const reopens = reopensAfterEnd(path);
      if (current()) setCompanyState(shown, { phase: "stopped", progress: [], reopens });
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
    setCompanyState(shown, { phase: "failed", message: hidePasswords(why), progress: [], reopens });
    // A company that stops on its own while its window is closed says so.
    if (!shown.window.isDestroyed()) showWindow(path);
  });
}

/** Stops the company's session, if it runs; resolves once everything it started has exited. */
async function stop(path: string) {
  const entry = running.get(path);
  if (!entry) return;
  entry.stopping = true;
  await entry.session.stop();
}

/** The next launch does not open the company (`Company.open`), and its window's page says so. */
function dontReopen(path: string) {
  patchCompany(path, { open: false });
  const shown = windows.get(path);
  if (shown) setCompanyState(shown, { reopens: false });
}

/** Company → Stop: the company stops, its window shows Start again, and the next launch does not open it. */
async function stopCompany(path: string) {
  // Still choosing its port: its session is not there to stop yet.
  await opening.get(path);
  dontReopen(path);
  await stop(path);
}

/** Stops the company and starts it again in its window, which shows the start, then the app again. */
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

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Where the folder dialogs of New Company and Clone Company start. */
const parentFolder = () => defaultParent(readCompanies(companiesFile()), homedir());

/** Answers the form the start window shows (`ask`), once: with what was typed, or undefined (Cancel, closed). */
let answer: ((value: unknown) => void) | undefined;

/** Shows `form` in the start window; resolves with the answer, or undefined when the person cancels. */
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
  await begin(realpathSync(dir), createSession);
}

/**
 * File → Clone Company…: the repository's address (the start window asks), the folder to clone
 * into (a dialog), then the clone, as the company's session (`cloneSession`), so the start window
 * shows it and a failure, and Start again clones again.
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
  const parent = realpathSync(filePaths[0]);
  const target = cloneTarget(url, parent);
  if ("problem" in target) return tell(target.problem);
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
  const name = windows.get(path)?.state.name ?? companyName(path);
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
    if (failed) say(failed, true);
    else say(`Got ${plan.behind} new ${plan.behind === 1 ? "change" : "changes"} from GitHub; it is starting again`);
  } catch (err) {
    say(`Sanoma could not get updates: ${messageOf(err)}`, true);
  } finally {
    updating.delete(path);
  }
}

/** A menu action on the company of the focused window, when it is a company's. */
const forFocused = (act: (path: string) => unknown) => () => {
  const focused = BaseWindow.getFocusedWindow();
  const path = [...windows].find(([, shown]) => shown.window === focused)?.[0];
  if (path) void act(path);
};

/**
 * A View menu action on the page that has the focus: the menu's own roles act on a
 * `BrowserWindow`'s page only, and a company's window is a `BaseWindow` holding two.
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
        { label: "Stop", click: forFocused(stopCompany) },
        { label: "Get Updates", click: forFocused(getUpdates) },
        { label: "Show in Finder", click: forFocused((path) => shell.openPath(path)) },
        { label: "Show Log", click: forFocused((path) => shell.openPath(logFile(path))) },
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
    else if (windows.size) showWindow([...windows.keys()].at(-1)!);
    else showStart();
  });
  // A folder dropped on the Dock icon, or opened with the app.
  const dropped: string[] = [];
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (app.isReady()) void openCompany(path);
    else dropped.push(path);
  });

  /** The company whose window's page sent an IPC message, if it is one. */
  const companyOf = (sender: WebContents) => [...windows].find(([, shown]) => shown.shellView.webContents === sender);
  ipcMain.handle("start:state", ({ sender }) =>
    sender === startWindow?.webContents ? startState() : companyOf(sender)?.[1].state,
  );
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
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!BaseWindow.getAllWindows().some((window) => window.isVisible())) showStart();
  });

  void app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "Sanoma", applicationVersion: app.getVersion() });
    buildMenu();
    // The built app only: a checkout's shell (start, the smoke test) shares its settings and asks GitHub only from Help.
    if (app.isPackaged) {
      checkForUpdate(false);
      // Hourly against the saved time, not a day-long timer, which would not count the hours asleep.
      setInterval(() => checkForUpdate(false), 60 * 60 * 1000);
    }
    // The companies open at the last Quit open again, each in its window at its saved bounds.
    const reopen = toReopen(readCompanies(companiesFile()));
    for (const path of reopen) void begin(path);
    const folder = folderArgument(argsOf(process.argv), process.cwd(), ownPath()) ?? dropped.at(-1);
    if (folder) void openCompany(folder);
    else if (!reopen.length) showStart();
  });
}
