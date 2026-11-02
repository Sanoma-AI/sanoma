// What the runtime imports that the Worker never runs, and its build leaves out, aliasing each to
// `missing.js`, whose every use throws: DBOS's optional dependencies, required lazily only with
// tracing or OTLP logs on (measured on workerd for #428: DBOSClient bundles without exactly these,
// and enqueues), and the runtime's source tools, which parse and format the company's files.
export const OPTIONAL: readonly string[] = [
  "@opentelemetry/api",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/core",
  "@opentelemetry/exporter-logs-otlp-proto",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-trace-base",
  "winston",
  "winston-transport",
  "oxc-parser",
  "oxfmt",
];
