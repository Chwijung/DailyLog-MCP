/**
 * 인증 오케스트레이션: 로그인 저장 + 토큰 유효성 보장(회전 갱신) + 제출.
 *
 * 토큰 정책
 * - 로그인 시 access_token(약 1시간) + refresh_token + cohort_id를 캐시에 저장.
 * - access_token이 만료되면 refresh_token으로 갱신한다. 백엔드 /auth/refresh 가
 *   회전된 새 refresh_token을 함께 반환하면 그 값을 저장해 **무기한 회전**하므로
 *   비밀번호 재입력(재로그인) 없이 세션을 유지한다.
 * - 만약 백엔드가 회전 토큰을 돌려주지 않는(구버전) 경우엔, Supabase refresh_token이
 *   1회용이라 같은 토큰 재사용은 reuse-detection으로 세션이 폐기된다. 그래서 그때는
 *   사용한 refresh_token을 즉시 소비(빈 문자열)하고 다음 만료 시 재로그인을 요구한다.
 *
 * 학생 권한
 * - 데일리 로그는 학생(student) 계정만 작성할 수 있다(백엔드 403이 최종 방어선).
 *   클라이언트에서도 로그인 저장 시점과 제출 직전에 역할을 확인해 다중 방어한다.
 */

import { AuthError, ChwijungClient } from "./client.js";
import {
  type SessionData,
  clearSession,
  isAccessValid,
  loadSession,
  saveSession,
} from "./session.js";

/** 로그인이 필요하거나 세션이 만료되어 재로그인이 필요한 상태. */
export class NotLoggedInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotLoggedInError";
  }
}

/** 학생(student) 계정이 아니어서 데일리 로그를 작성할 수 없는 상태. */
export class NotStudentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotStudentError";
  }
}

function nowSec(): number {
  return Date.now() / 1000;
}

/** 백엔드 갱신 응답을 세션에 반영. 회전 토큰을 주면 저장, 없으면 소비(빈 문자열). */
function applyRefresh(session: SessionData, data: Record<string, any>): void {
  session.access_token = data.access_token;
  session.expires_at = nowSec() + Number(data.expires_in ?? 3600);
  session.refresh_token =
    typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : "";
}

/** 로그인/연결 응답(access/refresh/user)을 SessionData로 변환. */
function sessionFromData(data: Record<string, any>): SessionData {
  const user = data.user ?? {};
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? "",
    expires_at: nowSec() + Number(data.expires_in ?? 3600),
    cohort_id: user.cohort_id ?? null,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
    },
  };
}

/** 학생 계정이면 세션을 저장하고 반환, 아니면 NotStudentError(저장 안 함). */
async function storeStudentSession(data: Record<string, any>): Promise<SessionData> {
  const session = sessionFromData(data);
  if (session.user.role !== "student") {
    throw new NotStudentError(
      `이 계정의 역할은 '${session.user.role ?? "알 수 없음"}'입니다. ` +
        "데일리 로그는 학생(student) 계정만 작성할 수 있어 로그인 정보를 저장하지 않았습니다.",
    );
  }
  await saveSession(session);
  return session;
}

/**
 * 백엔드 로그인 후 세션을 캐시에 저장하고 반환.
 * 학생(student) 계정이 아니면 저장하지 않고 NotStudentError를 던진다.
 */
export async function loginAndStore(
  client: ChwijungClient,
  email: string,
  password: string,
): Promise<SessionData> {
  const data = await client.login(email, password);
  return storeStudentSession(data);
}

/**
 * 웹에서 발급한 연결 코드를 교환해 전용 세션을 캐시에 저장하고 반환.
 * 학생(student) 계정이 아니면 저장하지 않고 NotStudentError를 던진다.
 */
export async function connectAndStore(
  client: ChwijungClient,
  code: string,
): Promise<SessionData> {
  const data = await client.exchangeConnectCode(code);
  return storeStudentSession(data);
}

/** 유효한 access_token을 가진 세션을 반환. 만료 시 갱신, 불가하면 NotLoggedInError. */
export async function getActiveSession(client: ChwijungClient): Promise<SessionData> {
  const session = await loadSession();
  if (!session) throw new NotLoggedInError("로그인이 필요합니다. 터미널에서 `chwijung-mcp login`을 실행하세요.");

  if (isAccessValid(session)) return session;

  if (!session.refresh_token) {
    await clearSession();
    throw new NotLoggedInError("세션이 만료되었습니다. 터미널에서 `chwijung-mcp login`으로 다시 로그인하세요.");
  }

  let data: Record<string, any>;
  try {
    data = await client.refresh(session.refresh_token);
  } catch (err) {
    if (err instanceof AuthError) {
      await clearSession();
      throw new NotLoggedInError("세션이 만료되었습니다. 터미널에서 `chwijung-mcp login`으로 다시 로그인하세요.");
    }
    throw err;
  }

  applyRefresh(session, data);
  await saveSession(session);
  return session;
}

/** 유효 세션 확보 후 데일리 로그를 제출. 401이면 (가능 시) 1회 반응적 갱신 후 재시도. */
export async function submitDailyLog(
  client: ChwijungClient,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  const session = await getActiveSession(client);
  if (session.user.role !== "student") {
    throw new NotStudentError("학생(student) 계정만 데일리 로그를 작성할 수 있습니다.");
  }
  if (!session.cohort_id) {
    throw new NotLoggedInError("코호트 정보가 없습니다. 터미널에서 `chwijung-mcp login`으로 다시 로그인하세요.");
  }

  try {
    return await client.submitDailyLog(session.access_token, session.cohort_id, payload);
  } catch (err) {
    // 시계상으론 유효했지만 서버가 401을 준 경우: refresh_token이 남아있으면 1회 갱신·재시도
    if (err instanceof AuthError && session.refresh_token) {
      const data = await client.refresh(session.refresh_token);
      applyRefresh(session, data);
      await saveSession(session);
      return await client.submitDailyLog(session.access_token, session.cohort_id, payload);
    }
    if (err instanceof AuthError) {
      await clearSession();
      throw new NotLoggedInError("세션이 만료되었습니다. 터미널에서 `chwijung-mcp login`으로 다시 로그인하세요.");
    }
    throw err;
  }
}
