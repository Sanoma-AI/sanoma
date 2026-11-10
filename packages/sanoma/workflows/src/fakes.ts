// `sanoma/workflows/fake`: the fakes for tests, `defineFake` and `connectionFakes` (`fake.ts`,
// which a page's runtime reads too) and the wakeup service in memory (`wakeup-fake.ts`, server-only).
export * from "./fake.ts";
export { fakeSanomaWakeup } from "./wakeup-fake.ts";
