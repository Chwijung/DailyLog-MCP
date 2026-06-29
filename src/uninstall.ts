/**
 * 한 번에 삭제(uninstall) 절차.
 *
 * 설치/사용이 남긴 흔적을 되돌린다:
 *   1. AI 도구 MCP 설정의 `chwijung` 서버 항목
 *   2. 토큰 캐시 ~/.chwijung
 *   3. 전역 명령 `chwijung-mcp` (npm install -g . 으로 등록)
 *   4. 클론한 레포 폴더
 *
 * 설계: 모든 외부 작용(셸 실행·파일 삭제·경로)을 주입 가능한 seam으로 두어
 * 테스트에서 실제 npm 호출이나 삭제가 일어나지 않도록 한다.
 * 각 단계는 독립적으로 try/catch 하여, 한 단계가 실패해도 다음 단계를 계속 진행하고
 * 자동 처리하지 못한 부분은 수동 정리 명령을 안내한다.
 */

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { clearSession, sessionFile } from "./session.js";

/** npm 전역 패키지명 / MCP 서버 등록 이름 */
const PKG = "chwijung-mcp";
const SERVER = "chwijung";

export interface UninstallOptions {
  /** 셸 명령 실행기(실패 시 throw). 테스트에서 스파이로 대체. */
  run?: (cmd: string) => void;
  /** 삭제할 레포 루트. 기본은 이 모듈 위치 기준으로 계산. */
  repoRoot?: string;
  /** 자기 자신(레포 내부) 삭제 가드용 현재 작업 디렉터리. */
  cwd?: string;
  /** 홈 디렉터리(JSON 설정 경로 계산용). */
  home?: string;
  /** 정리할 JSON MCP 설정 파일 경로 목록. */
  jsonConfigPaths?: string[];
  /** 진행 로그 출력. 기본은 stdout. */
  log?: (msg: string) => void;
}

/** build/uninstall.js 위치에서 한 단계 올라가면 레포 루트 (update.ts와 동일 방식) */
export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** 결정적 경로의 JSON MCP 설정 목록(현재 폴더 + 사용자 전역). */
export function defaultJsonConfigPaths(cwd: string, home: string): string[] {
  return [
    join(cwd, ".mcp.json"), // Claude Code (프로젝트)
    join(cwd, ".cursor", "mcp.json"), // Cursor (프로젝트)
    join(home, ".cursor", "mcp.json"), // Cursor (전역)
    join(home, ".gemini", "config", "mcp_config.json"), // Antigravity
  ];
}

function defaultRun(cmd: string): void {
  // 자격증명/머지 프롬프트로 멈추지 않도록 비대화형 + 타임아웃. stdout은 캡처(pipe).
  execSync(cmd, {
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function stdoutLog(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/** child가 parent와 같거나 그 하위 경로인지(대/소문자 무시 — Windows 안전). */
function isInside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * JSON MCP 설정에서 `mcpServers.chwijung` 항목을 제거한다.
 * 제거했으면 true. 파일이 없거나 해당 항목이 없거나 파싱 실패면 false(다른 항목은 보존).
 */
export async function removeJsonMcpEntry(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return false; // 파일 없음
  }
  let data: { mcpServers?: Record<string, unknown> };
  try {
    data = JSON.parse(raw);
  } catch {
    return false; // 손상된 JSON은 건드리지 않음
  }
  if (!data?.mcpServers || !(SERVER in data.mcpServers)) return false;
  delete data.mcpServers[SERVER];
  try {
    await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 전체 언인스톨 절차를 실행한다.
 * 각 단계는 실패해도 다음 단계로 진행하며, 자동 처리 못 한 부분은 수동 안내를 출력한다.
 */
export async function uninstall(opts: UninstallOptions = {}): Promise<void> {
  const run = opts.run ?? defaultRun;
  const log = opts.log ?? stdoutLog;
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const jsonConfigPaths = opts.jsonConfigPaths ?? defaultJsonConfigPaths(cwd, home);

  log("취몽 MCP 삭제를 시작합니다...\n");

  // 1) MCP 설정에서 chwijung 항목 제거
  log("1) MCP 설정 정리");
  for (const [tool, cmd] of [
    ["Claude Code", `claude mcp remove ${SERVER}`],
    ["Codex", `codex mcp remove ${SERVER}`],
  ] as const) {
    try {
      run(cmd);
      log(`   - ${tool}: '${SERVER}' 항목 제거 (${cmd})`);
    } catch {
      // CLI 미설치 등은 무시 — 아래 JSON/수동 안내로 보완
    }
  }
  for (const path of jsonConfigPaths) {
    try {
      if (await removeJsonMcpEntry(path)) {
        log(`   - ${path}: '${SERVER}' 항목 제거`);
      }
    } catch {
      // 개별 파일 실패는 무시
    }
  }
  log(
    "   ※ 다른 프로젝트 폴더의 .mcp.json / .cursor/mcp.json 항목은 자동 탐지되지 않습니다 — 직접 제거하세요.\n" +
      `   ※ Codex CLI가 없으면 ~/.codex/config.toml 의 [mcp_servers.${SERVER}] 블록을 직접 삭제하세요.\n`,
  );

  // 2) 토큰 캐시(~/.chwijung) 제거
  log("2) 토큰 캐시 삭제");
  try {
    await clearSession();
    const dir = dirname(sessionFile());
    await fs.rm(dir, { recursive: true, force: true });
    log(`   - ${dir} 삭제 완료\n`);
  } catch (err) {
    log(`   - 토큰 캐시 삭제 실패: ${errMsg(err)}\n`);
  }

  // 3) 전역 명령 제거
  log("3) 전역 명령 제거");
  try {
    run(`npm uninstall -g ${PKG}`);
    log(`   - 전역 명령 '${PKG}' 제거 완료\n`);
  } catch (err) {
    log(
      `   - 전역 명령 제거 실패: ${errMsg(err)}\n` +
        `     수동: npm uninstall -g ${PKG}\n`,
    );
  }

  // 4) 레포 폴더 제거(마지막) — 실행 중 프로세스가 레포 안에 있으면 자기 자신을 못 지움
  log("4) 레포 폴더 삭제");
  if (isInside(cwd, repoRoot)) {
    log(
      `   - 현재 폴더가 레포 내부(${repoRoot})라 자동 삭제를 건너뜁니다.\n` +
        `     레포 밖으로 이동한 뒤 직접 삭제하세요: rm -rf "${repoRoot}"\n`,
    );
  } else {
    try {
      await fs.rm(repoRoot, { recursive: true, force: true });
      log(`   - ${repoRoot} 삭제 완료\n`);
    } catch (err) {
      log(
        `   - 레포 폴더 삭제 실패(${errMsg(err)}) — 파일 잠금 가능성.\n` +
          `     수동: rm -rf "${repoRoot}"\n`,
      );
    }
  }

  log("취몽 MCP 삭제가 끝났습니다. 위 안내된 수동 정리 항목이 있으면 마저 처리하세요.");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
