// A company's own page in the window, until its app answers and whenever it stops: its steps, its
// output in a terminal a click away, why it stopped, Start again. What shows when is `companyPage`.
// `window.sanoma` is the preload's bridge (src/preload.ts).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
// oxlint-disable-next-line import/no-unassigned-import
import "@xterm/xterm/css/xterm.css";
import { companyPage } from "../src/pages.ts";

const bridge = window.sanoma;
const $ = (id) => document.getElementById(id);
const show = (id, shown) => {
  $(id).hidden = !shown;
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
  fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.2,
  minimumContrastRatio: 4.5,
  reflowCursorLine: true,
  screenReaderMode: true,
  theme: terminalTheme(),
});
const fit = new FitAddon();
terminal.loadAddon(fit);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  terminal.options.theme = terminalTheme();
});
new ResizeObserver(() => {
  if (!$("output").hidden) fit.fit();
}).observe($("log"));

// Which start the terminal shows, and how many of its lines it has.
let shownStart = 0;
let written = 0;

// Only what is new, so that scrolling back and a selection survive more output. A new start's reset
// goes in as a write, so that it follows what is still queued. Lines that left the tail unseen (the
// page gets none while the app shows) are said to be missing, not joined up as if they ran on.
function writeLog({ start, skipped, lines }) {
  if (start !== shownStart) {
    terminal.write("\x1bc");
    shownStart = start;
    written = 0;
  }
  const fresh = lines.slice(Math.max(0, written - skipped));
  if (!fresh.length) return;
  const missed = skipped - written;
  if (missed > 0) fresh.unshift(`… ${missed} lines not shown: Show log file has them all`);
  terminal.write(`${written ? "\r\n" : ""}${fresh.join("\r\n")}`);
  written = skipped + lines.length;
}

const STEP_ICONS = {
  done: '<circle class="tick-bg" cx="8" cy="8" r="7" /><path class="tick" d="M5 8.2l2 2 4-4.4" />',
  now: '<circle class="ring" cx="8" cy="8" r="6.5" /><path class="arc" d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" />',
  next: '<circle class="ring" cx="8" cy="8" r="6.5" />',
};

function stepRow({ label, status }) {
  const li = Object.assign(document.createElement("li"), { className: status });
  li.innerHTML = `<svg class="step" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${STEP_ICONS[status]}</svg>`;
  li.append(Object.assign(document.createElement("span"), { textContent: label }));
  return li;
}

/** The state last sent, which the page draws again when time changes it (`changesAt`) or its Hide does. */
let state;
/** The output's Hide on a failed page: for this page only, as Show details is for a start. */
let hiddenOnFailure = false;
let redraw;

function render(next) {
  state = next;
  const now = Date.now();
  const page = companyPage(state, now);
  const failed = state.phase === "failed";
  if (!failed) hiddenOnFailure = false;
  const output = failed ? !hiddenOnFailure : state.details;
  document.title = state.name;
  document.body.dataset.layout = page.ended || output ? "wide" : "column";

  $("company-name").textContent = state.name;
  $("pill").textContent = page.pill ?? "";
  $("pill").className = failed ? "pill" : "pill off";
  show("pill", page.ended && page.pill);
  const quietly = !page.ended && !output && !page.opening;
  $("place").textContent = state.place;
  show("place", quietly);

  // One word while it opens; beside the name, the step under way, once the output takes the list's place.
  show("current", page.opening || (!page.ended && output && page.step));
  $("current-step").textContent = page.opening ? "Opening" : (page.step ?? "");
  $("current-note").textContent = page.note ?? "";
  show("current-note", output && page.note);
  show("note", quietly && page.note);
  $("note").textContent = page.note ?? "";

  $("reason").textContent = state.message ?? "";
  show("reason", failed);
  show("send-details", page.sendDetails);
  show("again-actions", page.ended);
  // A company that fails at each launch: one line not to open it again then.
  show("reopens", failed && state.reopens);
  show("skip", failed && state.reopens);

  $("warning-text").textContent = state.warning ?? "";
  show("warning", !!state.warning);
  show("quiet", page.quiet);

  show("steps", quietly);
  $("steps").replaceChildren(...page.steps.map(stepRow));

  show("controls", !page.opening && !(failed && output));
  show("stop", !page.ended);
  $("details").setAttribute("aria-expanded", String(output));
  $("details-label").textContent = output ? "Hide details" : "Show details";
  show("closing", quietly && page.closing);
  $("closing").textContent = page.closing ?? "";

  show("output", output);
  show("hide", failed);
  // xterm measures its font when it opens, so not while the output is hidden.
  if (output && !terminal.element) terminal.open($("log"));
  writeLog(state.log);

  clearTimeout(redraw);
  if (page.changesAt !== undefined) redraw = setTimeout(() => render(state), page.changesAt - now);
}

$("again").addEventListener("click", () => bridge.again());
$("skip").addEventListener("click", () => bridge.skip());
$("stop").addEventListener("click", () => bridge.stop());
$("got-it").addEventListener("click", () => bridge.gotIt());
$("show-log").addEventListener("click", () => bridge.showLog());
$("details").addEventListener("click", () => {
  if (state.phase === "failed") {
    hiddenOnFailure = false;
    return render(state);
  }
  // The main process keeps it and sends it back, to every company's page.
  bridge.setDetails(!state.details);
});
$("hide").addEventListener("click", () => {
  hiddenOnFailure = true;
  render(state);
});
$("copy").addEventListener("click", async () => {
  await bridge.copyDetails();
  $("copy").textContent = "Copied";
  setTimeout(() => {
    $("copy").textContent = "Copy";
  }, 1_500);
});
// Before anything draws: xterm measures the font it opens with, and the bundled one loads on demand.
await document.fonts.load('12px "IBM Plex Mono"');
bridge.onState(render);
bridge.state().then((sent) => sent && render(sent));
