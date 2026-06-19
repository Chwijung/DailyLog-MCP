import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type SessionData,
  clearSession,
  isAccessValid,
  loadSession,
  saveSession,
  sessionFile,
} from "../src/session.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-session-"));
  process.env.CHWIJUNG_SESSION_FILE = join(dir, "session.json");
});

afterEach(() => {
  delete process.env.CHWIJUNG_SESSION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function mk(over: Partial<SessionData> = {}): SessionData {
  return {
    access_token: "A",
    refresh_token: "R",
    expires_at: Date.now() / 1000 + 3600,
    cohort_id: "c1",
    user: { role: "student", full_name: "홍길동" },
    ...over,
  };
}

describe("session", () => {
  it("save/load 라운드트립", async () => {
    await saveSession(mk());
    const loaded = await loadSession();
    expect(loaded?.access_token).toBe("A");
    expect(loaded?.refresh_token).toBe("R");
    expect(loaded?.cohort_id).toBe("c1");
    expect(loaded?.user.role).toBe("student");
    expect(loaded?.user.full_name).toBe("홍길동");
  });

  it("파일 없으면 null", async () => {
    expect(await loadSession()).toBeNull();
  });

  it("손상된 파일이면 null", async () => {
    writeFileSync(sessionFile(), "{ not json", "utf-8");
    expect(await loadSession()).toBeNull();
  });

  it("isAccessValid 버퍼", () => {
    const s = mk({ expires_at: 1000 });
    expect(isAccessValid(s, 60, 900)).toBe(true); // 900 < 940
    expect(isAccessValid(s, 60, 950)).toBe(false); // 950 >= 940
    expect(isAccessValid(s, 60, 2000)).toBe(false);
  });

  it("clear", async () => {
    await saveSession(mk());
    await clearSession();
    expect(await loadSession()).toBeNull();
    await clearSession(); // 두 번 호출해도 예외 없음
  });
});
