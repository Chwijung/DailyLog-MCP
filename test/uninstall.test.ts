import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeJsonMcpEntry, uninstall } from "../src/uninstall.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-uninstall-"));
});

afterEach(() => {
  delete process.env.CHWIJUNG_SESSION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("removeJsonMcpEntry", () => {
  it("chwijung 항목만 제거하고 다른 서버는 보존", async () => {
    const file = join(dir, ".mcp.json");
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { chwijung: { command: "npx" }, other: { command: "x" } } }),
      "utf-8",
    );
    expect(await removeJsonMcpEntry(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.mcpServers.chwijung).toBeUndefined();
    expect(data.mcpServers.other).toBeDefined();
  });

  it("항목이 없으면 false (파일 변경 없음)", async () => {
    const file = join(dir, ".mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: {} } }), "utf-8");
    expect(await removeJsonMcpEntry(file)).toBe(false);
  });

  it("파일이 없으면 false", async () => {
    expect(await removeJsonMcpEntry(join(dir, "nope.json"))).toBe(false);
  });

  it("손상된 JSON은 건드리지 않고 false", async () => {
    const file = join(dir, ".mcp.json");
    writeFileSync(file, "{ not json", "utf-8");
    expect(await removeJsonMcpEntry(file)).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe("{ not json");
  });
});

describe("uninstall", () => {
  it("전역 제거·MCP CLI·세션·레포 폴더를 처리하고 JSON 항목을 제거", async () => {
    // 토큰 캐시(세션) — CHWIJUNG_SESSION_FILE 로 임시 경로 주입
    const sessionDir = join(dir, ".chwijung");
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, "session.json");
    writeFileSync(sessionPath, "{}", "utf-8");
    process.env.CHWIJUNG_SESSION_FILE = sessionPath;

    // 레포 폴더(레포 밖 cwd)
    const repoRoot = join(dir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "file.txt"), "x", "utf-8");
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });

    // JSON MCP 설정
    const cfg = join(dir, ".mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { chwijung: {} } }), "utf-8");

    const ran: string[] = [];
    await uninstall({
      run: (cmd) => ran.push(cmd),
      repoRoot,
      cwd,
      home: dir,
      jsonConfigPaths: [cfg],
      log: () => {},
    });

    expect(ran).toContain("npm uninstall -g chwijung-mcp");
    expect(ran).toContain("claude mcp remove chwijung");
    expect(ran).toContain("codex mcp remove chwijung");
    expect(existsSync(sessionDir)).toBe(false); // 토큰 캐시 폴더 삭제
    expect(existsSync(repoRoot)).toBe(false); // 레포 폴더 삭제
    expect(JSON.parse(readFileSync(cfg, "utf-8")).mcpServers.chwijung).toBeUndefined();
  });

  it("cwd가 레포 내부면 레포 폴더를 삭제하지 않음", async () => {
    process.env.CHWIJUNG_SESSION_FILE = join(dir, ".chwijung", "session.json");
    const repoRoot = join(dir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const cwd = join(repoRoot, "build");
    mkdirSync(cwd, { recursive: true });

    await uninstall({
      run: () => {},
      repoRoot,
      cwd,
      home: dir,
      jsonConfigPaths: [],
      log: () => {},
    });

    expect(existsSync(repoRoot)).toBe(true); // 자기 자신 삭제 가드
  });

  it("한 단계(전역 제거)가 실패해도 나머지 단계는 계속 진행", async () => {
    process.env.CHWIJUNG_SESSION_FILE = join(dir, ".chwijung", "session.json");
    const repoRoot = join(dir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });

    await uninstall({
      run: (cmd) => {
        if (cmd.startsWith("npm")) throw new Error("npm not found");
      },
      repoRoot,
      cwd,
      home: dir,
      jsonConfigPaths: [],
      log: () => {},
    });

    expect(existsSync(repoRoot)).toBe(false); // npm 실패에도 레포 폴더는 삭제됨
  });

  it("CHWIJUNG_SESSION_FILE override가 .chwijung 밖을 가리켜도 그 부모를 삭제하지 않음", async () => {
    // override를 .chwijung이 아닌 'elsewhere' 아래로 둔다. 과거엔 dirname(sessionFile())로
    // 이 부모(elsewhere)가 통째로 지워졌다 — 이제 join(home, ".chwijung")만 삭제 대상.
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const sentinel = join(elsewhere, "keep.txt");
    writeFileSync(sentinel, "keep", "utf-8");
    process.env.CHWIJUNG_SESSION_FILE = join(elsewhere, "session.json");

    const repoRoot = join(dir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const cwd = join(dir, "outside");
    mkdirSync(cwd, { recursive: true });

    await uninstall({
      run: () => {},
      repoRoot,
      cwd,
      home: dir,
      jsonConfigPaths: [],
      log: () => {},
    });

    expect(existsSync(elsewhere)).toBe(true); // override의 부모는 삭제되지 않음
    expect(existsSync(sentinel)).toBe(true); // 그 안의 파일도 그대로 남음
  });
});
