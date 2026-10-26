// The start window: the recent companies, Open folder, and the company starting or stopped.
// `window.sanoma` is the preload's bridge (src/preload.cts).
const bridge = window.sanoma;
const $ = (id) => document.getElementById(id);

const item = (text) => {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
};

function render(state) {
  $("warnings").replaceChildren(
    ...state.warnings.map((text) =>
      Object.assign(document.createElement("p"), { className: "warning", textContent: text }),
    ),
  );

  const company = state.company;
  $("company").hidden = !company;
  if (company) {
    $("company-name").textContent = company.name;
    const message = $("company-message");
    message.textContent =
      state.phase === "failed" ? state.message : state.phase === "starting" ? `Starting ${company.path}` : "Running";
    message.className = state.phase === "failed" ? "failed" : "muted";
    $("progress").replaceChildren(...state.progress.map((step) => item(`${step}…`)));
    $("progress").hidden = !state.progress.length || state.phase !== "starting";
    $("again-actions").hidden = state.phase !== "failed";
    const log = $("log");
    log.hidden = !state.log.length;
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.textContent = state.log.join("\n");
    if (atEnd) log.scrollTop = log.scrollHeight;
  }

  $("recent-section").hidden = !state.recent.length;
  $("recent").replaceChildren(
    ...state.recent.map((c) => {
      const button = document.createElement("button");
      button.append(c.name, Object.assign(document.createElement("small"), { textContent: c.path }));
      button.addEventListener("click", () => bridge.open(c.path));
      const li = document.createElement("li");
      li.append(button);
      return li;
    }),
  );
}

$("choose").addEventListener("click", () => bridge.choose());
$("again").addEventListener("click", () => bridge.again());
for (const button of document.querySelectorAll("[data-later]")) {
  button.addEventListener("click", () => {
    const later = $("later");
    later.textContent = `${button.dataset.later} comes in the next version of Sanoma. For now, open a folder that holds a company.`;
    later.hidden = false;
  });
}
bridge.onState(render);
bridge.state().then(render);
