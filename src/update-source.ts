/**
 * 자동 업데이트가 소스를 받는 방법.
 *
 * 수강생에게는 main(릴리스)만 반영한다. 기본 브랜치가 dev 라서 브랜치 지정 없이 클론한
 * 설치본은 dev 에 있으므로, 업데이트할 때 main 으로 옮긴다. 개발용 폴더는 건드리지 않는다.
 * stdout 은 MCP 프로토콜 전용이므로 stderr 만 사용한다.
 */

import { execSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

const RELEASE_BRANCH = "main";
const DEV_BRANCH = "dev";
const LOCK_FILE = "package-lock.json";

/** 비대화형·타임아웃으로 자격증명 프롬프트나 네트워크 정지에 의한 무기한 블록을 막는다. */
function git(root: string, args: string, timeout = 10_000): string {
  return String(
    execSync(`git ${args}`, {
      cwd: root,
      stdio: "pipe",
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }),
  ).trimEnd();
}

/** 실패하면(설정·업스트림 없음 등) null. */
function tryGit(root: string, args: string): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** 커밋하지 않은 추적 파일 목록. */
function changedFiles(root: string): string[] {
  return git(root, "status --porcelain --untracked-files=no")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
}

/**
 * 자동 업데이트를 하면 안 되는 저장소면 이유를, 해도 되면 null 을 돌려준다.
 * 작업 브랜치이거나, dev 에서 개발 중인 흔적(수정·올리지 않은 커밋)이 있거나, 직접 끈 경우다.
 */
export function autoUpdateBlockedReason(root: string): string | null {
  if (tryGit(root, "config --get chwijung.autoUpdate") === "false") {
    return "git config chwijung.autoUpdate 가 false";
  }
  const branch = git(root, "rev-parse --abbrev-ref HEAD");
  if (branch === RELEASE_BRANCH) return null;
  if (branch !== DEV_BRANCH) return `작업 브랜치(${branch})`;
  if (changedFiles(root).some((file) => file !== LOCK_FILE)) {
    return "dev 에 커밋하지 않은 수정이 있음";
  }
  if (tryGit(root, 'rev-list --count "@{upstream}..HEAD"') !== "0") {
    return "dev 에 올리지 않은 커밋이 있음";
  }
  return null;
}

/** main 을 최신 릴리스 코드로 맞춘다. dev 에 있으면 main 으로 옮긴다(dev 브랜치는 남겨 둔다). */
function updateToReleaseBranch(root: string): void {
  const remoteRef = `refs/remotes/origin/${RELEASE_BRANCH}`;
  // --single-branch 로 클론했어도 받을 수 있게 refspec 을 직접 준다.
  git(root, `fetch origin "+refs/heads/${RELEASE_BRANCH}:${remoteRef}"`, 30_000);

  if (git(root, "rev-parse --abbrev-ref HEAD") !== RELEASE_BRANCH) {
    if (tryGit(root, `rev-parse --verify --quiet refs/heads/${RELEASE_BRANCH}`)) {
      git(root, `checkout ${RELEASE_BRANCH}`);
    } else {
      git(root, `checkout --no-track -b ${RELEASE_BRANCH} ${remoteRef}`);
    }
    // 사용자가 직접 git pull 해도 main 을 받게 한다.
    git(root, `config branch.${RELEASE_BRANCH}.remote origin`);
    git(root, `config branch.${RELEASE_BRANCH}.merge refs/heads/${RELEASE_BRANCH}`);
  }
  git(root, `merge --ff-only ${remoteRef}`);
}

/**
 * 릴리스 코드를 받는다. npm install 이 바꿔 놓은 package-lock.json 이 막았고 바뀐 파일이
 * 그것뿐이면, 백업을 남기고 되돌린 뒤 한 번 더 받는다.
 */
export function syncSource(root: string): void {
  try {
    updateToReleaseBranch(root);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown } | null)?.stderr ?? "");
    if (!stderr.includes(LOCK_FILE)) throw err;
    const changed = changedFiles(root);
    if (changed.length !== 1 || changed[0] !== LOCK_FILE) throw err;
    const backup = resolve(root, ".git", `chwijung-${LOCK_FILE}.bak`);
    copyFileSync(resolve(root, LOCK_FILE), backup);
    process.stderr.write(`  바뀐 ${LOCK_FILE} 을 되돌립니다. 백업: ${backup}\n`);
    git(root, `checkout HEAD -- ${LOCK_FILE}`);
    updateToReleaseBranch(root);
  }
}
