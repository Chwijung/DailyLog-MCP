import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as auth from "../src/auth.js";
import { ChwijungClient } from "../src/client.js";
import { type SessionData, loadSession, saveSession } from "../src/session.js";
import { mockFetch } from "./helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-auth-"));
  process.env.CHWIJUNG_SESSION_FILE = join(dir, "session.json");
});

afterEach(() => {
  delete process.env.CHWIJUNG_SESSION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function store(over: Partial<SessionData> = {}): Promise<void> {
  return saveSession({
    access_token: "A",
    refresh_token: "R",
    expires_at: Date.now() / 1000 + 3600,
    cohort_id: "c1",
    user: { role: "student" },
    ...over,
  });
}

describe("auth", () => {
  it("loginAndStore 세션 저장", async () => {
    const fetchFn = mockFetch(() => ({
      status: 200,
      body: {
        access_token: "A",
        refresh_token: "R",
        expires_in: 3600,
        user: { id: "u1", role: "student", cohort_id: "c1", full_name: "홍길동" },
      },
    }));
    const session = await auth.loginAndStore(new ChwijungClient("http://test", fetchFn), "s@e.com", "pw");
    expect(session.cohort_id).toBe("c1");
    expect(session.user.role).toBe("student");
    expect((await loadSession())?.access_token).toBe("A");
  });

  it("유효 토큰이면 네트워크 호출 없이 반환", async () => {
    await store();
    const fetchFn = mockFetch(() => {
      throw new Error("유효한 토큰인데 호출되면 안 됨");
    });
    const session = await auth.getActiveSession(new ChwijungClient("http://test", fetchFn));
    expect(session.access_token).toBe("A");
  });

  it("만료 시 회전 토큰을 받으면 저장하고 세션 유지", async () => {
    await store({ access_token: "OLD", refresh_token: "R1", expires_at: Date.now() / 1000 - 10 });
    const fetchFn = mockFetch((url) => {
      expect(url).toContain("/api/v2/auth/refresh");
      return { status: 200, body: { access_token: "NEW", refresh_token: "R2", expires_in: 3600 } };
    });
    const session = await auth.getActiveSession(new ChwijungClient("http://test", fetchFn));
    expect(session.access_token).toBe("NEW");
    expect(session.refresh_token).toBe("R2"); // 회전 토큰 저장 → 다음 갱신도 가능(재로그인 불필요)
    const loaded = await loadSession();
    expect(loaded?.access_token).toBe("NEW");
    expect(loaded?.refresh_token).toBe("R2");
  });

  it("만료 시 회전 토큰이 없으면(구버전 백엔드) refresh_token 소비", async () => {
    await store({ access_token: "OLD", refresh_token: "R1", expires_at: Date.now() / 1000 - 10 });
    const fetchFn = mockFetch(() => ({ status: 200, body: { access_token: "NEW", expires_in: 3600 } }));
    const session = await auth.getActiveSession(new ChwijungClient("http://test", fetchFn));
    expect(session.access_token).toBe("NEW");
    expect(session.refresh_token).toBe(""); // 회전 토큰 없으면 재사용 방지 위해 소비
  });

  it("loginAndStore — 비학생은 NotStudentError + 세션 미저장", async () => {
    const fetchFn = mockFetch(() => ({
      status: 200,
      body: {
        access_token: "A",
        refresh_token: "R",
        expires_in: 3600,
        user: { id: "u2", role: "coach", cohort_id: "c1", full_name: "코치" },
      },
    }));
    await expect(
      auth.loginAndStore(new ChwijungClient("http://test", fetchFn), "c@e.com", "pw"),
    ).rejects.toBeInstanceOf(auth.NotStudentError);
    expect(await loadSession()).toBeNull();
  });

  it("submitDailyLog — 비학생 세션이면 NotStudentError(백엔드 호출 없음)", async () => {
    await store({ user: { role: "coach" } });
    const fetchFn = mockFetch(() => {
      throw new Error("비학생인데 백엔드를 호출하면 안 됨");
    });
    await expect(
      auth.submitDailyLog(new ChwijungClient("http://test", fetchFn), { title: "t" }),
    ).rejects.toBeInstanceOf(auth.NotStudentError);
  });

  it("미로그인 → NotLoggedInError", async () => {
    const fetchFn = mockFetch(() => ({ status: 500, body: {} }));
    await expect(
      auth.getActiveSession(new ChwijungClient("http://test", fetchFn)),
    ).rejects.toBeInstanceOf(auth.NotLoggedInError);
  });

  it("갱신 실패 시 캐시 정리 + NotLoggedInError", async () => {
    await store({ access_token: "OLD", expires_at: Date.now() / 1000 - 10 });
    const fetchFn = mockFetch(() => ({ status: 401, body: { detail: "토큰 갱신에 실패했습니다" } }));
    await expect(
      auth.getActiveSession(new ChwijungClient("http://test", fetchFn)),
    ).rejects.toBeInstanceOf(auth.NotLoggedInError);
    expect(await loadSession()).toBeNull();
  });

  it("만료 + refresh_token 없음 → NotLoggedInError", async () => {
    await store({ access_token: "OLD", refresh_token: "", expires_at: Date.now() / 1000 - 10 });
    const fetchFn = mockFetch(() => ({ status: 500, body: {} }));
    await expect(
      auth.getActiveSession(new ChwijungClient("http://test", fetchFn)),
    ).rejects.toBeInstanceOf(auth.NotLoggedInError);
  });

  it("submitDailyLog 정상 경로", async () => {
    await store();
    const fetchFn = mockFetch((url) => {
      expect(url).toContain("/api/v2/scrum/daily-scrum?cohort_id=c1");
      return { status: 200, body: { id: "e1" } };
    });
    const result = await auth.submitDailyLog(new ChwijungClient("http://test", fetchFn), {
      title: "t",
      is_draft: false,
    });
    expect(result.id).toBe("e1");
  });

  it("submitDailyLog cohort 없음 → NotLoggedInError", async () => {
    await store({ cohort_id: null });
    const fetchFn = mockFetch(() => ({ status: 200, body: { id: "x" } }));
    await expect(
      auth.submitDailyLog(new ChwijungClient("http://test", fetchFn), { title: "t" }),
    ).rejects.toBeInstanceOf(auth.NotLoggedInError);
  });
});
