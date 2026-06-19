import { describe, expect, it } from "vitest";

import { AuthError, BackendError, ChwijungClient, ValidationError } from "../src/client.js";
import { mockFetch } from "./helpers.js";

describe("ChwijungClient", () => {
  it("login 성공", async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(url).toContain("/api/v2/auth/signin-with-tokens");
      expect(JSON.parse(init.body as string)).toEqual({ email: "s@e.com", password: "pw" });
      return {
        status: 200,
        body: {
          access_token: "A",
          refresh_token: "R",
          expires_in: 3600,
          user: { id: "u1", role: "student", cohort_id: "c1", full_name: "홍길동" },
        },
      };
    });
    const data = await new ChwijungClient("http://test", fetchFn).login("s@e.com", "pw");
    expect(data.access_token).toBe("A");
    expect(data.user.cohort_id).toBe("c1");
  });

  it("login 자격증명 오류 → AuthError", async () => {
    const fetchFn = mockFetch(() => ({ status: 401, body: { detail: "로그인에 실패했습니다" } }));
    await expect(new ChwijungClient("http://test", fetchFn).login("x", "y")).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("refresh 성공 — 회전된 refresh_token도 그대로 전달", async () => {
    const fetchFn = mockFetch((url) => {
      expect(url).toContain("/api/v2/auth/refresh");
      return {
        status: 200,
        body: { access_token: "A2", token_type: "bearer", expires_in: 3600, refresh_token: "R2" },
      };
    });
    const data = await new ChwijungClient("http://test", fetchFn).refresh("R");
    expect(data.access_token).toBe("A2");
    expect(data.refresh_token).toBe("R2");
  });

  it("exchangeConnectCode 성공 — 연결 코드 전송 + 세션 반환", async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(url).toContain("/api/v2/auth/mcp/exchange");
      expect(JSON.parse(init.body as string)).toEqual({ code: "CODE123" });
      return {
        status: 200,
        body: {
          access_token: "A",
          refresh_token: "R",
          expires_in: 3600,
          user: { id: "u1", role: "student", cohort_id: "c1", full_name: "홍길동" },
        },
      };
    });
    const data = await new ChwijungClient("http://test", fetchFn).exchangeConnectCode("CODE123");
    expect(data.access_token).toBe("A");
    expect(data.user.cohort_id).toBe("c1");
  });

  it("exchangeConnectCode 410 → ValidationError (만료/사용됨)", async () => {
    const fetchFn = mockFetch(() => ({ status: 410, body: { detail: "만료된 연결 코드입니다" } }));
    await expect(
      new ChwijungClient("http://test", fetchFn).exchangeConnectCode("OLD"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("submit 성공 — auth 헤더 + cohort 쿼리 전송", async () => {
    const fetchFn = mockFetch((url, init) => {
      expect(url).toContain("/api/v2/scrum/daily-scrum?cohort_id=c1");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer A");
      expect(JSON.parse(init.body as string).is_draft).toBe(false);
      return { status: 200, body: { id: "entry-1", created_at: "2026-06-16T10:00:00+09:00" } };
    });
    const data = await new ChwijungClient("http://test", fetchFn).submitDailyLog("A", "c1", {
      title: "작업 완료",
      is_draft: false,
    });
    expect(data.id).toBe("entry-1");
  });

  it("submit 400 → ValidationError", async () => {
    const fetchFn = mockFetch(() => ({
      status: 400,
      body: { detail: "제출 시 다음 필드는 필수입니다: problems" },
    }));
    await expect(
      new ChwijungClient("http://test", fetchFn).submitDailyLog("A", "c1", {}),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("submit 403 → AuthError/ValidationError 아닌 BackendError", async () => {
    const fetchFn = mockFetch(() => ({
      status: 403,
      body: { detail: "학생만 데일리 스크럼을 작성할 수 있습니다" },
    }));
    const promise = new ChwijungClient("http://test", fetchFn).submitDailyLog("A", "c1", {});
    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await expect(promise).rejects.not.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ status: 403 });
  });

  it("submit 401 → AuthError", async () => {
    const fetchFn = mockFetch(() => ({ status: 401, body: { detail: "인증 정보를 검증할 수 없습니다" } }));
    await expect(
      new ChwijungClient("http://test", fetchFn).submitDailyLog("A", "c1", {}),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
