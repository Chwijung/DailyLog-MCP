/**
 * AI 도구 hook 입력(JSON) → 취몽에 보낼 대화 이벤트.
 *
 * 보내는 것: 프롬프트 원문(키는 가림), 사용한 도구 이름, 응답 종료, 작업 폴더 이름.
 * 버리는 것: 도구 입력·출력, 파일 내용, 전체 경로(사용자 이름이 들어 있음), transcript 경로.
 *
 * Claude Code와 Codex는 hook 입력에 같은 이름(hook_event_name, session_id, cwd, prompt,
 * tool_name)을 쓴다.
 */

import { randomUUID } from "node:crypto";

export type ChatAgent = "claude" | "codex";
export type ChatEventType = "prompt" | "tool" | "stop";

export interface ChatEvent {
  event_id: string;
  session_id: string;
  agent: ChatAgent;
  type: ChatEventType;
  content?: string;
  tool_name?: string;
  project?: string;
  occurred_at: string;
}

/** Backend 스키마와 같은 값 (app/schemas/ai_chat.py) */
export const MAX_CONTENT = 20_000;
const MAX_SESSION_ID = 128;
const MAX_TOOL_NAME = 100;
const MAX_PROJECT = 200;

const MASK = "[MASKED]";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic(sk-ant-…)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (Supabase 키 포함)
];

// "password: hunter2", "API_KEY=abc" — 값이 바로 붙어 있을 때만.
// 값 끝에 붙은 닫는 괄호("(password=x)")는 문장 부호로 보고 남긴다.
const KEY_VALUE =
  /\b([A-Za-z_]*(?:password|passwd|pwd|secret|token|api[_-]?key)[A-Za-z_]*)\s*[:=]\s*(?!\[MASKED\])[^\s,;'"]+?(?=[)\]}>]*(?:[\s,;'"]|$))/gi;

/** 프롬프트 안의 흔한 키·토큰·비밀번호 값을 [MASKED]로 바꾼다. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, MASK);
  return out.replace(KEY_VALUE, (_m, key: string) => `${key}=${MASK}`);
}

/** 전체 경로 대신 마지막 폴더 이름만 (Windows·POSIX 모두). */
function projectName(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1];
  return name ? name.slice(0, MAX_PROJECT) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** hook 입력을 이벤트로 바꾼다. 보낼 게 없으면 null. */
export function buildEvent(
  input: unknown,
  agent: ChatAgent,
  now: Date = new Date(),
  newId: () => string = randomUUID,
): ChatEvent | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const sessionId = str(data.session_id);
  if (!sessionId) return null;

  const base = {
    event_id: newId(),
    session_id: sessionId.slice(0, MAX_SESSION_ID),
    agent,
  };
  const tail = {
    project: projectName(data.cwd),
    occurred_at: now.toISOString(),
  };

  switch (data.hook_event_name) {
    case "UserPromptSubmit": {
      const prompt = str(data.prompt);
      if (!prompt) return null;
      return clean({
        ...base,
        type: "prompt",
        content: maskSecrets(prompt).slice(0, MAX_CONTENT),
        ...tail,
      });
    }
    case "PostToolUse": {
      const tool = str(data.tool_name);
      if (!tool) return null;
      return clean({ ...base, type: "tool", tool_name: tool.slice(0, MAX_TOOL_NAME), ...tail });
    }
    case "Stop":
      return clean({ ...base, type: "stop", ...tail });
    default:
      return null;
  }
}

/** undefined 필드를 빼서 JSON을 작게 */
function clean(event: ChatEvent): ChatEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, v]) => v !== undefined),
  ) as unknown as ChatEvent;
}
