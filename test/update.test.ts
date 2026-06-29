import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readInstalledVersion } from "../src/update.js";

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
