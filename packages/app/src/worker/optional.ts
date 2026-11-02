// DBOS's optional dependencies: required lazily by its client and runtime, only with tracing or
// OTLP logs on, and unresolvable in a bundle without them. The Worker's build aliases each to
// `missing.js`, which throws if one is ever loaded (measured on workerd for #428: DBOSClient bundles
// with exactly these and enqueues).
export const OPTIONAL = [
  "@opentelemetry/api",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/core",
  "@opentelemetry/exporter-logs-otlp-proto",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-trace-base",
  "winston",
  "winston-transport",
] as const;
