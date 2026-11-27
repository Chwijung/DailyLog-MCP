/**
 * Claude Code 설정 파일(settings.local.json / settings.json)에 대화 기록 hook을 넣고 빼기.
 *
 * - 다른 설정과 다른 hook은 건드리지 않는다. 쓰기 전에 `.bak` 백업.
 * - 우리 항목은 명령 끝의 소유 표식(`… hook --agent claude --owner chwijung-mcp`)으로 찾는다.
 *   표식이 없던 옛 설치는 경로에 chwijung/DailyLog-MCP가 있으면 우리 것으로 본다.
 * - hook 명령은 node·cli.js 절대 경로로 쓴다. 맨 이름(`chwijung-mcp`)은 앱이 설치 전 PATH를
 *   들고 있으면 `command not found` 로 모든 hook이 깨진다.
 * - Codex는 hook 설정 형식이 버전마다 달라 아직 자동 설치하지 않는다 (hook 명령 자체는 --agent codex 지원).
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { ChatAgent } from "./chat/event.js";

export const CLAUDE_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;

/** hook 하나가 쓸 수 있는 최대 시간(초). Stop 때 전송(전체 최대 7초)보다 넉넉하게. */
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

/**
 * - local: `<폴더>/.claude/settings.local.json` — 폴더 단위 설치 위치. 개인 설정 파일이라 git에 올리지 않는다.
 * - project: `<폴더>/.claude/settings.json` — 0.3.x까지 쓰던 폴더 단위 위치. 팀이 커밋하는 파일이라
 *   clone한 팀원에게도 hook이 퍼질 수 있어 더는 쓰지 않는다. 남은 항목을 찾아 지우는 데만 쓴다.
 * - global: `~/.claude/settings.json`
 */
export type SettingsScope = "global" | "project" | "local";

export function claudeSettingsPath(scope: SettingsScope, cwd = process.cwd(), home = homedir()): string {
  if (scope === "global") return join(home, ".claude", "settings.json");
  return join(cwd, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}

/** 개인 설정 파일과, 고칠 때 남기는 백업(`.bak`, 예전 hook이 들어 있음) */
export const LOCAL_IGNORE_PATTERNS = ["**/.claude/settings.local.json", "**/.claude/settings.local.json.bak"];

/**
 * file(과 그 `.bak`)이 git 저장소 안에 있고 아직 무시되지 않으면 그 저장소의 `.git/info/exclude`에 넣는다.
 * (Claude Code는 자기가 처음 만든 settings.local.json만 무시 목록에 넣는다. 우리가 만든 파일과 백업은 직접 처리.)
 * `.git/info/exclude`는 이 PC에만 있고 커밋되지 않는다.
 * 반환: "ignored"(이미 무시됨) | "added"(추가함) | "not-git"(저장소 아님) | "failed"(이미 커밋된 파일 등)
 */
export async function ensureGitIgnored(file: string): Promise<"ignored" | "added" | "not-git" | "failed"> {
  const cwd = dirname(file);
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim();
  const ignored = async (p: string): Promise<boolean> => {
    try {
      await git("check-ignore", "-q", p); // 0 = 무시됨, 1 = 아님 (없는 파일도 판정 가능)
      return true;
    } catch {
      return false;
    }
  };
  try {
    await git("rev-parse", "--is-inside-work-tree");
  } catch {
    return "not-git";
  }
  try {
    const targets = [file, `${file}.bak`];
    const todo: string[] = [];
    for (let i = 0; i < targets.length; i++) if (!(await ignored(targets[i]))) todo.push(LOCAL_IGNORE_PATTERNS[i]);
    if (todo.length === 0) return "ignored";

    const exclude = resolve(cwd, await git("rev-parse", "--git-path", "info/exclude"));
    await fs.mkdir(dirname(exclude), { recursive: true });
    let prev = "";
    try {
      prev = await fs.readFile(exclude, "utf-8");
    } catch {
      // 없으면 새로 만든다
    }
    const sep = prev && !prev.endsWith("\n") ? "\n" : "";
    await fs.writeFile(exclude, `${prev}${sep}${todo.join("\n")}\n`, "utf-8");
    for (const t of targets) if (!(await ignored(t))) return "failed"; // 이미 커밋된 파일이면 무시되지 않음
    return "added";
  } catch {
    return "failed";
  }
}

/** build/hooks-install.js 기준 build/cli.js */
export function defaultCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

const slash = (p: string): string => p.replace(/\\/g, "/");

/** 우리가 설치한 hook 명령 끝에 붙이는 소유 표식. 설치 경로 이름과 상관없이 알아보려고 쓴다. */
const OWNER_MARK = "--owner chwijung-mcp";

/** bash·cmd 어느 쪽에서 실행돼도 되게 슬래시 경로 + 큰따옴표. */
export function hookCommandLine(
  agent: ChatAgent,
  nodePath: string = process.execPath,
  cliPath: string = defaultCliPath(),
): string {
  return `"${slash(nodePath)}" "${slash(cliPath)}" hook --agent ${agent} ${OWNER_MARK}`;
}

/** 소유 표식이 있거나, 표식 없던 옛 설치(경로에 chwijung/DailyLog-MCP)면 우리 hook. */
export function isChwijungHook(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (new RegExp(` hook --agent (claude|codex) ${OWNER_MARK}$`).test(command)) return true;
  return / hook --agent (claude|codex)$/.test(command) && /chwijung|dailylog-mcp/i.test(command);
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

/** 폴더 하나의 개인 설정·예전 위치에서 우리 hook을 지운다. 지운 파일 경로 목록. */
export async function uninstallFolderHooks(folder: string): Promise<string[]> {
  const removed: string[] = [];
  for (const scope of ["local", "project"] as const) {
    const path = claudeSettingsPath(scope, folder);
    if (await uninstallClaudeHooks(path)) removed.push(path);
  }
  return removed;
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
