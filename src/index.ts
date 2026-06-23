#!/usr/bin/env node
/**
 * 취몽 MCP 서버 진입점 — stdio 트랜스포트.
 * (전역 설치 후 .mcp.json 의 `npx chwijung-mcp` (= chwijung-mcp serve)가 이 파일을 실행한다.)
 */

import { runStdioServer } from "./serve.js";

runStdioServer().catch((err) => {
  // stdout은 MCP 프로토콜 전용이므로 오류는 stderr로
  console.error("chwijung-mcp fatal:", err);
  process.exit(1);
});
