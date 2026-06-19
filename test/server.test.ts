import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type DailyLogArgs, registerTools, validate } from "../src/server.js";

function args(over: Partial<DailyLogArgs> = {}): DailyLogArgs {
  return {
    title: "t",
    feature_name: "f",
    problems: "p",
    solution: "s",
    result: "r",
    category: "mini",
    status: "in_progress",
    content: "",
    ...over,
  };
}

describe("validate", () => {
  it("필수 필드 누락", () => {
    const errors = validate(args({ title: "", problems: "" }));
    expect(errors.some((e) => e.includes("title"))).toBe(true);
    expect(errors.some((e) => e.includes("problems"))).toBe(true);
  });

  it("길이 초과", () => {
    const errors = validate(args({ title: "x".repeat(41) }));
    expect(errors.some((e) => e.includes("40자"))).toBe(true);
  });

  it("category/status 검증", () => {
    const errors = validate(args({ category: "bad", status: "weird" }));
    expect(errors.some((e) => e.includes("category"))).toBe(true);
    expect(errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("정상이면 빈 배열", () => {
    expect(validate(args({ category: "final", status: "completed", content: "상세" }))).toEqual([]);
  });
});

describe("도구 — 인메모리 MCP 디스패치", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chwijung-server-"));
    process.env.CHWIJUNG_SESSION_FILE = join(dir, "session.json");
  });

  afterEach(() => {
    delete process.env.CHWIJUNG_SESSION_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<Client> {
    const server = new McpServer({ name: "chwijung", version: "0.1.0" });
    registerTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("도구 3개 등록", async () => {
    const client = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["login", "submit_daily_log", "whoami"]);
  });

  it("whoami — 미로그인", async () => {
    const client = await connect();
    const res = (await client.callTool({ name: "whoami", arguments: {} })) as any;
    expect(res.content[0].text).toContain("로그인되어 있지 않");
  });

  it("login — 비밀번호 인자 없이 터미널 CLI 로그인 안내", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const login = tools.tools.find((t) => t.name === "login");
    // 비밀번호/이메일 인자를 더 이상 받지 않는다(LLM 노출 방지)
    expect(Object.keys(login?.inputSchema?.properties ?? {})).toHaveLength(0);
    const res = (await client.callTool({ name: "login", arguments: {} })) as any;
    expect(res.content[0].text).toContain("npx chwijung-mcp login");
  });

  it("submit_daily_log — 검증 실패 메시지(네트워크 없음)", async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: "submit_daily_log",
      arguments: { title: "", feature_name: "f", problems: "", solution: "s", result: "r" },
    })) as any;
    expect(res.content[0].text).toMatch(/수정|필수/);
  });
});
