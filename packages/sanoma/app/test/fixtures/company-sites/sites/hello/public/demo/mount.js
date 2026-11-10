// A prebuilt module the site loads at run time by its URL: served as it is, never bundled.
export function mount(element) {
  element.textContent = "Mounted from public";
}
