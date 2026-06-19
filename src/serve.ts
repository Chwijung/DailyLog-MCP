/**
 * MCP stdio 서버 실행 로직 — index.ts(직접 진입)와 cli.ts(서브커맨드)에서 공유.
 * stdout은 MCP 프로토콜 전용이므로 이 모듈은 로그를 stdout에 쓰지 않는다.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "./server.js";

export async function runStdioServer(): Promise<void> {
  const server = new McpServer({ name: "chwijung", version: "0.1.0" });
  registerTools(server);
  await server.connect(new StdioServerTransport());
}
