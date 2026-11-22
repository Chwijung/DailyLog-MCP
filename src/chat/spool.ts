/**
 * 보내기 전 대화 이벤트를 쌓아 두는 로컬 대기열.
 *
 * 이벤트 1건 = 파일 1개 (`<시각>-<event_id>.json`). 여러 hook이 동시에 돌아도
 * 같은 파일을 고치지 않으니 잠금이 필요 없다. 두 번 보내져도 서버가 event_id로 거른다.
 * 경로: ~/.chwijung/chat-spool (테스트는 CHWIJUNG_CHAT_DIR)
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ChatEvent } from "./event.js";

/** 오프라인·로그아웃 상태가 길어도 이 이상은 쌓지 않는다 (오래된 것부터 버림). */
export const MAX_SPOOL = 2000;

export function chatDir(): string {
  return process.env.CHWIJUNG_CHAT_DIR ?? join(homedir(), ".chwijung", "chat-spool");
}

export interface PendingEvent {
  file: string;
  event: ChatEvent;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export async function enqueue(event: ChatEvent, dir: string = chatDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  // 같은 ms 안에서도 넣은 순서가 유지되게 프로세스 단조 시계를 덧붙인다
  const seq = String(process.hrtime.bigint() % 10n ** 15n).padStart(15, "0");
  const name = `${String(Date.now()).padStart(13, "0")}-${seq}-${event.event_id}.json`;
  await fs.writeFile(join(dir, name), JSON.stringify(event), "utf-8");
  await prune(dir);
}

async function prune(dir: string, max: number = MAX_SPOOL): Promise<void> {
  const files = await listFiles(dir);
  const extra = files.length - max;
  if (extra <= 0) return;
  await removeFiles(files.slice(0, extra), dir);
}

/** 오래된 순으로 최대 limit건. 읽을 수 없는 파일은 지운다. */
export async function readPending(limit: number, dir: string = chatDir()): Promise<PendingEvent[]> {
  const out: PendingEvent[] = [];
  for (const file of await listFiles(dir)) {
    if (out.length >= limit) break;
    try {
      const event = JSON.parse(await fs.readFile(join(dir, file), "utf-8")) as ChatEvent;
      if (!event?.event_id) throw new Error("bad event");
      out.push({ file, event });
    } catch {
      await removeFiles([file], dir);
    }
  }
  return out;
}

export async function countPending(dir: string = chatDir()): Promise<number> {
  return (await listFiles(dir)).length;
}

export async function removeFiles(files: string[], dir: string = chatDir()): Promise<void> {
  await Promise.all(files.map((f) => fs.unlink(join(dir, f)).catch(() => undefined)));
}
