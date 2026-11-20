/**
 * Claude Code settings.json 에 대화 기록 hook을 넣고 빼기.
 *
 * - 다른 설정과 다른 hook은 건드리지 않는다. 쓰기 전에 `.bak` 백업.
 * - 우리 항목은 명령 모양(`… hook --agent claude` + 경로에 chwijung/DailyLog-MCP)으로 찾는다.
 * - hook 명령은 node·cli.js 절대 경로로 쓴다. 맨 이름(`chwijung-mcp`)은 앱이 설치 전 PATH를
 *   들고 있으면 `command not found` 로 모든 hook이 깨진다.
 * - Codex는 hook 설정 형식이 버전마다 달라 아직 자동 설치하지 않는다 (hook 명령 자체는 --agent codex 지원).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatAgent } from "./chat/event.js";

export const CLAUDE_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;

/** hook 하나가 쓸 수 있는 최대 시간(초). Stop 때 전송(최대 4초)보다 넉넉하게. */
const HOOK_TIMEOUT_SECONDS = 10;

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export function claudeSettingsPath(scope: "global" | "project", cwd = process.cwd(), home = homedir()): string {
  return scope === "global" ? join(home, ".claude", "settings.json") : join(cwd, ".claude", "settings.json");
}

/** build/hooks-install.js 기준 build/cli.js */
export function defaultCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

const slash = (p: string): string => p.replace(/\\/g, "/");

/** bash·cmd 어느 쪽에서 실행돼도 되게 슬래시 경로 + 큰따옴표. */
export function hookCommandLine(
  agent: ChatAgent,
  nodePath: string = process.execPath,
  cliPath: string = defaultCliPath(),
): string {
  return `"${slash(nodePath)}" "${slash(cliPath)}" hook --agent ${agent}`;
}

export function isChwijungHook(command: unknown): boolean {
  return (
    typeof command === "string" &&
    / hook --agent (claude|codex)$/.test(command) &&
    /chwijung|dailylog-mcp/i.test(command)
  );
}

async function readSettings(path: string): Promise<{ data: Settings; raw: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch {
    return { data: {}, raw: null };
  }
  const data = raw.trim() ? JSON.parse(raw) : {}; // 깨진 JSON이면 예외 → 덮어쓰지 않음
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path} 의 형식이 올바르지 않습니다 (JSON 객체가 아님)`);
  }
  return { data, raw };
}

async function writeSettings(path: string, data: Settings, raw: string | null): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  if (raw !== null) await fs.writeFile(`${path}.bak`, raw, "utf-8");
  await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** 우리 항목을 뺀 hooks. 비게 된 그룹·이벤트는 지운다. */
function withoutOurs(hooks: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isChwijungHook(h.command)) }))
      .filter((g, i) => g.hooks.length > 0 || (groups[i].hooks ?? []).length === 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

function ourCommands(hooks: Record<string, HookGroup[]> | undefined, event: string): string[] {
  const groups = hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter(isChwijungHook) as string[];
}

/** 이미 같은 명령으로 3개 이벤트에 다 있으면 "already". */
export async function installClaudeHooks(path: string, command: string): Promise<"installed" | "already"> {
  const { data, raw } = await readSettings(path);
  const already = CLAUDE_HOOK_EVENTS.every((e) => {
    const cmds = ourCommands(data.hooks, e);
    return cmds.length === 1 && cmds[0] === command;
  });
  if (already) return "already";

  const hooks = withoutOurs(data.hooks ?? {});
  for (const event of CLAUDE_HOOK_EVENTS) {
    const group: HookGroup = {
      ...(event === "PostToolUse" ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
    };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  await writeSettings(path, { ...data, hooks }, raw);
  return "installed";
}

/** 우리 항목을 지웠으면 true. */
export async function uninstallClaudeHooks(path: string): Promise<boolean> {
  let read: { data: Settings; raw: string | null };
  try {
    read = await readSettings(path);
  } catch {
    return false; // 깨진 파일은 건드리지 않음
  }
  const { data, raw } = read;
  if (raw === null || !data.hooks) return false;
  if (!Object.keys(data.hooks).some((e) => ourCommands(data.hooks, e).length > 0)) return false;

  const hooks = withoutOurs(data.hooks);
  const next: Settings = { ...data, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  await writeSettings(path, next, raw);
  return true;
}

/** 우리 hook이 걸린 이벤트 목록 */
export async function listInstalledHooks(path: string): Promise<string[]> {
  try {
    const { data } = await readSettings(path);
    return CLAUDE_HOOK_EVENTS.filter((e) => ourCommands(data.hooks, e).length > 0);
  } catch {
    return [];
  }
}
