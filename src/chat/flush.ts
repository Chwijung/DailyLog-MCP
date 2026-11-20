/**
 * 로컬 대기열의 대화 이벤트를 취몽으로 보낸다.
 *
 * - 100건씩 (Backend 한도), 한 번에 최대 maxBatches 묶음
 * - 성공한 묶음만 지운다. 네트워크·서버 오류면 남겨 두고 다음 Stop 때 다시 보낸다.
 * - 400/422는 다시 보내도 안 되는 형식이라 버린다 (대기열이 막히지 않게).
 * - 로그인·학생 계정이 아니면 예외를 던지고 대기열은 그대로 둔다.
 */

import * as auth from "../auth.js";
import { type ChwijungClient, ValidationError } from "../client.js";
import { chatDir, readPending, removeFiles } from "./spool.js";

export const BATCH_SIZE = 100;

export interface FlushResult {
  sent: number;
  dropped: number;
}

export async function flushChat(
  client: ChwijungClient,
  opts: { dir?: string; maxBatches?: number; timeoutMs?: number } = {},
): Promise<FlushResult> {
  const dir = opts.dir ?? chatDir();
  const maxBatches = opts.maxBatches ?? 5;
  const result: FlushResult = { sent: 0, dropped: 0 };

  let pending = await readPending(BATCH_SIZE, dir);
  if (pending.length === 0) return result;

  const session = await auth.getActiveSession(client);
  if (session.user.role !== "student") {
    throw new auth.NotStudentError("학생(student) 계정만 AI 대화 기록을 보낼 수 있습니다.");
  }

  for (let i = 0; i < maxBatches && pending.length > 0; i++) {
    const files = pending.map((p) => p.file);
    try {
      await client.sendChatEvents(
        session.access_token,
        pending.map((p) => p.event),
        opts.timeoutMs,
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
