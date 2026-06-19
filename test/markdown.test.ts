import { describe, expect, it } from "vitest";

import { markdownToHtml } from "../src/markdown.js";

describe("markdownToHtml", () => {
  it("제목 → <h1>", () => {
    expect(markdownToHtml("# 제목")).toContain("<h1>제목</h1>");
  });

  it("볼드 → <strong>", () => {
    expect(markdownToHtml("**굵게**")).toContain("<strong>굵게</strong>");
  });

  it("목록 → <ul><li>", () => {
    const html = markdownToHtml("- 하나\n- 둘");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>하나</li>");
    expect(html).toContain("<li>둘</li>");
  });

  it("코드블록 → <pre><code>", () => {
    const html = markdownToHtml("```\nconst a = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
  });

  it("빈 문자열 → 빈 문자열", () => {
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml("   ")).toBe("   ");
  });
});
