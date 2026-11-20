import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CliIO,
  connectCommand,
  hooksCommand,
  loginCommand,
  logoutCommand,
  uninstallCommand,
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
    expect(logs.join("\n")).toContain("로그인 완료");
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
    expect(logs.join("\n")).toContain("연결 완료");
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

  it("uninstall — 확인 거부 시 삭제하지 않고 취소", async () => {
    let called = false;
    const code = await uninstallCommand(
      { log },
      {},
      async () => false, // 사용자가 N 선택
      async () => {
        called = true;
      },
    );
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(logs.join("\n")).toContain("취소되었습니다");
  });

  it("uninstall — 확인 승인 시 삭제 실행", async () => {
    let called = false;
    const code = await uninstallCommand(
      { log },
      {},
      async () => true, // 사용자가 y 선택
      async () => {
        called = true;
      },
    );
    expect(code).toBe(0);
    expect(called).toBe(true);
  });

  it("uninstall — -y(yes)면 확인 없이 바로 삭제", async () => {
    let confirmAsked = false;
    let called = false;
    const code = await uninstallCommand(
      { log },
      { yes: true },
      async () => {
        confirmAsked = true;
        return true;
      },
      async () => {
        called = true;
      },
    );
    expect(code).toBe(0);
    expect(confirmAsked).toBe(false);
    expect(called).toBe(true);
  });
});

// ==================== hooks (AI 대화 기록) ====================

describe("hooksCommand", () => {
  const CMD = '"C:/node.exe" "E:/DailyLog-MCP/build/cli.js" hook --agent claude';
  const settingsAt = (base: string): string => join(base, ".claude", "settings.json");

  async function student(): Promise<void> {
    await saveSession({
      access_token: "A",
      refresh_token: "R",
      expires_at: Date.now() / 1000 + 3600,
      cohort_id: "c1",
      user: { id: "u1", role: "student" },
    });
  }

  it("로그인 전에는 설치하지 않는다", async () => {
    const code = await hooksCommand({ log }, ["install", "-y"], { cwd: dir, home: dir, command: CMD });
    expect(code).toBe(1);
    expect(existsSync(settingsAt(dir))).toBe(false);
  });

  it("동의 안내를 보여주고, 거절하면 설치하지 않는다", async () => {
    await student();
    const code = await hooksCommand({ log }, ["install"], {
      cwd: dir,
      home: join(dir, "home"),
      command: CMD,
      confirm: async () => false,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("프롬프트 원문");
    expect(logs.join("\n")).toContain("취소");
    expect(existsSync(settingsAt(dir))).toBe(false);
  });

  it("기본은 현재 폴더, --global은 홈에 설치하고 status·uninstall이 둘 다 본다", async () => {
    await student();
    const home = join(dir, "home");
    await hooksCommand({ log }, ["install", "-y"], { cwd: dir, home, command: CMD });
    expect(existsSync(settingsAt(dir))).toBe(true);
    expect(existsSync(settingsAt(home))).toBe(false);

    await hooksCommand({ log }, ["install", "--global", "-y"], { cwd: dir, home, command: CMD });
    expect(existsSync(settingsAt(home))).toBe(true);

    logs.length = 0;
    await hooksCommand({ log }, ["status"], { cwd: dir, home });
    expect(logs.filter((l) => l.includes("켜짐"))).toHaveLength(2);

    logs.length = 0;
    await hooksCommand({ log }, ["uninstall"], { cwd: dir, home });
    await hooksCommand({ log }, ["status"], { cwd: dir, home });
    expect(logs.filter((l) => l.includes("꺼짐"))).toHaveLength(2);
  });

  it("모르는 하위 명령은 2", async () => {
    expect(await hooksCommand({ log }, ["nope"])).toBe(2);
  });
});
