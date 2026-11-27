import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoUpdateBlockedReason, syncSource } from "../src/update-source.js";

// 실제 git 저장소로 확인한다. 원격에는 main(릴리스)과 dev(개발 중)가 있다.
let base: string;
let remote: string;
let pub: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args],
    { cwd, stdio: "pipe" },
  )
    .toString()
    .trim();
}

function commit(file: string, content: string): void {
  writeFileSync(join(pub, file), content);
  git(pub, "add", ".");
  git(pub, "commit", "-q", "-m", file);
}

function clone(...args: string[]): string {
  const dir = join(base, "inst");
  git(base, "clone", "-q", ...args, remote, dir);
  git(dir, "config", "core.autocrlf", "false");
  return dir;
}

function branch(dir: string): string {
  return git(dir, "rev-parse", "--abbrev-ref", "HEAD");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "chwijung-source-"));
  remote = join(base, "remote.git");
  pub = join(base, "pub");
  git(base, "init", "-q", "--bare", "-b", "dev", remote);
  git(base, "init", "-q", "-b", "main", pub);
  git(pub, "remote", "add", "origin", remote);
  commit("package-lock.json", "v1");
  git(pub, "branch", "dev");
  commit("release.txt", "released");
  git(pub, "push", "-q", "origin", "main");
  git(pub, "checkout", "-q", "dev");
  commit("wip.txt", "testing");
  git(pub, "push", "-q", "origin", "dev");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

describe("syncSource", () => {
  it.each([[[]], [["--single-branch"]]])(
    "dev 설치본은 main으로 옮겨 릴리스 코드만 받음 (clone %j)",
    (args) => {
      const dir = clone(...args);
      syncSource(dir);
      expect(branch(dir)).toBe("main");
      expect(git(dir, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
      expect(existsSync(join(dir, "wip.txt"))).toBe(false);

      // 다음 릴리스도 main에서 받는다.
      git(pub, "checkout", "-q", "main");
      commit("next.txt", "next");
      git(pub, "push", "-q", "origin", "main");
      syncSource(dir);
      expect(existsSync(join(dir, "next.txt"))).toBe(true);
    },
  );

  it("예전에 받아 둔 로컬 main이 있으면 최신으로 올림", () => {
    const dir = clone();
    git(dir, "branch", "main", "origin/main~1");
    syncSource(dir);
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
  });

  it("main 설치본은 그대로 main을 받음", () => {
    const dir = clone("-b", "main");
    git(pub, "checkout", "-q", "main");
    commit("next.txt", "next");
    git(pub, "push", "-q", "origin", "main");
    syncSource(dir);
    expect(branch(dir)).toBe("main");
    expect(existsSync(join(dir, "next.txt"))).toBe(true);
  });

  it("바뀐 package-lock.json이 막으면 백업하고 되돌린 뒤 옮김", () => {
    git(pub, "checkout", "-q", "main");
    commit("package-lock.json", "v2");
    git(pub, "push", "-q", "origin", "main");
    const dir = clone();
    writeFileSync(join(dir, "package-lock.json"), "local");
    syncSource(dir);
    expect(branch(dir)).toBe("main");
    expect(readFileSync(join(dir, "package-lock.json"), "utf8")).toBe("v2");
    expect(readFileSync(join(dir, ".git", "chwijung-package-lock.json.bak"), "utf8")).toBe("local");
  });
});

describe("autoUpdateBlockedReason", () => {
  it("깨끗한 dev·main 설치본은 막지 않음 (package-lock.json 변경은 허용)", () => {
    const dir = clone();
    expect(autoUpdateBlockedReason(dir)).toBeNull();
    writeFileSync(join(dir, "package-lock.json"), "local");
    expect(autoUpdateBlockedReason(dir)).toBeNull();
    git(dir, "checkout", "-q", "package-lock.json");
    git(dir, "checkout", "-q", "main");
    expect(autoUpdateBlockedReason(dir)).toBeNull();
  });

  it("작업 브랜치·detached HEAD는 건드리지 않음", () => {
    const dir = clone();
    git(dir, "checkout", "-q", "-b", "feat/x");
    expect(autoUpdateBlockedReason(dir)).not.toBeNull();
    git(dir, "checkout", "-q", "--detach");
    expect(autoUpdateBlockedReason(dir)).not.toBeNull();
  });

  it("dev에 커밋하지 않은 수정이나 올리지 않은 커밋이 있으면 건드리지 않음", () => {
    const dir = clone();
    writeFileSync(join(dir, "wip.txt"), "edit");
    expect(autoUpdateBlockedReason(dir)).not.toBeNull();
    git(dir, "commit", "-q", "-am", "local");
    expect(autoUpdateBlockedReason(dir)).not.toBeNull();
  });

  it("git config chwijung.autoUpdate=false면 건드리지 않음", () => {
    const dir = clone();
    git(dir, "config", "chwijung.autoUpdate", "false");
    expect(autoUpdateBlockedReason(dir)).not.toBeNull();
  });
});
