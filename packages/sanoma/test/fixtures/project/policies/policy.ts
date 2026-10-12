import { allow, definePolicy } from "sanoma";

// Everything is allowed: the fixture is about running, not deciding.
export default definePolicy(() => allow(), { version: "fixture-1" });
