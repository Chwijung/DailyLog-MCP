/**
 * `chwijung-mcp hook --agent <claude|codex>` — AI 도구 hook에서 실행된다.
 *
 * stdin의 hook 입력을 이벤트로 바꿔 로컬 대기열에 쌓고, Stop(응답 끝)일 때만 취몽으로 보낸다.
 * 프롬프트 입력(UserPromptSubmit) 때 네트워크를 타지 않아 사용자 작업을 늦추지 않는다.
 *
 * 규칙: 무슨 일이 있어도 0으로 끝나고 stdout에 아무것도 쓰지 않는다.
 * (UserPromptSubmit hook의 stdout은 대화에 끼어들고, 0이 아닌 종료 코드는 작업을 막을 수 있다.)
 */

import { type ChatAgent, buildEvent } from "./chat/event.js";
import { flushChat } from "./chat/flush.js";
import { enqueue } from "./chat/spool.js";
import { ChwijungClient } from "./client.js";
import { getBaseUrl } from "./config.js";

/** Stop 때 서버 전송에 쓰는 최대 시간. hook timeout(설치 시 10초)보다 짧게. */
const SEND_TIMEOUT_MS = 4000;

export interface HookOptions {
  agent: ChatAgent;
  client?: ChwijungClient;
  dir?: string;
}

export async function hookCommand(stdin: string, opts: HookOptions): Promise<number> {
  try {
    const event = buildEvent(JSON.parse(stdin), opts.agent);
    if (!event) return 0;
    await enqueue(event, opts.dir);
    if (event.type === "stop") {
      const client = opts.client ?? new ChwijungClient(getBaseUrl());
      await flushChat(client, { dir: opts.dir, timeoutMs: SEND_TIMEOUT_MS });
    }
  } catch {
    // 조용히 넘어간다: 대기열에 남은 건 다음 Stop 때 다시 보낸다.
  }
  return 0;
}

/** stdin 전체를 읽는다. 터미널에서 직접 실행했거나 입력이 안 오면 빈 문자열. */
export function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}
