// A repeatable demonstration, not an AI benchmark: the scripted model calls the real edit/check tools.
import { createChat } from "@shadcn/helpers/ai-sdk";
import { defineConnector, withSetup, type ConnectorSetup } from "sanoma/workflows";

type Provider = Awaited<ReturnType<NonNullable<ConnectorSetup["model"]>>>;
type Model = ReturnType<Provider["languageModel"]>;

export const REQUEST =
  "Build a launch desk for marketing: a title and announcement body, a Ghost draft, then marketing-lead approval before Ghost publishing and Resend email. Use our existing connections and demo recipient.";

export const WORKFLOW = `import { ghost } from "@sanoma-ai/connector-ghost";
import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "announce",
  title: "Announce a launch",
  trigger: "manual",
  input: z.object({ title: z.string().min(1), body: z.string().min(1) }),
  uses: [ghost.post.create, "approval", ghost.post.publish, resend.emails.send],
  run: async (ctx, { title, body }) => {
    const post = await ctx.ghost.post.create({ title, html: body, status: "draft" });
    await ctx.approval("Approve this announcement", {
      approver: "marketing-lead",
      covers: [ghost.post.publish, resend.emails.send],
      links: [post.url],
    });
    const published = await ctx.ghost.post.publish({ id: post.id });
    const email = await ctx.resend.emails.send({
      from: "Paperplane Studio <news@paperplane.example>",
      to: "reader@example.com",
      subject: title,
      html: body,
    });
    return { url: published.url, email: email.id };
  },
});
`;

export const POLICY = `@id("marketing-reviews")
@hold("marketing-lead")
@title("Marketing lead reviews publishing and email")
forbid (principal,
  action in [Sanoma::Action::"ghost.post.publish", Sanoma::Action::"resend.emails.send"],
  resource)
unless { principal == Sanoma::Principal::"marketing-lead" };
`;

export const PAGE = `import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "sanoma/site";
import { PageHeader, Region } from "sanoma/ui";

export const Route = createFileRoute("/sites/launches/")({ component: LaunchDesk });

function LaunchDesk() {
  return (
    <>
      <PageHeader title="Launch desk" />
      <Region title="Paperplane Studio · Marketing">
        <p>Prepare an announcement for our website and email list.</p>
        <p>Ghost saves a draft. The marketing lead approves before publishing and sending through Resend.</p>
      </Region>
      <Region title="Our next announcement">
        <RunForm workflow="announce" />
      </Region>
    </>
  );
}
`;

export const FILES: Record<string, string> = {
  "workflows/announce.ts": WORKFLOW,
  "policies/marketing.cedar": POLICY,
  "sites/launches/site.ts":
    'import { defineSite } from "sanoma/site";\nexport default defineSite({ title: "Launch desk" });\n',
  "sites/launches/routes/index.tsx": PAGE,
};

/** No live AI calls or borrowed credentials. Only the model's decisions are scripted. */
export function demoAgent() {
  // shadcn's helper authors the mock conversation. Its tool inputs enter Sanoma's real
  // ToolLoopAgent; outputs/check results are produced by the backend, never scripted here.
  // An unresolved helper tool pauses its conversation; keep each backend step independent.
  const steps = Object.entries(FILES).map(([path, content]) => ({
    tool: "write_file",
    input: { path, content, message: `Launch desk: ${path}` },
  }));
  const responses = [...steps, { tool: "run_checks", input: {} }].flatMap(({ tool, input }) =>
    createChat()
      .user(REQUEST)
      .assistant(({ writer }) => {
        writer.tool(tool, { input });
      })
      .get()
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts),
  );
  responses.push(
    ...createChat()
      .assistant(
        "Scripted demo: the launch-desk files are on this draft branch. Review the actual check results and permissions before publishing.",
      )
      .get()
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text"),
  );
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  };
  const model: Model = {
    specificationVersion: "v4",
    provider: "scripted-demo",
    modelId: "scripted-demo",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("The demo uses streaming only");
    },
    doStream: async ({ prompt }) => {
      const last = prompt.findLastIndex((m) => m.role === "user");
      const index = prompt.slice(last).filter((m) => m.role === "assistant").length;
      const part = responses[index];
      if (!part) throw new Error(`Unexpected demo model step: ${index}`);
      const step =
        part.type.startsWith("tool-") && "input" in part ? { tool: part.type.slice(5), input: part.input } : undefined;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (step) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `demo-${index}`,
                toolName: step.tool,
                input: JSON.stringify(step.input),
              });
            } else {
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({ type: "text-delta", id: "t", delta: "text" in part ? part.text : "" });
              controller.enqueue({ type: "text-end", id: "t" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: { unified: step ? "tool-calls" : "stop", raw: undefined },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  };
  return withSetup(defineConnector("demo", {}), {
    model: () => ({
      specificationVersion: "v4",
      languageModel: () => model,
      embeddingModel: () => {
        throw new Error("No demo embeddings");
      },
      imageModel: () => {
        throw new Error("No demo images");
      },
    }),
  });
}
