/**
 * 취몽 백엔드 HTTP 클라이언트.
 *
 * 순수 HTTP 호출만 담당하며 토큰 캐시/갱신 정책은 auth.ts가 맡는다.
 * 테스트에서는 fetchFn을 주입해 네트워크를 모킹한다.
 */

export class BackendError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BackendError";
    this.status = status;
  }
}

/** 인증 실패 / 토큰 만료 (401·로그인 실패). */
export class AuthError extends BackendError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "AuthError";
  }
}

/** 입력값 검증 실패 (400). */
export class ValidationError extends BackendError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "ValidationError";
  }
}

type FetchFn = typeof fetch;

/** FastAPI 오류 응답의 detail 문자열을 추출. */
async function readDetail(res: Response): Promise<string | null> {
  try {
    const data = await res.json();
    if (data && typeof data === "object" && "detail" in data) {
      const detail = (data as Record<string, unknown>).detail;
      if (typeof detail === "string") return detail;
      if (detail != null) return JSON.stringify(detail);
    }
  } catch {
    // JSON 아님
  }
  return null;
}

export class ChwijungClient {
  private readonly apiBase: string;
  private readonly fetchFn: FetchFn;

  constructor(baseUrl: string, fetchFn: FetchFn = fetch) {
    this.apiBase = baseUrl.replace(/\/+$/, "") + "/api/v2";
    this.fetchFn = fetchFn;
  }

  /** POST /auth/signin-with-tokens → access/refresh 토큰 + 사용자 정보. */
  async login(email: string, password: string): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${this.apiBase}/auth/signin-with-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 400 || res.status === 401) {
      throw new AuthError((await readDetail(res)) ?? "이메일 또는 비밀번호가 올바르지 않습니다", res.status);
    }
    if (!res.ok) throw new BackendError(`로그인 실패 (HTTP ${res.status})`, res.status);
    return res.json();
  }

  /** POST /auth/refresh → 새 access_token (+ 회전된 refresh_token, 백엔드가 반환 시). */
  async refresh(refreshToken: string): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${this.apiBase}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (res.status === 401) throw new AuthError((await readDetail(res)) ?? "토큰 갱신에 실패했습니다", 401);
    if (!res.ok) throw new BackendError(`토큰 갱신 실패 (HTTP ${res.status})`, res.status);
    return res.json();
  }

  /** POST /auth/mcp/exchange → 웹에서 발급한 연결 코드를 교환해 전용 세션(access/refresh) + 사용자 정보. */
  async exchangeConnectCode(code: string): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${this.apiBase}/auth/mcp/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status === 400) {
      throw new ValidationError((await readDetail(res)) ?? "유효하지 않은 연결 코드입니다", 400);
    }
    if (res.status === 410) {
      throw new ValidationError(
        (await readDetail(res)) ?? "만료되었거나 이미 사용된 연결 코드입니다. 웹에서 새 코드를 발급하세요",
        410,
      );
    }
    if (res.status === 403) {
      throw new BackendError(
        (await readDetail(res)) ?? "권한이 없습니다 (데일리 로그는 학생 계정만 작성 가능)",
        403,
      );
    }
    if (!res.ok) throw new BackendError(`연결 실패 (HTTP ${res.status})`, res.status);
    return res.json();
  }

  /** POST /scrum/daily-scrum?cohort_id=... → 생성된 데일리 스크럼 엔트리. */
  async submitDailyLog(
    accessToken: string,
    cohortId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const url = `${this.apiBase}/scrum/daily-scrum?cohort_id=${encodeURIComponent(cohortId)}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) throw new AuthError((await readDetail(res)) ?? "인증이 만료되었습니다", 401);
    if (res.status === 403) {
      throw new BackendError((await readDetail(res)) ?? "권한이 없습니다 (데일리 로그는 학생 계정만 작성 가능)", 403);
    }
    if (res.status === 400) throw new ValidationError((await readDetail(res)) ?? "입력값 검증에 실패했습니다", 400);
    if (!res.ok) throw new BackendError(`등록 실패 (HTTP ${res.status})`, res.status);
    return res.json();
  }
}
