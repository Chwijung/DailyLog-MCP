import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CliIO,
  connectCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from "../src/cli.js";
import { ChwijungClient } from "../src/client.js";
import { loadSession, saveSession } from "../src/session.js";
import { mockFetch } from "./helpers.js";

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-cli-"));
  process.env.CHWIJUNG_SESSION_FILE = join(dir, "session.json");
  logs = [];
});

afterEach(() => {
  delete process.env.CHWIJUNG_SESSION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function io(email: string, password: string): CliIO {
  return {
    readEmail: async () => email,
    readPassword: async () => password,
    log: (m: string) => {
      logs.push(m);
    },
  };
}

const log = (m: string): void => {
  logs.push(m);
};

function clientWithUser(user: Record<string, unknown>): ChwijungClient {
  return new ChwijungClient(
    "http://test",
    mockFetch(() => ({
      status: 200,
      body: { access_token: "A", refresh_token: "R", expires_in: 3600, user },
    })),
  );
}

describe("cli", () => {
  it("login — 학생 계정 성공 + 세션 저장", async () => {
    const client = clientWithUser({ id: "u1", role: "student", cohort_id: "c1", full_name: "홍길동" });
    const code = await loginCommand(io("s@e.com", "pw"), client);
    expect(code).toBe(0);
    expect((await loadSession())?.access_token).toBe("A");
    expect(logs.join("\n")).toContain("로그인 성공");
  });

  it("login — 비학생 거부 + 세션 미저장", async () => {
    const client = clientWithUser({ id: "u2", role: "coach", cohort_id: "c1", full_name: "코치" });
    const code = await loginCommand(io("c@e.com", "pw"), client);
    expect(code).toBe(1);
    expect(await loadSession()).toBeNull();
    expect(logs.join("\n")).toContain("학생");
  });

  it("login — 이메일/비밀번호 누락 시 실패", async () => {
    const client = clientWithUser({ role: "student" });
    const code = await loginCommand(io("", ""), client);
    expect(code).toBe(1);
    expect(await loadSession()).toBeNull();
  });

  it("login — 자격증명 오류 메시지", async () => {
    const client = new ChwijungClient(
      "http://test",
      mockFetch(() => ({ status: 401, body: { detail: "이메일 또는 비밀번호가 올바르지 않습니다" } })),
    );
    const code = await loginCommand(io("s@e.com", "bad"), client);
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("로그인 실패");
  });

  it("connect — 학생 연결 코드 성공 + 세션 저장", async () => {
    const client = new ChwijungClient(
      "http://test",
      mockFetch((url) => {
        expect(url).toContain("/api/v2/auth/mcp/exchange");
        return {
          status: 200,
          body: {
            access_token: "A",
            refresh_token: "R",
            expires_in: 3600,
            user: { id: "u1", role: "student", cohort_id: "c1", full_name: "홍길동" },
          },
        };
      }),
    );
    const code = await connectCommand({ log }, "CODE123", client);
    expect(code).toBe(0);
    expect((await loadSession())?.access_token).toBe("A");
    expect(logs.join("\n")).toContain("연결 성공");
  });

  it("connect — 코드 없으면 안내 후 실패", async () => {
    const client = clientWithUser({ role: "student" });
    const code = await connectCommand({ log }, "  ", client);
    expect(code).toBe(1);
    expect(await loadSession()).toBeNull();
    expect(logs.join("\n")).toContain("연결 코드가 필요");
  });

  it("connect — 비학생 거부 + 세션 미저장", async () => {
    const client = clientWithUser({ id: "u2", role: "coach", cohort_id: "c1", full_name: "코치" });
    const code = await connectCommand({ log }, "CODE123", client);
    expect(code).toBe(1);
    expect(await loadSession()).toBeNull();
    expect(logs.join("\n")).toContain("학생");
  });

  it("whoami/logout 라운드트립", async () => {
    expect(await whoamiCommand({ log })).toBe(1); // 미로그인
    await saveSession({
      access_token: "A",
      refresh_token: "R",
      expires_at: Date.now() / 1000 + 3600,
      cohort_id: "c1",
      user: { role: "student", full_name: "홍길동" },
    });
    logs = [];
    expect(await whoamiCommand({ log })).toBe(0);
    expect(logs.join("\n")).toContain("홍길동");
    expect(await logoutCommand({ log })).toBe(0);
    expect(await loadSession()).toBeNull();
  });
});
