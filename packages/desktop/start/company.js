// A company's own page in the window, until its app answers and whenever it stops: the steps, the
// log in a terminal, why it stopped, Start again. `window.sanoma` is the preload's bridge (src/preload.ts).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
// oxlint-disable-next-line import/no-unassigned-import
import "@xterm/xterm/css/xterm.css";

const bridge = window.sanoma;
const $ = (id) => document.getElementById(id);

const item = (text) => {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
};

const messages = {
  starting: (state) => `Starting ${state.path}`,
  running: () => "Opening the app",
  stopped: () => "Stopped",
  failed: (state) => state.message,
};

// The page's own colours; xterm takes values, not CSS variables.
function terminalTheme() {
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  return {
    background: color("--card"),
    foreground: color("--fg"),
    selectionBackground: color("--line"),
    // Nothing to type at, so no cursor. In the theme, as a child's escape codes can turn a hidden one back on.
    cursor: "#00000000",
    cursorAccent: "#00000000",
  };
}

// Read-only: the launcher's stdio is a pipe with no one typing. The contrast ratio keeps its colours,
// chosen for a dark terminal, readable on the light theme. The last line holds the cursor, and
// xterm leaves that line for a shell to redraw unless told to wrap it when the window narrows.
const terminal = new Terminal({
  cursorInactiveStyle: "none",
  disableStdin: true,
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 12,
  minimumContrastRatio: 4.5,
  reflowCursorLine: true,
  theme: terminalTheme(),
});
const fit = new FitAddon();
terminal.loadAddon(fit);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  terminal.options.theme = terminalTheme();
});
new ResizeObserver(() => fit.fit()).observe($("log"));

// Which start the terminal shows, and how many of its lines it has.
let shownStart = 0;
let written = 0;

// Only what is new, so that scrolling back and a selection survive more output.
function writeLog({ start, skipped, lines }) {
  if (start !== shownStart) {
    terminal.reset();
    shownStart = start;
    written = 0;
  }
  const fresh = lines.slice(Math.max(0, written - skipped));
  if (!fresh.length) return;
  terminal.write(`${written ? "\r\n" : ""}${fresh.join("\r\n")}`);
  written = skipped + lines.length;
}

function render(state) {
  document.title = state.name;
  $("company-name").textContent = state.name;
  const message = $("company-message");
  message.textContent = messages[state.phase](state);
  message.className = state.phase === "failed" ? "failed" : "muted";
  $("warnings").replaceChildren(
    ...state.warnings.map((text) =>
      Object.assign(document.createElement("p"), { className: "warning", textContent: text }),
    ),
  );
  $("progress").replaceChildren(...state.progress.map((step) => item(`${step}…`)));
  $("progress").hidden = !state.progress.length || state.phase !== "starting";
  const stopped = state.phase === "failed" || state.phase === "stopped";
  $("again-actions").hidden = !stopped;
  // A company that fails at each launch: one line not to open it again then.
  $("reopens").hidden = state.phase !== "failed" || !state.reopens;
  const log = $("log");
  log.hidden = !state.log.lines.length;
  // xterm measures its font when it opens, so not while the log is hidden.
  if (!log.hidden && !terminal.element) terminal.open(log);
  writeLog(state.log);
}

$("again").addEventListener("click", () => bridge.again());
$("skip").addEventListener("click", () => bridge.skip());
bridge.onState(render);
bridge.state().then((state) => state && render(state));
