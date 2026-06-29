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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CURRENT: string = (require("../package.json") as { version: string }).version;

const API_URL =
  "https://api.github.com/repos/Chwijung/DailyLog-MCP/releases/latest";

/** build/update.js 위치에서 두 단계 올라가면 리포지토리 루트 */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** git 리포지토리인지 확인 (비정상적 설치 환경 방어) */
function isGitRepo(root: string): boolean {
  return existsSync(resolve(root, ".git"));
}

/** GitHub Releases API 에서 최신 태그를 가져온다. 실패하면 null. */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(API_URL, {
      headers: { "User-Agent": "chwijung-mcp" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const { tag_name } = (await res.json()) as { tag_name?: string };
    return tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

/**
 * 버전을 확인하고, 새 버전이 있으면 자동 업데이트 후 re-exec 한다.
 * 업데이트·재실행에 성공하면 이 함수는 반환하지 않는다(호출자 프로세스가 대체됨).
 * 업데이트가 불필요하거나 실패하면 정상 반환한다.
 */
export async function checkAndUpdate(): Promise<void> {
  // 방금 업데이트 직후 재실행된 프로세스는 다시 확인하지 않는다
  if (process.env.CHWIJUNG_UPDATED) return;

  const root = repoRoot();

  // git 리포지토리가 아니면 자동 업데이트 불가 — 건너뜀
  if (!isGitRepo(root)) return;

  const latest = await fetchLatest();
  if (!latest || latest === CURRENT) return;

  process.stderr.write(
    `\n[chwijung-mcp] 새 버전 v${latest} 발견 (현재 v${CURRENT}). 자동 업데이트 중...\n`,
  );

  try {
    process.stderr.write(`  git pull ...\n`);
    execSync("git pull", { cwd: root, stdio: "pipe" });

    process.stderr.write(`  npm run build ...\n`);
    execSync("npm run build", { cwd: root, stdio: "pipe" });

    process.stderr.write(`  npm install -g . ...\n`);
    execSync("npm install -g .", { cwd: root, stdio: "pipe" });

    process.stderr.write(`[chwijung-mcp] v${latest} 업데이트 완료. 재시작 중...\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[chwijung-mcp] 자동 업데이트 실패 (${msg})\n` +
        `  수동 업데이트:\n` +
        `    cd ${root}\n` +
        `    git pull && npm run build && npm install -g .\n\n`,
    );
    return; // 실패 시 현재 버전으로 그냥 계속 실행
  }

  // 업데이트된 바이너리로 같은 명령을 re-exec.
  // stdio: "inherit" 로 stdin/stdout/stderr 를 그대로 물려받기 때문에
  // MCP 호스트 입장에서는 끊김 없이 새 버전이 시작된다.
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.argv[0], process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, CHWIJUNG_UPDATED: "1" },
    });
  } finally {
    process.exit(0);
  }
}
