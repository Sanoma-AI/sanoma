import { memorySecrets, type CallContext } from "sanoma/workflows";
import { expect, it } from "vitest";
import { fakeNeon } from "../src/fake.ts";

it("keeps duplicate names separate across fake pages, searches by name or id, and never returns passwords", async () => {
  const fake = fakeNeon();
  const call: CallContext = {
    idempotencyKey: "list-test",
    runId: "list-test",
    opId: "neon.project",
    attempt: 1,
    secrets: memorySecrets(),
  };
  let invocation = 0;
  const nextCall = () => ({ ...call, idempotencyKey: `list-test:${++invocation}` });
  const create = (name: string) =>
    fake.driver.ops["project.create"]!({ desired: { name, region: "aws-us-east-1" } }, nextCall());
  await create("cloud-company");
  await create("unrelated");
  await create("cloud-company");
  const list = (input: object) =>
    fake.driver.ops["project.list"]!(input, nextCall()) as Promise<{
      projects: { id: string; name: string; region: string; pg_version: number }[];
      next?: string;
    }>;
  const first = await list({ search: "cloud-comp", limit: 1 });
  expect(first.projects).toHaveLength(1);
  expect(first.next).toBeDefined();
  const second = await list({ search: "cloud-comp", limit: 1, cursor: first.next });
  expect(second.next).toBeUndefined();
  expect(second.projects).toHaveLength(1);
  expect(second.projects[0]!.name).toBe(first.projects[0]!.name);
  expect(second.projects[0]!.id).not.toBe(first.projects[0]!.id);
  expect(await list({ search: second.projects[0]!.id })).toEqual({ projects: second.projects });
  expect(await list({ search: "absent" })).toEqual({ projects: [] });
  const all = await list({});
  expect(all.projects).toHaveLength(3);
  expect(JSON.stringify(all)).not.toContain("password");
});
