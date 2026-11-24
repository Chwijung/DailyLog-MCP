import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkAndUpdate, exitCodeFromExecError, readInstalledVersion } from "../src/update.js";

// checkAndUpdate가 호출하는 git/npm 명령을 실제로 실행하지 않도록 모킹.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
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

  /** 릴리스·소스(package.json)·빌드 기록 버전을 정해 설치본을 흉내 낸다. */
  function setup(release: string, source: string, built: string | null): void {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "build"));
    writePkg(JSON.stringify({ version: source }));
    if (built !== null) writeFileSync(join(dir, "build", ".version"), built);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: `v${release}` }) }),
    );
  }

  function commands(): string[] {
    return vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
  }

  function stubExit(): void {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  }

  it("빌드된 버전이 최신 릴리스와 같으면 업데이트하지 않음", async () => {
    setup("0.3.3", "0.3.3", "0.3.3");

    await checkAndUpdate(dir);

    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it("소스는 최신인데 빌드가 예전 것이면 다시 빌드", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    stubExit();

    await checkAndUpdate(dir);

    expect(commands()).toEqual(["git pull --ff-only", "npm run build", "npm install -g ."]);
  });

  it("빌드 기록이 없으면 다시 빌드", async () => {
    setup("0.3.3", "0.3.3", null);
    stubExit();

    await checkAndUpdate(dir);

    expect(commands()).toContain("npm run build");
  });

  it("소스가 릴리스보다 앞서 있으면 빌드를 건너뜀", async () => {
    setup("0.3.2", "0.3.3", "0.3.0");

    await checkAndUpdate(dir);

    expect(commands()).toEqual(["git pull --ff-only"]);
  });

  it("로컬에서 바뀐 package-lock.json이 pull을 막으면 되돌리고 다시 받음", async () => {
    setup("0.3.3", "0.3.3", "0.3.0");
    stubExit();
    let pulls = 0;
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd.startsWith("git pull") && pulls++ === 0) {
        throw Object.assign(new Error("pull"), { stderr: Buffer.from("  package-lock.json") });
      }
      return Buffer.from("");
    }) as never);

    await checkAndUpdate(dir);

    expect(commands()).toEqual([
      "git pull --ff-only",
      "git checkout -- package-lock.json",
      "git pull --ff-only",
      "npm run build",
      "npm install -g .",
    ]);
  });

  it("다른 이유로 pull이 실패하면 package-lock.json을 건드리지 않음", async () => {
    setup("0.3.3", "0.3.0", "0.3.0");
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("network"), { stderr: Buffer.from("could not resolve host") });
    });

    await checkAndUpdate(dir);

    expect(commands()).toEqual(["git pull --ff-only"]);
  });

  it("릴리스 조회 실패 시 업데이트하지 않음", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    await checkAndUpdate();

    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it("새 버전이 있어도 pull 후 버전이 수렴하지 않으면 build/install을 건너뜀(재빌드 루프 방지)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v9.9.9" }) }),
    );
    vi.mocked(execSync).mockReturnValue(Buffer.from("")); // git pull no-op

    await checkAndUpdate();

    // 실제 package.json 버전 ≠ 9.9.9 → git pull만 시도하고 빌드/설치는 건너뜀
    const cmds = vi.mocked(execSync).mock.calls.map((c) => c[0]);
    expect(cmds).toContain("git pull --ff-only");
    expect(cmds).not.toContain("npm run build");
    expect(cmds).not.toContain("npm install -g .");
  });
});
