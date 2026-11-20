import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEvent, MAX_CONTENT, maskSecrets } from "../src/chat/event.js";
import { flushChat } from "../src/chat/flush.js";
import { enqueue, MAX_SPOOL, readPending } from "../src/chat/spool.js";
import { ChwijungClient } from "../src/client.js";
import { hookCommand } from "../src/hook.js";
import { saveSession } from "../src/session.js";
import { mockFetch } from "./helpers.js";

const NOW = new Date("2026-11-20T01:00:00.000Z");
let n = 0;
const ids = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

let dir: string;
let spool: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chwijung-chat-"));
  spool = join(dir, "spool");
  process.env.CHWIJUNG_SESSION_FILE = join(dir, "session.json");
  process.env.CHWIJUNG_CHAT_DIR = spool;
});

afterEach(() => {
  delete process.env.CHWIJUNG_SESSION_FILE;
  delete process.env.CHWIJUNG_CHAT_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function loginAsStudent(): Promise<void> {
  await saveSession({
    access_token: "A",
    refresh_token: "R",
    expires_at: Date.now() / 1000 + 3600,
    cohort_id: "c1",
    user: { id: "u1", role: "student" },
  });
}

// ==================== 이벤트 만들기 ====================

describe("buildEvent", () => {
  it("UserPromptSubmit → prompt 이벤트 (원문, 폴더 이름만)", () => {
    const ev = buildEvent(
      {
        session_id: "s1",
        cwd: "C:\\Users\\someone\\projects\\rag-chatbot",
        hook_event_name: "UserPromptSubmit",
        prompt: "검색 결과에 재순위 붙여줘",
      },
      "claude",
      NOW,
      () => "id-1",
    );
    expect(ev).toEqual({
      event_id: "id-1",
      session_id: "s1",
      agent: "claude",
      type: "prompt",
      content: "검색 결과에 재순위 붙여줘",
      project: "rag-chatbot",
      occurred_at: "2026-11-20T01:00:00.000Z",
    });
  });

  it("PostToolUse → tool 이벤트, 도구 입력·출력은 버림", () => {
    const ev = buildEvent(
      {
        session_id: "s1",
        cwd: "/home/u/app",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "cat .env" },
        tool_response: { stdout: "SECRET=1" },
      },
      "codex",
      NOW,
      () => "id-2",
    );
    expect(ev).toEqual({
      event_id: "id-2",
      session_id: "s1",
      agent: "codex",
      type: "tool",
      tool_name: "Bash",
      project: "app",
      occurred_at: "2026-11-20T01:00:00.000Z",
    });
    expect(JSON.stringify(ev)).not.toContain("SECRET");
  });

  it("Stop → stop 이벤트", () => {
    const ev = buildEvent({ session_id: "s1", hook_event_name: "Stop" }, "claude", NOW, () => "id");
    expect(ev?.type).toBe("stop");
    expect(ev?.content).toBeUndefined();
  });

  it("모르는 이벤트·빈 프롬프트·session_id 없음은 null", () => {
    expect(buildEvent({ session_id: "s", hook_event_name: "Notification" }, "claude")).toBeNull();
    expect(
      buildEvent({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "  " }, "claude"),
    ).toBeNull();
    expect(buildEvent({ hook_event_name: "Stop" }, "claude")).toBeNull();
    expect(buildEvent("not an object", "claude")).toBeNull();
  });

  it("긴 프롬프트는 자르고, 키는 가린다", () => {
    const ev = buildEvent(
      {
        session_id: "s",
        hook_event_name: "UserPromptSubmit",
        prompt: `키는 sk-ant-api03-abcdefghijklmnopqrstuv 야 ${"가".repeat(MAX_CONTENT)}`,
      },
      "claude",
    );
    expect(ev?.content?.length).toBe(MAX_CONTENT);
    expect(ev?.content).not.toContain("sk-ant-api03");
    expect(ev?.content).toContain("[MASKED]");
  });
});

describe("maskSecrets", () => {
  it.each([
    ["OpenAI", "sk-proj-AbCdEfGhIjKlMnOpQrStUv12"],
    ["GitHub", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["GitHub PAT", "github_pat_11ABCDEFG0123456789_abcdefghijk"],
    ["AWS", "AKIAABCDEFGHIJKLMNOP"],
    ["Google", "AIzaSyA-1234567890abcdefghijklmnopqrstu"],
    ["Slack", "xoxb-1234567890-abcdefghij"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
  ])("%s 토큰을 가린다", (_name, secret) => {
    const out = maskSecrets(`이거 써 ${secret} 끝`);
    expect(out).not.toContain(secret);
    expect(out).toBe("이거 써 [MASKED] 끝");
  });

  it("password=… 형태의 값을 가린다", () => {
    expect(maskSecrets("DB password: hunter2 로 접속")).toBe("DB password=[MASKED] 로 접속");
    expect(maskSecrets("API_KEY=abc123")).toBe("API_KEY=[MASKED]");
  });

  it("개인 키 블록을 가린다", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(maskSecrets(`키: ${pem}`)).toBe("키: [MASKED]");
  });

  it("평범한 문장은 그대로", () => {
    const text = "token 비교 로직을 고치고 password 검증 테스트를 추가해줘";
    expect(maskSecrets(text)).toBe(text);
  });
});

// ==================== 로컬 대기열 ====================

describe("spool", () => {
  it("넣은 순서대로 읽는다", async () => {
    const a = buildEvent({ session_id: "s", hook_event_name: "Stop" }, "claude", NOW, ids)!;
    const b = buildEvent({ session_id: "s", hook_event_name: "Stop" }, "claude", NOW, ids)!;
    await enqueue(a);
    await enqueue(b);
    const pending = await readPending(10);
    expect(pending.map((p) => p.event.event_id)).toEqual([a.event_id, b.event_id]);
  });

  it("깨진 파일은 지우고 건너뛴다", async () => {
    await enqueue(buildEvent({ session_id: "s", hook_event_name: "Stop" }, "claude", NOW, ids)!);
    writeFileSync(join(spool, "0000000000000-broken.json"), "{oops");
    const pending = await readPending(10);
    expect(pending).toHaveLength(1);
    expect(readdirSync(spool)).toHaveLength(1);
  });

  it(`${MAX_SPOOL}건이 넘으면 오래된 것부터 버린다`, async () => {
    mkdirSync(spool, { recursive: true });
    for (let i = 0; i < MAX_SPOOL + 3; i++) {
      writeFileSync(join(spool, `${String(i).padStart(13, "0")}-x${i}.json`), "{}");
    }
    await enqueue(buildEvent({ session_id: "s", hook_event_name: "Stop" }, "claude", NOW, ids)!);
    const files = readdirSync(spool).sort();
    expect(files).toHaveLength(MAX_SPOOL);
    expect(files[0]).toBe(`${String(4).padStart(13, "0")}-x4.json`);
  });
});

// ==================== 서버로 보내기 ====================

function prompt(text: string) {
  return buildEvent(
    { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: text },
    "claude",
    NOW,
    ids,
  )!;
}

describe("flushChat", () => {
  it("대기열을 보내고 성공한 건 지운다", async () => {
    await loginAsStudent();
    await enqueue(prompt("하나"));
    await enqueue(prompt("둘"));
    const bodies: any[] = [];
    const client = new ChwijungClient(
      "http://test",
      mockFetch((url, init) => {
        expect(url).toBe("http://test/api/v2/ai-chat/events");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer A");
        bodies.push(JSON.parse(init.body as string));
        return { status: 200, body: { accepted: 2 } };
      }),
    );

    const result = await flushChat(client);

    expect(result.sent).toBe(2);
    expect(bodies[0].events.map((e: any) => e.content)).toEqual(["하나", "둘"]);
    expect(await readPending(10)).toHaveLength(0);
  });

  it("100건씩 나눠 보낸다", async () => {
    await loginAsStudent();
    for (let i = 0; i < 150; i++) await enqueue(prompt(`p${i}`));
    const sizes: number[] = [];
    const client = new ChwijungClient(
      "http://test",
      mockFetch((_url, init) => {
        const count = JSON.parse(init.body as string).events.length;
        sizes.push(count);
        return { status: 200, body: { accepted: count } };
      }),
    );

    await flushChat(client);

    expect(sizes).toEqual([100, 50]);
  });

  it("서버 오류면 대기열을 남긴다", async () => {
    await loginAsStudent();
    await enqueue(prompt("하나"));
    const client = new ChwijungClient("http://test", mockFetch(() => ({ status: 500, body: {} })));

    await expect(flushChat(client)).rejects.toThrow();
    expect(await readPending(10)).toHaveLength(1);
  });

  it("422(서버가 거절한 형식)는 다시 보내도 안 되므로 버린다", async () => {
    await loginAsStudent();
    await enqueue(prompt("하나"));
    const client = new ChwijungClient("http://test", mockFetch(() => ({ status: 422, body: {} })));

    const result = await flushChat(client);

    expect(result.dropped).toBe(1);
    expect(await readPending(10)).toHaveLength(0);
  });

  it("로그인 안 했으면 보내지 않고 남긴다", async () => {
    await enqueue(prompt("하나"));
    let called = false;
    const client = new ChwijungClient(
      "http://test",
      mockFetch(() => {
        called = true;
        return { status: 200, body: {} };
      }),
    );

    await expect(flushChat(client)).rejects.toThrow();
    expect(called).toBe(false);
    expect(await readPending(10)).toHaveLength(1);
  });
});

// ==================== hook 명령 ====================

describe("hookCommand", () => {
  it("prompt는 쌓기만 하고 보내지 않는다 (프롬프트를 늦추지 않기)", async () => {
    await loginAsStudent();
    let called = false;
    const client = new ChwijungClient(
      "http://test",
      mockFetch(() => {
        called = true;
        return { status: 200, body: { accepted: 1 } };
      }),
    );
    const stdin = JSON.stringify({
      session_id: "s",
      hook_event_name: "UserPromptSubmit",
      prompt: "안녕",
    });

    const code = await hookCommand(stdin, { agent: "claude", client });

    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(await readPending(10)).toHaveLength(1);
  });

  it("stop에서 쌓인 것을 함께 보낸다", async () => {
    await loginAsStudent();
    let sent = 0;
    const client = new ChwijungClient(
      "http://test",
      mockFetch((_url, init) => {
        sent += JSON.parse(init.body as string).events.length;
        return { status: 200, body: { accepted: 1 } };
      }),
    );
    await hookCommand(
      JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "안녕" }),
      { agent: "claude", client },
    );

    const code = await hookCommand(JSON.stringify({ session_id: "s", hook_event_name: "Stop" }), {
      agent: "claude",
      client,
    });

    expect(code).toBe(0);
    expect(sent).toBe(2);
    expect(await readPending(10)).toHaveLength(0);
  });

  it("깨진 입력·전송 실패에도 항상 0으로 끝난다", async () => {
    const failing = new ChwijungClient("http://test", mockFetch(() => ({ status: 500, body: {} })));
    expect(await hookCommand("{oops", { agent: "claude", client: failing })).toBe(0);
    expect(
      await hookCommand(JSON.stringify({ session_id: "s", hook_event_name: "Stop" }), {
        agent: "claude",
        client: failing,
      }),
    ).toBe(0);
  });
});
