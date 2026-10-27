// A company window's own page, until its app answers and whenever it stops: the steps, the log's
// tail, why it stopped, Start again. `window.sanoma` is the preload's bridge (src/preload.ts).
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
  log.hidden = !state.log.length;
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = state.log.join("\n");
  if (atEnd) log.scrollTop = log.scrollHeight;
}

$("again").addEventListener("click", () => bridge.again());
$("skip").addEventListener("click", () => bridge.skip());
bridge.onState(render);
bridge.state().then((state) => state && render(state));
