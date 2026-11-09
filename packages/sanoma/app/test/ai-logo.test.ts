// The marks are Vite `?url` imports, whose types the root tsconfig (Node only) leaves out.
/// <reference types="vite/client" />
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiLogo } from "../src/components/shell/ai-logo.tsx";

const draw = (mark: Parameters<typeof AiLogo>[0]["mark"], alt?: string) =>
  renderToStaticMarkup(createElement(AiLogo, { mark, ...(alt !== undefined && { alt }) }));

describe("AiLogo", () => {
  it("draws a brand-coloured mark once and a one-colour mark once per theme", () => {
    expect(draw("claude").match(/<img/g)).toHaveLength(1);
    const pi = draw("pi");
    expect(pi.match(/<img/g)).toHaveLength(2);
    expect(pi).toContain("dark:block");
    expect(pi).toContain("dark:hidden");
  });

  it("is decorative beside a name, named where it stands alone", () => {
    expect(draw("codex")).toContain('alt=""');
    expect(draw("codex", "Codex")).toContain('alt="Codex"');
  });
});
