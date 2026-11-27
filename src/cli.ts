#!/usr/bin/env node
/**
 * 취몽 MCP CLI 진입점.
 *
 *   chwijung-mcp [serve]      MCP stdio 서버 실행 (인자 없으면 기본값; npx/MCP 호스트가 사용)
 *   chwijung-mcp login        터미널에서 이메일/비밀번호로 로그인하고 세션을 캐시
 *   chwijung-mcp connect <코드> 웹 'MCP 연결'에서 발급한 연결 코드로 세션을 캐시(터미널 비번 입력 불필요)
 *   chwijung-mcp logout       캐시된 세션 삭제
 *   chwijung-mcp whoami       현재 로그인 상태 출력
 *   chwijung-mcp uninstall [-y] 전역 명령·토큰·MCP 설정·레포 폴더를 한 번에 삭제
 *   chwijung-mcp hooks install [--global] [-y]  AI 대화 기록 hook 켜기 (기본: 현재 폴더의 settings.local.json)
 *   chwijung-mcp hooks uninstall [--project|--global|--all]  끄기 (기본: 현재 폴더 + 전역)
 *   chwijung-mcp hooks exclude | include       현재 폴더(와 하위 폴더)를 수집에서 빼기/되돌리기
 *   chwijung-mcp hooks status                  hook 설치 위치·제외 폴더·보내지 못한 기록 수
 *   chwijung-mcp hook --agent <claude|codex>   (AI 도구가 실행) stdin hook 입력을 기록
 *
 * 보안: 비밀번호는 AI/LLM이 아니라 사람이 터미널에 직접 입력한다(에코 숨김).
 * 비밀번호는 LLM 대화/MCP 로그에 남지 않으며, 토큰만 ~/.chwijung/session.json 에 캐시된다.
 */

import { realpathSync } from "node:fs";
import readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as auth from "./auth.js";
import { BackendError, ChwijungClient } from "./client.js";
import { getBaseUrl } from "./config.js";
import { countPending, userChatDir } from "./chat/spool.js";
import { hookCommand, readStdin } from "./hook.js";
import {
  claudeSettingsPath,
  ensureGitIgnored,
  hookCommandLine,
  installClaudeHooks,
  listInstalledHooks,
  uninstallClaudeHooks,
  uninstallFolderHooks,
} from "./hooks-install.js";
import {
  addExcluded,
  addProject,
  excludedBy,
  loadScope,
  removeExcluded,
  removeProjects,
  samePath,
  scopeFile,
} from "./chat/scope.js";
import { clearSession, isAccessValid, loadSession } from "./session.js";
import { runStdioServer } from "./serve.js";
import { type UninstallOptions, uninstall } from "./uninstall.js";
import { checkAndUpdate } from "./update.js";

export interface CliIO {
  readEmail: () => Promise<string>;
  readPassword: () => Promise<string>;
  log: (msg: string) => void;
}

function makeClient(): ChwijungClient {
  return new ChwijungClient(getBaseUrl());
}

/** login 서브커맨드 핵심 로직(테스트에서 IO/클라이언트 주입 가능). 종료코드 반환. */
export async function loginCommand(
  io: CliIO,
  client: ChwijungClient = makeClient(),
): Promise<number> {
  const email = (await io.readEmail()).trim();
  const password = await io.readPassword();
  if (!email || !password) {
    io.log("이메일과 비밀번호를 모두 입력해야 합니다.");
    return 1;
  }
  try {
    const session = await auth.loginAndStore(client, email, password);
    const name = session.user.full_name || session.user.email || "사용자";
    io.log(`로그인 완료: ${name}님`);
    return 0;
  } catch (err) {
    if (err instanceof auth.NotStudentError) {
      io.log(`로그인 실패: ${err.message}`);
      return 1;
    }
    const message = err instanceof BackendError ? err.message : String(err);
    io.log(`로그인 실패: ${message}`);
    return 1;
  }
}

/** connect 서브커맨드: 웹에서 발급한 연결 코드로 세션을 캐시. 종료코드 반환. */
export async function connectCommand(
  io: Pick<CliIO, "log">,
  code: string,
  client: ChwijungClient = makeClient(),
): Promise<number> {
  const trimmed = (code ?? "").trim();
  if (!trimmed) {
    io.log(
      "연결 코드가 필요합니다. 웹 'MCP 연결'에서 발급한 코드로 아래처럼 실행하세요:\n" +
        "    npx chwijung-mcp connect <코드>",
    );
    return 1;
  }
  try {
    const session = await auth.connectAndStore(client, trimmed);
    const name = session.user.full_name || session.user.email || "사용자";
    io.log(`연결 완료: ${name}님`);
    return 0;
  } catch (err) {
    if (err instanceof auth.NotStudentError) {
      io.log(`연결 실패: ${err.message}`);
      return 1;
    }
    const message = err instanceof BackendError ? err.message : String(err);
    io.log(`연결 실패: ${message}`);
    return 1;
  }
}

/** logout 서브커맨드: 캐시된 세션 삭제. */
export async function logoutCommand(io: Pick<CliIO, "log">): Promise<number> {
  await clearSession();
  io.log("로그아웃되었습니다(캐시된 세션을 삭제했습니다).");
  return 0;
}

/** whoami 서브커맨드: 현재 로그인 상태 출력. */
export async function whoamiCommand(io: Pick<CliIO, "log">): Promise<number> {
  const session = await loadSession();
  if (!session) {
    io.log("로그인되어 있지 않습니다. `chwijung-mcp login` 을 실행하세요.");
    return 1;
  }
  const name = session.user.full_name || session.user.email || "사용자";
  const tokenState = isAccessValid(session)
    ? "유효"
    : "만료(다음 호출 시 자동 갱신 또는 재로그인 필요)";
  io.log(`로그인됨: ${name} (토큰: ${tokenState})`);
  return 0;
}

/**
 * uninstall 서브커맨드: 전역 명령·토큰 캐시·MCP 설정·레포 폴더를 한 번에 삭제.
 * 파괴적이므로 기본은 확인을 받고, opts.yes(=-y/--yes)면 확인을 건너뛴다.
 * (confirm/doUninstall은 테스트에서 주입 가능 — 기본값은 실제 동작.)
 */
export async function uninstallCommand(
  io: Pick<CliIO, "log">,
  opts: { yes?: boolean } = {},
  confirm: () => Promise<boolean> = realConfirm,
  doUninstall: (o: UninstallOptions) => Promise<void> = uninstall,
): Promise<number> {
  if (!opts.yes) {
    const ok = await confirm();
    if (!ok) {
      io.log("취소되었습니다.");
      return 0;
    }
  }
  await doUninstall({ log: io.log });
  return 0;
}

export const CHAT_CONSENT_NOTICE = [
  "AI 대화 기록(Claude Code)을 취몽으로 보냅니다.",
  "  보내는 것: 내가 입력한 프롬프트 원문, AI가 쓴 도구 이름(Bash·Edit 등), 응답이 끝난 시각, 작업 폴더 이름",
  "  보내지 않는 것: 도구 입력·출력, 파일 내용, 전체 경로",
  "  프롬프트 안의 API 키·토큰·비밀번호 값은 보내기 전에 [MASKED]로 가립니다(흔한 형식만).",
  "  코치·운영진이 학습 기록으로 볼 수 있습니다. 끄려면: chwijung-mcp hooks uninstall",
].join("\n");

export interface HooksDeps {
  cwd?: string;
  home?: string;
  command?: string;
  confirm?: () => Promise<boolean>;
}

/** hooks install|uninstall|status 서브커맨드. 종료코드 반환. */
export async function hooksCommand(
  io: Pick<CliIO, "log">,
  args: string[],
  deps: HooksDeps = {},
): Promise<number> {
  const sub = args[0];
  const has = (flag: string): boolean => args.includes(flag);
  const yes = has("-y") || has("--yes");
  const cwd = resolve(deps.cwd ?? process.cwd());
  const local = claudeSettingsPath("local", cwd, deps.home);
  const legacy = claudeSettingsPath("project", cwd, deps.home);
  const globalPath = claudeSettingsPath("global", cwd, deps.home);
  const scopePath = scopeFile(deps.home);

  if (sub === "install") {
    const global = has("--global");
    const session = await loadSession();
    if (!session) {
      io.log("먼저 로그인하세요: chwijung-mcp connect <코드> 또는 chwijung-mcp login");
      return 1;
    }
    io.log(CHAT_CONSENT_NOTICE);
    io.log(
      global
        ? "\n범위: 이 PC의 모든 Claude Code 대화 (빼고 싶은 폴더는 그 폴더에서 chwijung-mcp hooks exclude)"
        : `\n범위: 이 폴더에서 연 Claude Code 대화만 (${cwd})\n` +
            "  (macOS·Linux에서 이 폴더가 git 저장소 맨 위 폴더면 하위 폴더에서 연 대화도 포함됩니다)",
    );
    if (!yes) {
      const ok = await (deps.confirm ?? realConfirmChat)();
      if (!ok) {
        io.log("취소되었습니다.");
        return 0;
      }
    }
    const path = global ? globalPath : local;
    try {
      const state = await installClaudeHooks(path, deps.command ?? hookCommandLine("claude"));
      io.log(state === "already" ? `이미 켜져 있습니다: ${path}` : `켰습니다: ${path}`);
      if (!global) {
        await addProject(cwd, scopePath);
        if (await uninstallClaudeHooks(legacy)) {
          io.log(`예전 위치의 hook을 지웠습니다: ${legacy} (이 파일을 커밋했다면 바뀐 내용도 커밋하세요)`);
        }
        const ignore = await ensureGitIgnored(path);
        if (ignore === "added") io.log("git에 올라가지 않게 .git/info/exclude 에 추가했습니다 (이 PC에만 적용).");
        if (ignore === "failed") {
          io.log(`주의: ${path} 를 git 무시 목록에 넣지 못했습니다. 커밋하지 마세요 (.gitignore에 추가 권장).`);
        }
      }
      const scope = await loadScope(scopePath);
      const ex = excludedBy(cwd, scope);
      if (ex && !global && samePath(ex, cwd)) {
        await removeExcluded(ex, scopePath);
        io.log("이 폴더를 수집 제외 목록에서 뺐습니다.");
      } else if (ex) {
        io.log(`참고: 이 폴더는 수집 제외 중입니다 (${ex}). 다시 받으려면 그 폴더에서 chwijung-mcp hooks include`);
      }
      io.log("Claude Code를 다시 시작하면 적용됩니다. 확인: chwijung-mcp hooks status");
      return 0;
    } catch (err) {
      io.log(`설치 실패: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (sub === "uninstall") {
    const onlyGlobal = has("--global");
    const onlyProject = has("--project");
    const all = has("--all");
    const scope = await loadScope(scopePath);
    const folders = all ? [cwd, ...scope.projects] : onlyGlobal ? [] : [cwd];
    const removed: string[] = [];
    try {
      for (const folder of folders) removed.push(...(await uninstallFolderHooks(folder)));
      if (all || !onlyProject) {
        if (await uninstallClaudeHooks(globalPath)) removed.push(globalPath);
      }
      if (folders.length > 0) await removeProjects(folders, scopePath);
    } catch (err) {
      io.log(`끄기 실패: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    io.log(removed.length ? `껐습니다:\n  ${removed.join("\n  ")}` : "켜져 있는 곳이 없습니다.");
    if (!all) {
      const others = scope.projects.filter((p) => !samePath(p, cwd));
      if (others.length > 0) {
        io.log(`다른 폴더에도 켜져 있을 수 있습니다 (${others.length}곳). 모두 끄려면: chwijung-mcp hooks uninstall --all`);
      }
    }
    return 0;
  }

  if (sub === "exclude" || sub === "include") {
    try {
      if (sub === "exclude") {
        await addExcluded(cwd, scopePath);
        io.log(`이 폴더(와 하위 폴더)에서 연 대화는 수집하지 않습니다: ${cwd}`);
        io.log("다시 받으려면: chwijung-mcp hooks include");
      } else {
        const scope = await loadScope(scopePath);
        if (!scope.excluded.some((p) => samePath(p, cwd))) {
          const ex = excludedBy(cwd, scope);
          io.log(ex ? `상위 폴더가 제외되어 있습니다: ${ex} — 그 폴더에서 include 하세요.` : "이 폴더는 제외되어 있지 않습니다.");
          return 0;
        }
        await removeExcluded(cwd, scopePath);
        io.log(`이 폴더를 수집 제외 목록에서 뺐습니다: ${cwd}`);
      }
      return 0;
    } catch (err) {
      io.log(`실패: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (sub === "status") {
    const show = async (label: string, path: string): Promise<void> => {
      const events = await listInstalledHooks(path);
      io.log(`${label}: ${events.length ? `켜짐 (${events.join(", ")})` : "꺼짐"} — ${path}`);
    };
    await show("이 폴더", local);
    if ((await listInstalledHooks(legacy)).length > 0) {
      io.log(`이 폴더(예전 위치): 켜짐 — ${legacy}`);
      io.log("  팀이 커밋하는 파일이라 팀원에게도 퍼질 수 있습니다. chwijung-mcp hooks install 로 옮기세요.");
    }
    await show("전역", globalPath);
    const scope = await loadScope(scopePath);
    const others = scope.projects.filter((p) => !samePath(p, cwd));
    for (const p of others) io.log(`다른 폴더: ${p}`);
    const ex = excludedBy(cwd, scope);
    if (ex) io.log(`이 폴더는 수집 안 함 (제외: ${ex})`);
    for (const p of scope.excluded.filter((x) => x !== ex)) io.log(`수집 안 함: ${p}`);
    const dir = userChatDir((await loadSession())?.user.id);
    const pending = dir ? await countPending(dir) : 0;
    io.log(`보내지 못한 기록: ${pending}건 (다음 응답이 끝날 때 다시 보냅니다)`);
    return 0;
  }

  io.log(
    "사용법: chwijung-mcp hooks <install [--global] [-y] | uninstall [--project | --global | --all] | exclude | include | status>",
  );
  return 2;
}

// ==================== 실제 터미널 입출력 ====================

// 제어 문자 코드
const CR = 13; // \r
const LF = 10; // \n
const EOT = 4; // Ctrl-D
const ETX = 3; // Ctrl-C
const BS = 8; // \b
const DEL = 127;

function question(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(query, (answer) => {
      rl.close();
      res(answer);
    }),
  );
}

/** 에코 없이 비밀번호 입력. TTY가 아니면 CHWIJUNG_PASSWORD 환경변수로 대체. */
function questionHidden(query: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const env = process.env.CHWIJUNG_PASSWORD;
    if (env) return Promise.resolve(env);
    // 비TTY 환경: 일반 입력(에코됨)으로 폴백
    return question(query);
  }
  return new Promise((res, rej) => {
    const stdout = process.stdout;
    stdout.write(query);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };
    const onData = (data: Buffer): void => {
      for (const code of data) {
        if (code === CR || code === LF || code === EOT) {
          finish();
          res(buf);
          return;
        }
        if (code === ETX) {
          finish();
          rej(new Error("입력이 취소되었습니다."));
          return;
        }
        if (code === BS || code === DEL) {
          buf = buf.slice(0, -1);
        } else if (code >= 0x20) {
          buf += String.fromCharCode(code);
        }
      }
    };
    stdin.on("data", onData);
  });
}

const realIO: CliIO = {
  readEmail: () => question("취몽 이메일: "),
  readPassword: () => questionHidden("비밀번호(입력 숨김): "),
  log: (msg: string) => process.stdout.write(`${msg}\n`),
};

/** uninstall 확인 프롬프트. y/Y로 시작해야 진행. 비TTY/빈 입력은 취소(false)로 본다. */
async function realConfirm(): Promise<boolean> {
  const answer = await question(
    "전역 명령·토큰·MCP 설정·레포 폴더를 모두 삭제합니다. 계속할까요? (y/N): ",
  );
  return /^y/i.test(answer.trim());
}

async function realConfirmChat(): Promise<boolean> {
  const answer = await question("위 내용에 동의하고 켤까요? (y/N): ");
  return /^y/i.test(answer.trim());
}

/**
 * 서브커맨드를 실행하고 종료코드를 반환한다.
 *
 * 주의: 여기서 `process.exit()`를 직접 호출하지 않는다. 출력을 파이프나 파일로
 * 리다이렉트한 경우, stdout 버퍼가 비워지기 전에 프로세스가 종료되어 메시지가
 * 잘릴 수 있다(Node에서 `process.exit()`는 대기 중인 쓰기를 기다리지 않는다).
 * 대신 종료코드만 반환하고, 진입점에서 `process.exitCode`로 설정해 자연 종료시킨다.
 */
async function main(): Promise<number> {
  const cmd = process.argv[2];
  // uninstall 직전에 자동 업데이트(git pull + install -g)가 돌면 *삭제 직전 재설치*가 되므로 제외.
  // hook은 AI 도구가 이벤트마다 실행하므로 업데이트 확인(네트워크·git pull)을 하면 작업이 멈춘다.
  if (cmd !== undefined && cmd !== "serve" && cmd !== "uninstall" && cmd !== "hook") {
    await checkAndUpdate();
  }
  switch (cmd) {
    case undefined:
    case "serve":
      await runStdioServer();
      return 0;
    case "login":
      return loginCommand(realIO);
    case "connect":
      return connectCommand(realIO, process.argv[3] ?? "");
    case "logout":
      return logoutCommand(realIO);
    case "whoami":
      return whoamiCommand(realIO);
    case "uninstall":
      return uninstallCommand(realIO, {
        yes: process.argv.includes("--yes") || process.argv.includes("-y"),
      });
    case "hooks":
      return hooksCommand(realIO, process.argv.slice(3));
    case "hook": {
      const i = process.argv.indexOf("--agent");
      const agent = process.argv[i + 1] === "codex" ? "codex" : "claude";
      return hookCommand(await readStdin(), { agent });
    }
    default:
      process.stderr.write(
        `알 수 없는 명령: ${cmd}\n` +
          `사용법: chwijung-mcp [serve|login|connect <코드>|logout|whoami|uninstall [-y]|hooks <install|uninstall|exclude|include|status>]\n`,
      );
      return 2;
  }
}

/** 경로의 심볼릭/junction 링크를 실제 경로로 해석한다. 실패하면 입력을 그대로 반환. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 이 파일이 직접 실행된 진입점인지(테스트 import가 아니라) 판별.
 * 전역 설치(`npm install -g .` / `npm link`)는 글로벌 node_modules를 소스 폴더로 가리키는
 * symlink/junction을 만든다. 이때 `process.argv[1]`은 symlink 경로, `import.meta.url`은
 * 실제 경로로 해석돼 단순 비교가 어긋난다 → 양쪽 모두 realpath로 풀어 비교한다.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const canonical = (p: string): string => {
    try {
      return realpathSync(p).toLowerCase();
    } catch {
      return resolve(p).toLowerCase();
    }
  };
  try {
    return canonical(fileURLToPath(import.meta.url)) === canonical(entry);
  } catch {
    return false;
  }
}

if (!process.env.VITEST && isEntryPoint()) {
  // process.exit()를 피하고 종료코드만 설정한다 → 이벤트 루프가 비면서
  // 대기 중인 stdout 쓰기가 끝난 뒤 그 코드로 자연 종료된다(출력 잘림 방지).
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("chwijung-mcp fatal:", err);
      process.exitCode = 1;
    });
}
