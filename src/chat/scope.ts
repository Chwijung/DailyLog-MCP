/**
 * AI 대화 기록 범위 설정: 수집에서 뺄 폴더 목록, hook을 켠 프로젝트 폴더 목록.
 *
 * 경로: ~/.chwijung/chat-scope.json (테스트는 CHWIJUNG_CHAT_SCOPE_FILE)
 * - excluded: 이 폴더와 하위 폴더에서 연 대화는 hook이 대기열에 쌓지 않는다 (전역으로 켰을 때 일부만 빼기).
 * - projects: `hooks install` 로 켠 폴더. `hooks uninstall --all` 이 이 목록을 돌며 끈다.
 * 파일이 없거나 깨졌으면 빈 설정으로 본다 (hook은 늘 조용히 동작해야 하므로).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

export interface ChatScope {
  excluded: string[];
  projects: string[];
}

export function scopeFile(home: string = homedir()): string {
  return process.env.CHWIJUNG_CHAT_SCOPE_FILE ?? join(home, ".chwijung", "chat-scope.json");
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

export async function loadScope(file: string = scopeFile()): Promise<ChatScope> {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf-8"));
    return { excluded: strings(data?.excluded), projects: strings(data?.projects) };
  } catch {
    return { excluded: [], projects: [] };
  }
}

export async function saveScope(scope: ChatScope, file: string = scopeFile()): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(scope, null, 2)}\n`, "utf-8");
}

/** 비교용 경로: 절대 경로, Windows는 대소문자 무시. */
function key(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function samePath(a: string, b: string): boolean {
  return key(a) === key(b);
}

/** child가 parent 자신이거나 그 안에 있으면 true. */
export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(key(parent), key(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** cwd가 제외 목록의 폴더(또는 그 하위)면 그 제외 폴더를 돌려준다. */
export function excludedBy(cwd: string, scope: ChatScope): string | null {
  return scope.excluded.find((ex) => isInsidePath(cwd, ex)) ?? null;
}

const withPath = (list: string[], p: string): string[] =>
  list.some((x) => samePath(x, p)) ? list : [...list, resolve(p)];
const withoutPath = (list: string[], p: string): string[] => list.filter((x) => !samePath(x, p));

/** 설정 파일을 읽어 고친 뒤 저장. 바뀐 설정을 돌려준다. */
async function updateScope(file: string, change: (s: ChatScope) => ChatScope): Promise<ChatScope> {
  const next = change(await loadScope(file));
  await saveScope(next, file);
  return next;
}

export const addExcluded = (p: string, file = scopeFile()) =>
  updateScope(file, (s) => ({ ...s, excluded: withPath(s.excluded, p) }));
export const removeExcluded = (p: string, file = scopeFile()) =>
  updateScope(file, (s) => ({ ...s, excluded: withoutPath(s.excluded, p) }));
export const addProject = (p: string, file = scopeFile()) =>
  updateScope(file, (s) => ({ ...s, projects: withPath(s.projects, p) }));
export const removeProjects = (paths: string[], file = scopeFile()) =>
  updateScope(file, (s) => ({ ...s, projects: s.projects.filter((x) => !paths.some((p) => samePath(x, p))) }));
