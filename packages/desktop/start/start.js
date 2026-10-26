// The start window: the recent companies, Open folder, New company, Clone (its form), the
// identity form, and the company starting or stopped.
// `window.sanoma` is the preload's bridge (src/preload.cts).
const bridge = window.sanoma;
const $ = (id) => document.getElementById(id);

const item = (text) => {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
};

/** The form shown last, so a state sent while the person types keeps what they typed. */
let shownAsk;

/** Shows the form `state.ask` names, filled from it when it first shows, with its problem. */
function renderAsk(ask) {
  const kind = ask?.kind;
  $("clone-form").hidden = kind !== "clone";
  $("identity-form").hidden = kind !== "identity";
  if (kind && kind !== shownAsk) {
    if (kind === "clone") $("clone-url").value = ask.url ?? "";
    if (kind === "identity") {
      $("identity-name").value = ask.name;
      $("identity-email").value = ask.email;
    }
    $(kind === "clone" ? "clone-url" : ask.name ? "identity-email" : "identity-name").focus();
  }
  shownAsk = kind;
  for (const form of ["clone", "identity"]) {
    const problem = $(`${form}-problem`);
    problem.textContent = kind === form ? (ask.problem ?? "") : "";
    problem.hidden = !problem.textContent;
  }
}

function render(state) {
  renderAsk(state.ask);
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
$("create").addEventListener("click", () => bridge.create());
$("clone").addEventListener("click", () => bridge.clone());
$("clone-form").addEventListener("submit", (event) => {
  event.preventDefault();
  bridge.answer($("clone-url").value);
});
$("identity-form").addEventListener("submit", (event) => {
  event.preventDefault();
  bridge.answer({ name: $("identity-name").value, email: $("identity-email").value });
});
for (const button of document.querySelectorAll("[data-cancel]"))
  button.addEventListener("click", () => bridge.cancel());
bridge.onState(render);
bridge.state().then(render);
