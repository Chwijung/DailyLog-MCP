#!/usr/bin/env node
/**
 * 취몽 MCP CLI 진입점.
 *
 *   chwijung-mcp [serve]      MCP stdio 서버 실행 (인자 없으면 기본값; npx/MCP 호스트가 사용)
 *   chwijung-mcp login        터미널에서 이메일/비밀번호로 로그인하고 세션을 캐시
 *   chwijung-mcp connect <코드> 웹 'MCP 연결'에서 발급한 연결 코드로 세션을 캐시(터미널 비번 입력 불필요)
 *   chwijung-mcp logout       캐시된 세션 삭제
 *   chwijung-mcp whoami       현재 로그인 상태 출력
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
import { clearSession, isAccessValid, loadSession } from "./session.js";
import { runStdioServer } from "./serve.js";

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
    io.log(
      `로그인 성공: ${name}님 (cohort: ${session.cohort_id}). ` +
        "이제 개발 세션을 마칠 때 submit_daily_log 로 데일리 로그가 자동 등록됩니다.",
    );
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
    io.log(
      `연결 성공: ${name}님 (cohort: ${session.cohort_id}). ` +
        "이제 개발 세션을 마칠 때 submit_daily_log 로 데일리 로그가 자동 등록됩니다.",
    );
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
    io.log("로그인되어 있지 않습니다. `npx chwijung-mcp login` 을 실행하세요.");
    return 1;
  }
  const name = session.user.full_name || session.user.email || "사용자";
  const tokenState = isAccessValid(session)
    ? "유효"
    : "만료(다음 호출 시 자동 갱신 또는 재로그인 필요)";
  io.log(
    `로그인됨: ${name} (역할: ${session.user.role}, cohort: ${session.cohort_id}, 토큰: ${tokenState})`,
  );
  return 0;
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

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "serve":
      await runStdioServer();
      return;
    case "login":
      process.exit(await loginCommand(realIO));
      return;
    case "connect":
      process.exit(await connectCommand(realIO, process.argv[3] ?? ""));
      return;
    case "logout":
      process.exit(await logoutCommand(realIO));
      return;
    case "whoami":
      process.exit(await whoamiCommand(realIO));
      return;
    default:
      process.stderr.write(
        `알 수 없는 명령: ${cmd}\n사용법: chwijung-mcp [serve|login|connect <코드>|logout|whoami]\n`,
      );
      process.exit(2);
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
  main().catch((err) => {
    console.error("chwijung-mcp fatal:", err);
    process.exit(1);
  });
}
