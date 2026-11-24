/**
 * 로컬 대기열의 대화 이벤트를 취몽으로 보낸다.
 *
 * - 지금 로그인한 계정의 대기열 폴더만 보낸다. 다른 계정이 남긴 이벤트는 그 계정이
 *   다시 로그인할 때까지 남겨 둔다 (다른 학생 글이 지금 계정으로 가지 않게).
 * - 100건씩 (Backend 한도), 한 번에 최대 maxBatches 묶음
 * - budgetMs: 세션 갱신부터 마지막 묶음까지 전체 시간. 남은 시간이 모자라면 시작하지 않고
 *   다음 Stop으로 미룬다. 요청마다의 제한(timeoutMs)도 남은 시간보다 길지 않게 줄인다.
 * - 성공한 묶음만 지운다. 네트워크·서버 오류면 남겨 두고 다음 Stop 때 다시 보낸다.
 * - 400/422는 다시 보내도 안 되는 형식이라 버린다 (대기열이 막히지 않게).
 * - 로그인·학생 계정이 아니면 예외를 던지고 대기열은 그대로 둔다.
 */

import * as auth from "../auth.js";
import { type ChwijungClient, ValidationError } from "../client.js";
import { loadSession } from "../session.js";
import { chatDir, dropUnownedEvents, readPending, removeFiles, userChatDir } from "./spool.js";

export const BATCH_SIZE = 100;

/** 남은 시간이 이보다 적으면 새 요청을 시작하지 않는다. */
export const MIN_REQUEST_MS = 1500;

export interface FlushResult {
  sent: number;
  dropped: number;
}

export interface FlushOptions {
  /** 대기열 최상위 폴더 (사용자별 폴더의 부모) */
  dir?: string;
  maxBatches?: number;
  /** 요청 하나의 최대 시간 */
  timeoutMs?: number;
  /** 세션 갱신부터 마지막 묶음까지 전체 최대 시간 */
  budgetMs?: number;
  now?: () => number;
}

export async function flushChat(client: ChwijungClient, opts: FlushOptions = {}): Promise<FlushResult> {
  const root = opts.dir ?? chatDir();
  const maxBatches = opts.maxBatches ?? 5;
  const now = opts.now ?? Date.now;
  const deadline = opts.budgetMs === undefined ? Infinity : now() + opts.budgetMs;
  const result: FlushResult = { sent: 0, dropped: 0 };

  /** 이번 요청에 쓸 시간. 남은 시간이 모자라면 null. */
  const requestTimeout = (): number | undefined | null => {
    const left = deadline - now();
    if (left < MIN_REQUEST_MS) return null;
    if (left === Infinity) return opts.timeoutMs;
    return Math.min(opts.timeoutMs ?? left, left);
  };

  await dropUnownedEvents(root);
  const local = await loadSession();
  if (!local) throw new auth.NotLoggedInError("로그인이 필요합니다.");
  const dir = userChatDir(local.user.id, root);
  if (!dir) throw new auth.NotLoggedInError("세션에 사용자 정보가 없습니다. 다시 로그인하세요.");

  let pending = await readPending(BATCH_SIZE, dir);
  if (pending.length === 0) return result;

  const refreshTimeout = requestTimeout();
  if (refreshTimeout === null) return result;
  const session = await auth.getActiveSession(client, { timeoutMs: refreshTimeout });
  if (session.user.id !== local.user.id) {
    throw new auth.NotLoggedInError("세션 계정이 바뀌었습니다. 다음 응답 때 다시 보냅니다.");
  }
  if (session.user.role !== "student") {
    throw new auth.NotStudentError("학생(student) 계정만 AI 대화 기록을 보낼 수 있습니다.");
  }

  for (let i = 0; i < maxBatches && pending.length > 0; i++) {
    const timeoutMs = requestTimeout();
    if (timeoutMs === null) break; // 남은 건 다음 Stop에서
    const files = pending.map((p) => p.file);
    try {
      await client.sendChatEvents(
        session.access_token,
        pending.map((p) => p.event),
        timeoutMs,
      );
      result.sent += files.length;
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      result.dropped += files.length;
    }
    await removeFiles(files, dir);
    pending = await readPending(BATCH_SIZE, dir);
  }
  return result;
}
