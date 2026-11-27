// 빌드한 MCP 서버를 실제로 띄워 initialize → tools/list 가 되는지 확인한다(CI 스모크).
// stdout 은 MCP 프로토콜 전용이라, JSON-RPC 가 아닌 줄이 한 줄이라도 섞이면 실패로 본다.
//
//   node scripts/smoke-mcp.mjs                       # node build/cli.js serve
//   node scripts/smoke-mcp.mjs chwijung-mcp serve    # 전역 설치한 명령
//
// 네트워크·사용자 파일을 건드리지 않도록 임시 홈과 닿지 않는 백엔드 주소를 쓰고,
// 자동 업데이트는 건너뛴다(CHWIJUNG_UPDATED=1).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_TOOLS = ["login", "submit_daily_log", "whoami"];
const TIMEOUT_MS = 30_000;

const [command, ...args] = process.argv.length > 2 ? process.argv.slice(2) : ["node", "build/cli.js", "serve"];
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const home = mkdtempSync(join(tmpdir(), "chwijung-smoke-"));

const child = spawn(command, args, {
  // Windows 의 전역 명령(chwijung-mcp.cmd)은 셸을 거쳐야 실행된다.
  shell: process.platform === "win32" && command !== "node",
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CHWIJUNG_UPDATED: "1",
    CHWIJUNG_API_BASE_URL: "http://127.0.0.1:9",
    CHWIJUNG_SESSION_FILE: join(home, "session.json"),
    CHWIJUNG_CHAT_DIR: join(home, "chat"),
    CHWIJUNG_CHAT_SCOPE_FILE: join(home, "chat-scope.json"),
  },
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buffer = "";
const waiting = new Map();
child.stdout.on("data", (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`stdout 에 MCP 메시지가 아닌 출력이 섞였습니다: ${JSON.stringify(line.slice(0, 200))}`);
    }
    if (msg?.jsonrpc !== "2.0") fail(`JSON-RPC 2.0 메시지가 아닙니다: ${line.slice(0, 200)}`);
    waiting.get(msg.id)?.(msg);
  }
});

child.on("exit", (code, signal) => {
  if (!done) fail(`서버가 먼저 종료됐습니다 (code=${code}, signal=${signal})`);
});

let done = false;
const timer = setTimeout(() => fail(`${TIMEOUT_MS / 1000}초 안에 응답이 없습니다`), TIMEOUT_MS);

function fail(message) {
  done = true;
  clearTimeout(timer);
  console.error(`✗ MCP 스모크 실패: ${message}`);
  if (stderr.trim()) console.error(`--- 서버 stderr ---\n${stderr.trim()}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  child.kill();
  rmSync(home, { recursive: true, force: true });
}

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) =>
    waiting.set(id, (msg) => {
      if (msg.error) fail(`${method} 오류: ${JSON.stringify(msg.error)}`);
      resolve(msg.result);
    }),
  );
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "chwijung-smoke", version: "0" },
});
if (init?.serverInfo?.name !== "chwijung") fail(`서버 이름이 다릅니다: ${JSON.stringify(init?.serverInfo)}`);
if (init.serverInfo.version !== version) {
  fail(`서버 버전(${init.serverInfo.version})이 package.json(${version})과 다릅니다`);
}
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const { tools = [] } = (await request("tools/list", {})) ?? {};
const names = tools.map((t) => t.name).sort();
const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
if (missing.length) fail(`도구가 빠졌습니다: ${missing.join(", ")} (받은 목록: ${names.join(", ")})`);

// 응답 뒤에 늦게 찍히는 stdout 출력도 잡는다.
await new Promise((r) => setTimeout(r, 500));
done = true;
clearTimeout(timer);
cleanup();
console.log(`✓ MCP 스모크 통과: v${version}, 도구 ${names.join(", ")}`);
