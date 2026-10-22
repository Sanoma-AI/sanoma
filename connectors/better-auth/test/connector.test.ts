import { resolveConfig } from "@sanoma-ai/workflows";
import { describeConfig, generateApi } from "@sanoma-ai/workflows/describe";
import { expect, it } from "vitest";
import { betterAuthLogin } from "../src/login.ts";
import company from "./fixtures/company/sanoma.config.ts";

it("is a connector with no operations, its secret and its login half, as the app and the SDK read it", () => {
  const description = describeConfig(company);
  expect(description.vendors["better-auth"]).toMatchObject({
    title: "Better Auth",
    package: "@sanoma-ai/connector-better-auth",
    fake: false,
    logo: { src: expect.stringMatching(/^data:image\/svg\+xml/), dark: expect.any(String) },
  });
  expect(description.ops.filter((op) => op.vendor === "better-auth")).toEqual([]);
  // policies/visitors.cedar: the one permit a company file may hold.
  expect(description.policy).toMatchObject({ defined: true });
  expect(description.policy.problems).toBeUndefined();
  expect(description.sites).toMatchObject([{ name: "account", public: true, login: "better-auth", problems: [] }]);
  const { source, problems } = generateApi(description);
  expect(problems).toEqual([]);
  expect(source).not.toContain("better-auth");

  const resolved = resolveConfig(company);
  expect(Object.keys(resolved.driversByVendor.get("better-auth")?.env?.shape ?? {})).toEqual(["BETTER_AUTH_SECRET"]);
  expect(resolved.logins.get("better-auth")).toBe(betterAuthLogin);
});
