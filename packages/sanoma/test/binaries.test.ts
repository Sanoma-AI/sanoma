import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CPU_ARM64, CPU_X86_64, linkDuplicates, RELEASE, thinSlice } from "../scripts/download-postgres.ts";
import { POSTGRES_PLATFORMS } from "../src/postgres-bin.ts";

/** A universal Mach-O file (32-bit fat header) holding `slices`, each at its own offset. */
function fat(slices: [cpu: number, bytes: string][]): Buffer {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = header.length;
  slices.forEach(([cpu, bytes], i) => {
    header.writeUInt32BE(cpu, 8 + i * 20);
    header.writeUInt32BE(offset, 8 + i * 20 + 8);
    header.writeUInt32BE(bytes.length, 8 + i * 20 + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...slices.map(([, bytes]) => Buffer.from(bytes))]);
}

describe("RELEASE", () => {
  it("pins a jar for each platform the launcher looks up, and each is an optional dependency of sanoma", () => {
    expect(Object.keys(RELEASE.jars).toSorted()).toEqual(POSTGRES_PLATFORMS.toSorted());
    const { optionalDependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(optionalDependencies).toSorted()).toEqual(
      POSTGRES_PLATFORMS.map((platform) => `@sanoma-ai/postgres-${platform}`).toSorted(),
    );
  });
});

describe("thinSlice", () => {
  it("returns the slice for the CPU, and nothing for a file that is not universal", () => {
    const file = fat([
      [CPU_X86_64, "x86_64 slice"],
      [CPU_ARM64, "arm64 slice"],
    ]);
    expect(thinSlice(file, CPU_ARM64)?.toString()).toBe("arm64 slice");
    expect(thinSlice(file, CPU_X86_64)?.toString()).toBe("x86_64 slice");
    expect(thinSlice(Buffer.from("#!/bin/sh\n"), CPU_ARM64)).toBeUndefined();
    // A Java class file: the same magic, then a version.
    expect(thinSlice(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x41]), CPU_ARM64)).toBeUndefined();
  });

  it("throws for a universal file without the CPU's slice", () => {
    expect(() => thinSlice(fat([[CPU_X86_64, "x86_64 slice"]]), CPU_ARM64)).toThrow(/without a slice/);
  });
});

describe("linkDuplicates", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("makes each byte-identical copy a link to the longest name, and leaves the rest", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-postgres-libs-"));
    for (const name of ["libicuuc.dylib", "libicuuc.77.dylib", "libicuuc.77.1.dylib"])
      writeFileSync(join(dir, name), "icu");
    writeFileSync(join(dir, "libz.1.dylib"), "zlib");
    linkDuplicates(dir);
    expect(readlinkSync(join(dir, "libicuuc.dylib"))).toBe("libicuuc.77.1.dylib");
    expect(readlinkSync(join(dir, "libicuuc.77.dylib"))).toBe("libicuuc.77.1.dylib");
    expect(lstatSync(join(dir, "libicuuc.77.1.dylib")).isFile()).toBe(true);
    expect(lstatSync(join(dir, "libz.1.dylib")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "libicuuc.dylib"), "utf8")).toBe("icu");
  });
});
