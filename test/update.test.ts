import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("최신 버전이 현재와 같으면 업데이트하지 않음", async () => {
    // CURRENT는 이 레포 package.json의 version(0.1.0)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: "v0.1.0" }) }),
    );

    await checkAndUpdate();

    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
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

    // 실제 package.json(0.1.0) ≠ 9.9.9 → git pull만 시도하고 빌드/설치는 건너뜀
    const cmds = vi.mocked(execSync).mock.calls.map((c) => c[0]);
    expect(cmds).toContain("git pull --ff-only");
    expect(cmds).not.toContain("npm run build");
    expect(cmds).not.toContain("npm install -g .");
  });
});
