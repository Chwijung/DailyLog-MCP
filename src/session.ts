/**
 * 로컬 토큰 캐시.
 *
 * 로그인으로 받은 access/refresh 토큰과 cohort 정보를 사용자 홈 디렉토리에 저장한다.
 * 비밀은 레포에 커밋되지 않으며 ~/.chwijung/session.json 에만 보관한다(권한 0600 시도).
 * 테스트에서는 CHWIJUNG_SESSION_FILE 환경변수로 경로를 오버라이드할 수 있다.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SessionUser {
  id?: string;
  email?: string;
  full_name?: string;
  role?: string;
}

export interface SessionData {
  access_token: string;
  refresh_token: string;
  /** access_token 만료 시각 (epoch seconds) */
  expires_at: number;
  cohort_id?: string | null;
  user: SessionUser;
}

export function sessionFile(): string {
  return process.env.CHWIJUNG_SESSION_FILE ?? join(homedir(), ".chwijung", "session.json");
}

/** access_token이 (버퍼를 감안해) 아직 유효하면 true. */
export function isAccessValid(
  session: SessionData,
  bufferSeconds = 60,
  now: number = Date.now() / 1000,
): boolean {
  return now < session.expires_at - bufferSeconds;
}

export async function saveSession(session: SessionData): Promise<void> {
  const file = sessionFile();
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(session, null, 2), "utf-8");
  await restrictToOwner(file);
}

/**
 * 세션 파일을 소유자만 읽을 수 있도록 제한(best-effort).
 * - POSIX: chmod 0600.
 * - Windows: chmod가 no-op이라 icacls로 상속 제거 + 현재 사용자 단독 권한.
 * 어떤 이유로 실패해도 무시한다(파일 저장 자체는 유지).
 */
async function restrictToOwner(file: string): Promise<void> {
  if (process.platform !== "win32") {
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // chmod 미지원 환경 무시
    }
    return;
  }
  // 테스트(VITEST)에서는 외부 프로세스 호출을 생략해 속도/결정성 확보.
  if (process.env.VITEST) return;
  try {
    const user = userInfo().username;
    if (!user) return;
    // /inheritance:r → 상속 ACE 제거, /grant:r user:F → 현재 사용자에게만 Full
    await execFileAsync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`]);
  } catch {
    // icacls 미가용 등 무시(best-effort)
  }
}

export async function loadSession(): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(sessionFile(), "utf-8");
    const data = JSON.parse(raw);
    if (typeof data?.access_token !== "string") return null;
    return {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : "",
      expires_at: Number(data.expires_at ?? 0),
      cohort_id: data.cohort_id ?? null,
      user: data.user ?? {},
    };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await fs.unlink(sessionFile());
  } catch {
    // 파일이 없으면 무시
  }
}
