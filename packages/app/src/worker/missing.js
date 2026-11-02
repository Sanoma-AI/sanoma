// What the Worker's build puts in place of DBOS's optional telemetry packages (`OPTIONAL` in
// `optional.ts`): DBOS requires them lazily, only when tracing or OTLP logs are on, which they never
// are on the Worker, and they are not installed beside it.
throw new Error("not on the Cloudflare Worker: DBOS's telemetry is off there");
