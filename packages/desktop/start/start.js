// The start screen, what the window shows with no company shown: the choices (each saying what it
// is for while there are no companies), the recent companies (marked when they run), and the forms
// for a new company, a copy from GitHub and who commits. A company starts in the same window, on
// its own page (company.js), then its app.
// `window.sanoma` is the preload's bridge (src/preload.ts).
import { folderNameOf } from "../src/pages.ts";

const bridge = window.sanoma;
const $ = (id) => document.getElementById(id);

const FORMS = {
  new: { title: "New company", first: () => "new-name" },
  clone: { title: "Copy a company from GitHub", first: () => "clone-url" },
  identity: {
    title: "Who makes the changes?",
    lede: "Each change is signed with a name and an email address. A new company also lists you as its first person.",
    first: (ask) => (ask.name ? "identity-email" : "identity-name"),
  },
};

/** The form shown last, so a state sent while the person types keeps what they typed. */
let shownAsk;
/** Where the new company form says the company goes (`ask.parent`), which its answer carries. */
let newParent;

function showNewPlace(ask) {
  $("new-place").textContent = `${ask.place}${folderNameOf($("new-name").value) || "…"}`;
}

/** Shows the form `state.ask` names, filled from it when it first shows, with its problem. */
function renderAsk(ask) {
  const kind = ask?.kind;
  for (const form of Object.keys(FORMS)) {
    $(`${form}-form`).hidden = kind !== form;
    const problem = $(`${form}-problem`);
    problem.textContent = kind === form ? (ask.problem ?? "") : "";
    problem.hidden = !problem.textContent;
  }
  if (kind && kind !== shownAsk) {
    if (kind === "new") $("new-name").value = ask.name;
    if (kind === "clone") $("clone-url").value = ask.url ?? "";
    if (kind === "identity") {
      $("identity-name").value = ask.name;
      $("identity-email").value = ask.email;
    }
    $(FORMS[kind].first(ask)).focus();
  }
  shownAsk = kind;
  if (kind === "new") {
    newParent = ask.parent;
    showNewPlace(ask);
    $("new-warning").textContent = ask.warning ?? "";
    $("new-warning").hidden = !ask.warning;
  }
}

let shown;

function render(state) {
  shown = state;
  renderAsk(state.ask);
  const form = state.ask && FORMS[state.ask.kind];
  const returning = state.recent.length > 0;
  document.body.classList.toggle("returning", returning);
  $("home").hidden = !!form;
  $("title").textContent = form?.title ?? (returning ? "Your companies" : "Start a company, or open one");
  const lede = form ? form.lede : returning ? undefined : "Sanoma runs it on this computer, in this window.";
  $("lede").textContent = lede ?? "";
  $("lede").hidden = !lede;

  const notice = $("notice");
  notice.hidden = !state.notice;
  notice.textContent = state.notice?.text ?? "";
  notice.className = state.notice?.problem ? "problem" : "muted";
  $("warnings").replaceChildren(
    ...state.warnings.map((text) => {
      const link = Object.assign(document.createElement("button"), { className: "link", textContent: "Download" });
      link.type = "button";
      link.addEventListener("click", () => bridge.download());
      const line = Object.assign(document.createElement("p"), { textContent: `${text} ` });
      line.append(link);
      const banner = Object.assign(document.createElement("div"), { className: "banner" });
      banner.append(line);
      return banner;
    }),
  );

  $("recent").hidden = !returning;
  $("recent").replaceChildren(
    ...state.recent.map((c) => {
      const text = Object.assign(document.createElement("span"), { className: "row-text" });
      text.append(
        Object.assign(document.createElement("span"), { className: "row-name", textContent: c.name }),
        Object.assign(document.createElement("small"), { textContent: c.place }),
      );
      const button = Object.assign(document.createElement("button"), { className: "row" });
      button.append(text);
      if (c.running) {
        const running = Object.assign(document.createElement("span"), { className: "running" });
        running.append(Object.assign(document.createElement("span"), { className: "dot" }), "Running");
        button.append(running);
      }
      button.addEventListener("click", () => bridge.open(c.path));
      const li = document.createElement("li");
      li.append(button);
      return li;
    }),
  );
}

$("choose").addEventListener("click", () => bridge.choose());
$("create").addEventListener("click", () => bridge.create());
$("clone").addEventListener("click", () => bridge.clone());
$("new-name").addEventListener("input", () => shown?.ask?.kind === "new" && showNewPlace(shown.ask));
$("new-change").addEventListener("click", () => bridge.changePlace());
$("new-form").addEventListener("submit", (event) => {
  event.preventDefault();
  bridge.answer({ name: $("new-name").value, parent: newParent });
});
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
