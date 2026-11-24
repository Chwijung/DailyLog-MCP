import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAUDE_HOOK_EVENTS,
  hookCommandLine,
  installClaudeHooks,
  isChwijungHook,
  listInstalledHooks,
  uninstallClaudeHooks,
} from "../src/hooks-install.js";

let dir: string;
let settings: string;
const CMD = hookCommandLine("claude", "C:\\nodejs\\node.exe", "E:\\DailyLog-MCP\\build\\cli.js");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-hooks-"));
  settings = join(dir, ".claude", "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (): any => JSON.parse(readFileSync(settings, "utf-8"));

describe("hookCommandLine", () => {
  it("node·cli 절대 경로를 슬래시로 바꿔 따옴표로 감싼다", () => {
    expect(CMD).toBe('"C:/nodejs/node.exe" "E:/DailyLog-MCP/build/cli.js" hook --agent claude --owner chwijung-mcp');
    expect(isChwijungHook(CMD)).toBe(true);
    expect(isChwijungHook("rtk hook claude")).toBe(false);
  });
});

describe("installClaudeHooks", () => {
  it("설정 파일이 없으면 만들고 3개 이벤트에 등록한다", async () => {
    expect(await installClaudeHooks(settings, CMD)).toBe("installed");

    const data = read();
    for (const event of CLAUDE_HOOK_EVENTS) {
      const commands = data.hooks[event].flatMap((g: any) => g.hooks.map((h: any) => h.command));
      expect(commands).toEqual([CMD]);
    }
    expect(data.hooks.PostToolUse[0].matcher).toBe("*");
  });

  it("기존 설정과 다른 hook은 그대로 둔다", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        },
      }),
    );

    await installClaudeHooks(settings, CMD);

    const data = read();
    expect(data.model).toBe("opus");
    expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("rtk hook claude");
    const stopCommands = data.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCommands).toEqual(["say done", CMD]);
    expect(existsSync(`${settings}.bak`)).toBe(true);
  });

  it("두 번 실행해도 한 번만 등록된다", async () => {
    await installClaudeHooks(settings, CMD);
    expect(await installClaudeHooks(settings, CMD)).toBe("already");
    expect(read().hooks.Stop).toHaveLength(1);
  });

  it("경로가 바뀐 옛 항목은 새 경로로 교체한다", async () => {
    const old = hookCommandLine("claude", "C:/old/node.exe", "D:/chwijung-mcp/build/cli.js");
    await installClaudeHooks(settings, old);
    expect(await installClaudeHooks(settings, CMD)).toBe("installed");
    const stopCommands = read().hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCommands).toEqual([CMD]);
  });

  it("깨진 JSON이면 덮어쓰지 않고 오류를 낸다", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(settings, "{ broken");
    await expect(installClaudeHooks(settings, CMD)).rejects.toThrow();
    expect(readFileSync(settings, "utf-8")).toBe("{ broken");
  });
});

describe("uninstallClaudeHooks / listInstalledHooks", () => {
  it("우리 항목만 지우고 빈 이벤트는 정리한다", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }),
    );
    await installClaudeHooks(settings, CMD);
    expect(await listInstalledHooks(settings)).toEqual(CLAUDE_HOOK_EVENTS);

    expect(await uninstallClaudeHooks(settings)).toBe(true);

    const data = read();
    expect(data.hooks.Stop[0].hooks[0].command).toBe("say done");
    expect(data.hooks.UserPromptSubmit).toBeUndefined();
    expect(data.hooks.PostToolUse).toBeUndefined();
    expect(await listInstalledHooks(settings)).toEqual([]);
  });

  it("파일이 없으면 false", async () => {
    expect(await uninstallClaudeHooks(settings)).toBe(false);
    expect(await listInstalledHooks(settings)).toEqual([]);
  });
});

describe("경로에 chwijung·DailyLog-MCP 이름이 없을 때 (CodeRabbit #10 리뷰)", () => {
  const PLAIN = hookCommandLine("claude", "/usr/bin/node", "/opt/tools/mcp/build/cli.js");

  it("소유 표식으로 우리 hook을 알아본다", () => {
    expect(isChwijungHook(PLAIN)).toBe(true);
    expect(isChwijungHook('"/usr/bin/node" "/opt/other/cli.js" hook --agent claude')).toBe(false);
  });

  it("설치·재설치·조회·제거가 모두 된다", async () => {
    expect(await installClaudeHooks(settings, PLAIN)).toBe("installed");
    expect(await installClaudeHooks(settings, PLAIN)).toBe("already");
    expect(read().hooks.Stop).toHaveLength(1);
    expect(await listInstalledHooks(settings)).toEqual(CLAUDE_HOOK_EVENTS);
    expect(await uninstallClaudeHooks(settings)).toBe(true);
    expect(existsSync(settings) && read().hooks).toBeFalsy();
  });

  it("표식 없는 옛 항목(chwijung 경로)도 계속 알아보고 새 명령으로 바꾼다", async () => {
    const legacy = '"C:/node.exe" "C:/npm/node_modules/chwijung-mcp/build/cli.js" hook --agent claude';
    expect(isChwijungHook(legacy)).toBe(true);
    await installClaudeHooks(settings, legacy);
    expect(await installClaudeHooks(settings, PLAIN)).toBe("installed");
    const stopCommands = read().hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCommands).toEqual([PLAIN]);
  });
});
