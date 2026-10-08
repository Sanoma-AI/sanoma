import { describe, expect, it } from "vitest";
import { hostName, isLoopback } from "../src/loopback.ts";

// The Host names a loopback-only app answers to. No database, no build.
const answers = (host: string) => isLoopback(hostName(host));

describe("the loopback rule", () => {
  it("accepts this machine's names, with or without a port, in any case", () => {
    for (const host of [
      "localhost",
      "localhost:1234",
      "LOCALHOST",
      "127.0.0.1:80",
      "127.5.5.5",
      "[::1]:1234",
      "[::1]",
    ]) {
      expect(answers(host), host).toBe(true);
    }
  });

  it("refuses any other name, including one that starts like a loopback address", () => {
    for (const host of ["127.0.0.1.evil.com", "evil.com:80", "localhost.evil.com", "0.0.0.0", "[::2]:1", ""]) {
      expect(answers(host), host).toBe(false);
    }
  });
});
