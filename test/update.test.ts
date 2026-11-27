import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoUpdateBlockedReason, syncSource } from "../src/update-source.js";
import { checkAndUpdate, exitCodeFromExecError, readInstalledVersion } from "../src/update.js";

// checkAndUpdate가 호출하는 git/npm 명령을 실제로 실행하지 않도록 모킹.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// 소스를 받는 git 동작은 update-source.test.ts 에서 실제 git 으로 확인한다.
vi.mock("../src/update-source.js", () => ({
  autoUpdateBlockedReason: vi.fn(),
  syncSource: vi.fn(),
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-update-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(content: string): void {
  writeFileSync(join(dir, "package.json"), content, "utf-8");
}

describe("readInstalledVersion", () => {
  it("정상 package.json 의 version 을 반환", () => {
    writePkg(JSON.stringify({ name: "x", version: "1.2.3" }));
    expect(readInstalledVersion(dir)).toBe("1.2.3");
  });

  it("선행 v 접두사를 제거(릴리스 태그와 동일 형식으로 비교 가능)", () => {
    writePkg(JSON.stringify({ version: "v2.0.0" }));
    expect(readInstalledVersion(dir)).toBe("2.0.0");
  });

  it("package.json 이 없으면 null", () => {
    expect(readInstalledVersion(dir)).toBeNull();
  });

  it("손상된 JSON 이면 null", () => {
    writePkg("{ not json");
    expect(readInstalledVersion(dir)).toBeNull();
  });

  it("version 필드가 없으면 null", () => {
    writePkg(JSON.stringify({ name: "x" }));
    expect(readInstalledVersion(dir)).toBeNull();
  });
});

describe("exitCodeFromExecError", () => {
  it("status가 숫자면 그 코드를 그대로 반환", () => {
    expect(exitCodeFromExecError({ status: 2 })).toBe(2);
    expect(exitCodeFromExecError({ status: 0 })).toBe(0);
  });

  it("SIGINT 종료는 130(128+2)으로 전파", () => {
    expect(exitCodeFromExecError({ status: null, signal: "SIGINT" })).toBe(130);
  });

  it("SIGTERM 종료는 143(128+15)으로 전파", () => {
    expect(exitCodeFromExecError({ status: null, signal: "SIGTERM" })).toBe(143);
  });

  it("status도 signal도 없으면 1", () => {
    expect(exitCodeFromExecError({})).toBe(1);
    expect(exitCodeFromExecError(undefined)).toBe(1);
  });
});

describe("checkAndUpdate", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(autoUpdateBlockedReason).mockReset().mockReturnValue(null);
    vi.mocked(syncSource).mockReset();
    delete process.env.CHWIJUNG_UPDATED;
    vi.spyOn(process.stderr, "write").mockReturnValue(true); // 진행 로그 침묵
  });

  afterEach(() => {
    delete process.env.CHWIJUNG_UPDATED;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("CHWIJUNG_UPDATED가 설정되면 fetch 없이 즉시 반환(재실행 루프 차단)", async () => {
    process.env.CHWIJUNG_UPDATED = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkAndUpdate();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  const PUBLISHED = "2026-01-02T00:00:00Z";
  const BEFORE = "2026-01-01T00:00:00Z";
  const AFTER = "2026-01-03T00:00:00Z";
  const UPDATE = [
    "npm install --include=dev --no-audit --no-fund",
    "npm run build",
    "npm install -g .",
  ];

  /** 릴리스·소스(package.json)·빌드 기록을 정해 설치본을 흉내 낸다. */
  function setup(release: string, source: string, built: string | null, builtAt = AFTER): void {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "build"));
    writePkg(JSON.stringify({ version: source }));
    if (built !== null) {
      writeFileSync(join(dir, "build", ".version"), JSON.stringify({ version: built, builtAt }));
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: `v${release}`, published_at: PUBLISHED }),
      }),
    );
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  }

  function commands(): string[] {
    return vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
  }

  it("릴리스 이후에 같은 버전으로 빌드했으면 업데이트하지 않음", async () => {
    setup("0.3.3", "0.3.3", "0.3.3");
    await checkAndUpdate(dir);
    expect(commands()).toEqual([]);
  });

  it("소스는 최신인데 빌드가 예전 것이면 다시 빌드", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    await checkAndUpdate(dir);
    expect(commands()).toEqual(UPDATE);
  });

  it("빌드 기록이 없으면 다시 빌드", async () => {
    setup("0.3.3", "0.3.3", null);
    await checkAndUpdate(dir);
    expect(commands()).toEqual(UPDATE);
  });

  it("버전이 같아도 릴리스 전에 만든 빌드면 한 번 다시 받고, 그 뒤로는 반복하지 않음", async () => {
    setup("0.3.4", "0.3.4", "0.3.4", BEFORE);
    await checkAndUpdate(dir);
    expect(commands()).toEqual(UPDATE);

    // 재시도 간격에 걸려 통과하지 않도록 시도 기록을 지운다. 반복을 막는 것은 .release 기록뿐이어야 한다.
    rmSync(join(dir, "build", ".update-attempt"));
    vi.mocked(execSync).mockClear();
    await checkAndUpdate(dir);
    expect(commands()).toEqual([]);
  });

  it("다른 프로세스가 업데이트 중(잠금 있음)이면 아무것도 하지 않음", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    writeFileSync(join(dir, "build", ".update-lock"), "");
    await checkAndUpdate(dir);
    expect(commands()).toEqual([]);
    expect(existsSync(join(dir, "build", ".update-lock"))).toBe(true);
  });

  it("오래된 잠금은 중단된 업데이트가 남긴 것으로 보고 무시함", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    const lock = join(dir, "build", ".update-lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 16 * 60 * 1000);
    utimesSync(lock, old, old);
    await checkAndUpdate(dir);
    expect(commands()).toEqual(UPDATE);
    expect(existsSync(lock)).toBe(false);
  });

  it("업데이트하는 동안 잠금을 잡고, 끝나면 풂", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    const lock = join(dir, "build", ".update-lock");
    const held: boolean[] = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      held.push(existsSync(lock));
      return Buffer.from("");
    }) as never);
    await checkAndUpdate(dir);
    expect(held).toEqual(UPDATE.map(() => true));
    expect(existsSync(lock)).toBe(false);
  });

  it("업데이트가 실패해도 잠금을 풂", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd === "npm run build") throw new Error("build");
      return Buffer.from("");
    }) as never);
    await checkAndUpdate(dir);
    expect(existsSync(join(dir, "build", ".update-lock"))).toBe(false);
  });

  it("최신이면 잠금 파일을 남기지 않음", async () => {
    setup("0.3.3", "0.3.3", "0.3.3");
    await checkAndUpdate(dir);
    expect(existsSync(join(dir, "build", ".update-lock"))).toBe(false);
  });

  it("소스가 릴리스보다 앞서 있으면 빌드를 건너뜀", async () => {
    setup("0.3.2", "0.3.3", "0.3.0");
    await checkAndUpdate(dir);
    expect(vi.mocked(syncSource)).toHaveBeenCalled();
    expect(commands()).toEqual([]);
  });

  it("의존성 설치가 실패하면 빌드하지 않고, 한동안 다시 시도하지 않음", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd.startsWith("npm install")) throw new Error("install");
      return Buffer.from("");
    }) as never);
    await checkAndUpdate(dir);
    expect(commands()).toEqual(UPDATE.slice(0, 1));

    vi.mocked(execSync).mockClear();
    await checkAndUpdate(dir);
    expect(commands()).toEqual([]);
  });

  it("실패한 지 한 시간이 지나면 다시 시도", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    const at = Date.now() - 61 * 60 * 1000;
    writeFileSync(join(dir, "build", ".update-attempt"), JSON.stringify({ version: "0.3.3", at }));
    await checkAndUpdate(dir);
    expect(commands()).toEqual(UPDATE);
  });

  it("개발용 저장소면 소스를 받지 않음", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    vi.mocked(autoUpdateBlockedReason).mockReturnValue("작업 브랜치");
    await checkAndUpdate(dir);
    expect(vi.mocked(syncSource)).not.toHaveBeenCalled();
    expect(commands()).toEqual([]);
  });

  it("소스를 받지 못하면 설치·빌드하지 않음", async () => {
    setup("0.3.3", "0.3.0", "0.3.0");
    vi.mocked(syncSource).mockImplementation(() => {
      throw new Error("network");
    });
    await checkAndUpdate(dir);
    expect(commands()).toEqual([]);
  });

  it("릴리스 조회 실패 시 업데이트하지 않음", async () => {
    setup("0.3.3", "0.3.0", "0.3.0");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    await checkAndUpdate(dir);

    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it("새 버전이 있어도 pull 후 버전이 수렴하지 않으면 build/install을 건너뜀(재빌드 루프 방지)", async () => {
    setup("9.9.9", "0.1.0", "0.1.0");
    vi.mocked(execSync).mockReturnValue(Buffer.from("")); // git pull no-op

    await checkAndUpdate(dir);

    // package.json(0.1.0) ≠ 9.9.9 → git pull만 시도하고 빌드/설치는 건너뜀
    const cmds = vi.mocked(execSync).mock.calls.map((c) => c[0]);
    expect(vi.mocked(syncSource)).toHaveBeenCalled();
    expect(cmds).not.toContain("npm run build");
    expect(cmds).not.toContain("npm install -g .");
  });
});
