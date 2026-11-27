/**
 * GitHub Releases API로 최신 버전을 확인하고 구버전이면 자동으로 업데이트한 뒤
 * 프로세스를 재실행(re-exec)한다.
 *
 * - 리포지토리 루트: import.meta.url 기준으로 build/ 의 부모 디렉터리를 사용
 *   (npm install -g . 은 Windows 에서 junction, Unix 에서 symlink 를 만드는데
 *    node 는 realpath 로 해석하므로 항상 실제 클론 위치를 가리킨다)
 * - stdout 은 MCP 프로토콜 전용이므로 이 모듈은 stderr 만 사용한다.
 * - 자동 업데이트 후 CHWIJUNG_UPDATED=1 환경 변수를 설정하고 re-exec 해
 *   무한 루프를 방지한다.
 */

import { execSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL =
  "https://api.github.com/repos/Chwijung/DailyLog-MCP/releases/latest";

/** build/update.js 위치에서 한 단계 올라가면 리포지토리 루트 */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** git 리포지토리인지 확인 (비정상적 설치 환경 방어) */
function isGitRepo(root: string): boolean {
  return existsSync(resolve(root, ".git"));
}

/**
 * 디스크의 package.json 버전을 읽는다. git pull 이후의 실제 소스 버전을 반영한다.
 * 실패하면 null.
 */
export function readInstalledVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

/** 실패한 업데이트를 다시 시도하기까지의 간격. MCP를 켤 때마다 설치·빌드를 반복하지 않게 한다. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** build/ 안의 기록 파일을 읽는다. 없거나 손상됐으면 null. */
function readRecord<T>(root: string, name: string): T | null {
  try {
    return JSON.parse(readFileSync(resolve(root, "build", name), "utf8")) as T | null;
  } catch {
    return null;
  }
}

function writeRecord(root: string, name: string, value: unknown): void {
  try {
    writeFileSync(resolve(root, "build", name), JSON.stringify(value));
  } catch {
    // 기록하지 못해도 업데이트는 계속한다.
  }
}

/** build/ 를 만든 소스 버전과 시각. scripts/write-build-version.mjs 가 기록한다. */
interface BuildRecord {
  version: string;
  builtAt: string;
}

interface Release {
  version: string;
  publishedAt: string | undefined;
}

/**
 * 설치된 빌드가 최신 릴리스인지 판단한다. package.json 은 소스만 받아도 바뀌므로 쓰지 않는다.
 * 릴리스 전에 같은 버전으로 만든 빌드에는 그 뒤 커밋이 빠졌을 수 있어 최신으로 보지 않는다.
 * 자동 업데이트를 마친 릴리스는 .release 에 남겨, PC 시계가 늦어도 반복하지 않는다.
 */
function isUpToDate(root: string, release: Release, build: BuildRecord | null): boolean {
  if (readRecord<string>(root, ".release") === release.version && build?.version === release.version) {
    return true;
  }
  if (build?.version !== release.version) return false;
  if (!release.publishedAt) return true;
  return Date.parse(build.builtAt) >= Date.parse(release.publishedAt);
}

/** 같은 릴리스의 업데이트를 최근에 시도했는지(실패했거나 다른 프로세스가 진행 중). */
function attemptedRecently(root: string, version: string): boolean {
  const last = readRecord<{ version: string; at: number }>(root, ".update-attempt");
  if (last?.version !== version) return false;
  const elapsed = Date.now() - last.at;
  return elapsed >= 0 && elapsed < RETRY_INTERVAL_MS;
}

/**
 * 이 시간보다 오래된 잠금은 중단된 업데이트가 남긴 것으로 본다.
 * 업데이트 명령 타임아웃의 합(약 8분)보다 길게 잡는다.
 */
const LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * 같은 저장소를 여러 프로세스(MCP 세션·CLI)가 동시에 업데이트하지 못하게 build/.update-lock 을
 * 배타적으로 만든다. 잠금을 잡으면 해제 함수를, 다른 프로세스가 잡고 있으면 null 을 돌려준다.
 * build/ 가 없는 등 잠금 파일을 만들 수 없으면 잠금 없이 진행한다(기존 동작 유지).
 */
function acquireLock(root: string): (() => void) | null {
  const path = resolve(root, "build", ".update-lock");
  const release = (): void => {
    try {
      unlinkSync(path);
    } catch {
      // 이미 지워졌으면 그만이다.
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx"));
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return () => {};
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // 그 사이 풀렸으면 다시 시도한다.
      }
      if (age < LOCK_STALE_MS) return null;
      release();
    }
  }
  return null;
}

/** 비대화형(GIT_TERMINAL_PROMPT=0)·ff-only·타임아웃으로 프롬프트나 네트워크 정지에 의한 무기한 블록을 막는다. */
function runGitPull(root: string): void {
  execSync("git pull --ff-only", {
    cwd: root,
    stdio: "pipe",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * git pull. npm install 이 바꿔 놓은 package-lock.json 이 pull 을 막았고,
 * 바뀐 파일이 그것뿐이면 되돌리고 한 번 더 받는다.
 */
function pullSource(root: string): void {
  try {
    runGitPull(root);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown } | null)?.stderr ?? "");
    if (!stderr.includes("package-lock.json")) throw err;
    const changed = String(
      execSync("git status --porcelain --untracked-files=no", {
        cwd: root,
        stdio: "pipe",
        timeout: 30_000,
      }),
    ).trimEnd();
    if (changed.slice(3) !== "package-lock.json") throw err;
    execSync("git checkout HEAD -- package-lock.json", { cwd: root, stdio: "pipe", timeout: 30_000 });
    runGitPull(root);
  }
}

/** GitHub Releases API 에서 최신 릴리스를 가져온다. 실패하면 null. */
async function fetchLatest(): Promise<Release | null> {
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "chwijung-mcp" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const { tag_name, published_at } = (await res.json()) as {
      tag_name?: string;
      published_at?: string;
    };
    return tag_name
      ? { version: tag_name.replace(/^v/, ""), publishedAt: published_at }
      : null;
  } catch {
    return null;
  }
}

/**
 * execFileSync 실패(err)를 전파할 종료코드로 변환한다(status > signal > 1 순).
 * signal 종료(SIGINT/SIGTERM 등)는 status=null·signal=시그널명으로 오므로
 * 관례적인 128+n 으로 매핑해, 정상적인 시그널 종료가 1(실패)로 납작해지지 않게 한다.
 * (테스트 위해 export.)
 */
export function exitCodeFromExecError(err: unknown): number {
  const { status, signal } = (err ?? {}) as {
    status?: number | null;
    signal?: NodeJS.Signals | null;
  };
  if (typeof status === "number") return status;
  const signum = signal ? constants.signals[signal] : undefined;
  return signum != null ? 128 + signum : 1; // SIGINT→130, SIGTERM→143
}

/**
 * 버전을 확인하고, 새 버전이 있으면 자동 업데이트 후 re-exec 한다.
 * 업데이트·재실행에 성공하면 이 함수는 반환하지 않는다(호출자 프로세스가 대체됨).
 * 업데이트가 불필요하거나 실패하면 정상 반환한다.
 */
export async function checkAndUpdate(root: string = repoRoot()): Promise<void> {
  // 방금 업데이트 직후 재실행된 프로세스는 다시 확인하지 않는다
  if (process.env.CHWIJUNG_UPDATED) return;

  // git 리포지토리가 아니면 자동 업데이트 불가 — 건너뜀
  if (!isGitRepo(root)) return;

  const release = await fetchLatest();
  if (!release) return;

  // 확인부터 설치까지 잠금 안에서 해야, 다른 프로세스가 방금 끝낸 업데이트를 다시 하지 않는다.
  const unlock = acquireLock(root);
  if (!unlock) return;
  let updated: boolean;
  try {
    updated = runUpdate(root, release);
  } finally {
    unlock();
  }
  if (updated) await reexec();
}

/** 필요하면 소스를 받아 설치·빌드한다. 새 빌드로 재실행해야 하면 true. */
function runUpdate(root: string, release: Release): boolean {
  const latest = release.version;
  const build = readRecord<BuildRecord>(root, ".version");
  if (isUpToDate(root, release, build) || attemptedRecently(root, latest)) return false;

  process.stderr.write(
    `\n[chwijung-mcp] 새 버전 v${latest} 발견 (현재 v${build?.version ?? "?"}). 자동 업데이트 중...\n`,
  );

  try {
    process.stderr.write(`  git pull ...\n`);
    pullSource(root);

    // pull 후에도 latest 에 도달하지 못하면 이 체크아웃은 릴리스 채널을 추적하지 않는 것.
    // build/install 을 건너뛰어 시작 때마다 같은 재빌드를 반복하는 루프를 끊는다.
    const installed = readInstalledVersion(root);
    if (installed !== latest) {
      process.stderr.write(
        `[chwijung-mcp] 이 체크아웃은 릴리스 v${latest}에 도달할 수 없어(현재 v${installed ?? "?"}) ` +
          `자동 업데이트를 건너뜁니다.\n` +
          `  릴리스 브랜치에서 실행하거나 수동으로 업데이트하세요.\n\n`,
      );
      return false;
    }

    writeRecord(root, ".update-attempt", { version: latest, at: Date.now() });

    // 새 릴리스가 의존성을 추가했을 수 있으므로 빌드보다 먼저 설치한다.
    process.stderr.write(`  npm install ...\n`);
    execSync("npm install --include=dev --no-audit --no-fund", {
      cwd: root,
      stdio: "pipe",
      timeout: 120_000,
    });

    process.stderr.write(`  npm run build ...\n`);
    execSync("npm run build", { cwd: root, stdio: "pipe", timeout: 120_000 });

    process.stderr.write(`  npm install -g . ...\n`);
    execSync("npm install -g .", { cwd: root, stdio: "pipe", timeout: 120_000 });

    writeRecord(root, ".release", latest);
    process.stderr.write(`[chwijung-mcp] v${latest} 업데이트 완료. 재시작 중...\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[chwijung-mcp] 자동 업데이트 실패 (${msg})\n` +
        `  수동 업데이트:\n` +
        `    cd ${root}\n` +
        `    git pull && npm install && npm run build && npm install -g .\n\n`,
    );
    return false; // 실패 시 현재 버전으로 그냥 계속 실행
  }
  return true;
}

/**
 * 업데이트된 바이너리로 같은 명령을 re-exec.
 * stdio: "inherit" 로 stdin/stdout/stderr 를 그대로 물려받기 때문에
 * MCP 호스트 입장에서는 끊김 없이 새 버전이 시작된다.
 * 재실행된 프로세스는 오래 살아 있으므로, 잠금을 푼 뒤에 호출한다.
 */
async function reexec(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.argv[0], process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, CHWIJUNG_UPDATED: "1" },
    });
    process.exit(0);
  } catch (err) {
    // 재실행 대상의 종료를 그대로 전파한다(무조건 exit(0)이면 실패/시그널 종료를 숨긴다).
    // status가 숫자면 그 코드, signal 종료는 관례적 128+n 으로 변환한다.
    process.exit(exitCodeFromExecError(err));
  }
}
