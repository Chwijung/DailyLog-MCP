/**
 * 보내기 전 대화 이벤트를 쌓아 두는 로컬 대기열.
 *
 * 이벤트 1건 = 파일 1개 (`<시각>-<event_id>.json`). 여러 hook이 동시에 돌아도
 * 같은 파일을 고치지 않으니 잠금이 필요 없다. 두 번 보내져도 서버가 event_id로 거른다.
 * 경로: ~/.chwijung/chat-spool/<사용자 id>/ (테스트는 CHWIJUNG_CHAT_DIR)
 *
 * - 계정마다 폴더를 나눠, 한 PC를 여러 학생이 쓸 때 다른 학생 글이 지금 계정으로 가지 않게 한다.
 * - 임시 이름(`.tmp`)에 다 쓴 뒤 rename으로 `.json`을 공개한다. 쓰는 도중의 파일을
 *   다른 hook이 읽어 깨진 파일로 지우는 일을 막는다.
 * - 프롬프트 원문이 들어 있으므로 폴더 0700, 파일 0600 (POSIX). Windows는 사용자 프로필
 *   폴더가 기본으로 본인 전용이고, hook마다 icacls를 띄우면 느려서 따로 바꾸지 않는다.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ChatEvent } from "./event.js";

/** 오프라인 상태가 길어도 이 이상은 쌓지 않는다 (오래된 것부터 버림). */
export const MAX_SPOOL = 2000;

/** 쓰다가 죽은 임시 파일은 이만큼 지나면 지운다. */
const STALE_TMP_MS = 10 * 60 * 1000;

const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function chatDir(): string {
  return process.env.CHWIJUNG_CHAT_DIR ?? join(homedir(), ".chwijung", "chat-spool");
}

/** 사용자 id별 대기열 폴더. 폴더 이름으로 쓸 수 없는 id면 null. */
export function userChatDir(userId: unknown, root: string = chatDir()): string | null {
  return typeof userId === "string" && SAFE_USER_ID.test(userId) ? join(root, userId) : null;
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

/** 본인만 들어갈 수 있는 폴더로 만든다. 이미 있던 폴더도 권한을 좁힌다. */
async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  await fs.chmod(dir, 0o700).catch(() => undefined);
}

export async function enqueue(event: ChatEvent, dir: string = chatDir()): Promise<void> {
  await ensurePrivateDir(dir);
  // 같은 ms 안에서도 넣은 순서가 유지되게 프로세스 단조 시계를 덧붙인다
  const seq = String(process.hrtime.bigint() % 10n ** 15n).padStart(15, "0");
  const name = `${String(Date.now()).padStart(13, "0")}-${seq}-${event.event_id}.json`;
  const target = join(dir, name);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(event), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, target);
  await prune(dir);
}

async function prune(dir: string, max: number = MAX_SPOOL): Promise<void> {
  const files = await listFiles(dir);
  const extra = files.length - max;
  if (extra > 0) await removeFiles(files.slice(0, extra), dir);
  await removeStaleTmp(dir);
}

async function removeStaleTmp(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
  } catch {
    return;
  }
  for (const name of names) {
    const stat = await fs.stat(join(dir, name)).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_TMP_MS) await removeFiles([name], dir);
  }
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

/**
 * 사용자별 폴더가 생기기 전(dev 빌드) 최상위에 쌓인 이벤트는 누구 것인지 알 수 없으므로 지운다.
 * 보내지 않고 지우는 쪽이 다른 계정으로 보내는 것보다 안전하다.
 */
export async function dropUnownedEvents(root: string = chatDir()): Promise<void> {
  await removeFiles(await listFiles(root), root);
}

export async function countPending(dir: string = chatDir()): Promise<number> {
  return (await listFiles(dir)).length;
}

export async function removeFiles(files: string[], dir: string = chatDir()): Promise<void> {
  await Promise.all(files.map((f) => fs.unlink(join(dir, f)).catch(() => undefined)));
}
