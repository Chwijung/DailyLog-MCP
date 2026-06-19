# 📝 취몽 MCP — 데일리 로그 자동 등록

> **AI 코딩 도구(Claude Code / Codex CLI / Cursor)가 개발 세션을 마치면,
> 그날 한 작업을 요약해서 취몽 데일리 로그에 자동으로 올려주는 MCP 서버입니다.**
>
> 이제 데일리 로그 화면에서 직접 타이핑하지 않아도 돼요. ✨

---

## 🤔 이게 뭐예요? (한눈에)

```
개발/기능 작업 끝  ──▶  AI가 오늘 한 일을 요약  ──▶  취몽 데일리 로그에 자동 등록 ✅
```

- 이 **MCP 서버**가 등록 도구(`submit_daily_log`)를 제공합니다.
- **프로젝트 규칙**(`CLAUDE.md` / `AGENTS.md` / `.cursor/rules`)이 AI에게
  *"세션을 끝내거나 기능 하나를 완료하면 데일리 로그를 등록해"* 라고 지시합니다.
- 요약문은 **그 세션의 맥락을 다 알고 있는 AI가 직접** 작성합니다. 여러분은 확인만 하면 돼요.

> 한 줄 요약: **서버가 도구를 제공하고, 규칙이 "끝나면 호출해"라고 시키고, AI가 요약을 써서 올린다.**

---

## ✅ 시작 전 준비물

| 필요한 것 | 확인 방법 |
|-----------|-----------|
| **Node.js 18 이상** | 터미널에서 `node -v` |
| **취몽 학생(student) 계정** | 데일리 로그는 **학생 계정만** 작성할 수 있어요 |

---

## 🚀 빠른 시작 (3단계)

### 1단계 — 설치 & 빌드 (최초 1회)

```bash
cd chwijung-mcp
npm install
npm run build      # build/index.js 가 생성됩니다
```

### 2단계 — 로그인 (터미널에서 1회)

> 🔒 **보안을 위해 비밀번호는 AI 채팅창이 아니라, 여러분이 터미널에 직접 입력합니다.**

```bash
npx chwijung-mcp login
# 또는 로컬 빌드를 직접 실행:
node ./chwijung-mcp/build/cli.js login
```

- **Claude Code 사용자**는 채팅창에 `! npx chwijung-mcp login` 을 입력하면
  이 세션의 터미널에서 바로 실행됩니다.
- 이메일·비밀번호를 차례로 묻고, **비밀번호는 입력 중 화면에 표시되지 않아요.**
  성공하면 토큰만 `~/.chwijung/session.json`에 저장됩니다(비밀번호는 저장 안 됨).

### 3단계 — 사용 (이후엔 자동!)

이제 **세션을 마무리하거나 기능 하나를 끝낼 때 AI가 알아서** 데일리 로그를 등록합니다.
직접 시키고 싶으면 이렇게 말하면 돼요:

> 💬 "오늘 작업 정리해서 데일리 로그 등록해줘."

> 🟢 **Claude Code를 이 레포에서 실행하면** 루트의 `.mcp.json`에 이미 등록돼 있어
> **자동으로 인식**됩니다. 처음 한 번 MCP 서버 사용 승인 프롬프트에만 동의하면 끝!
> 연결 상태는 `/mcp` 로 확인할 수 있어요.

---

## 🔐 로그인 자세히 (보안)

- **비밀번호는 사람이 터미널에 직접 입력**하고(에코 숨김), **토큰만** 로컬에 캐시됩니다.
  비밀번호는 저장되지 않고, LLM 대화나 MCP 로그에도 남지 않아요.
- 데일리 로그는 **학생(student) 계정만** 작성할 수 있어, 비-학생 계정은 로그인 정보를 저장하지 않습니다.
- access 토큰은 약 1시간 유효하지만, 갱신 시 **회전된 refresh 토큰을 저장**하므로
  재로그인 없이 세션이 계속 유지됩니다. (refresh 체인이 끊겨 세션이 폐기된 경우에만 다시 `login`)

상태 확인 / 로그아웃:

```bash
node ./chwijung-mcp/build/cli.js whoami    # 현재 로그인 상태 확인
node ./chwijung-mcp/build/cli.js logout    # 로그아웃
```

> 🛡️ 토큰 파일(`~/.chwijung/session.json`)은 평문입니다. POSIX는 `0600`, Windows는 `icacls`로
> 현재 사용자만 접근하도록 best-effort 제한합니다. **공용 PC에서는 사용 후 `logout`** 을 권장합니다.

---

## ✍️ 데일리 로그 작성 규칙 & 글자 수 제한

데일리 로그를 등록할 때는 아래 항목으로 작성됩니다. MCP가 백엔드로 보내기 **전에 먼저 검증**하기 때문에,
규칙을 어기면 등록되지 않고 AI가 내용을 다시 채워 호출합니다.
모든 텍스트는 **한국어로, 그 세션에서 실제로 한 일**을 바탕으로 작성돼요 (추측·과장 ❌).

| 필드 | 의미 | 최대 글자 수 | 필수 여부 |
|------|------|:-----------:|:---------:|
| `title` | 작업 요약 제목 | **40자** | ✅ 필수 |
| `feature_name` | 작업한 기능명 | **100자** | ✅ 필수 |
| `problems` | 겪은 문제·이슈 | **200자** | ✅ 필수 |
| `solution` | 해결 방안 | **200자** | ✅ 필수 |
| `result` | 결과·성과 | **200자** | ✅ 필수 |
| `content` | 상세 내용 (마크다운 가능) | **6000자** | 선택 |
| `category` | 프로젝트 단계 | `mini` 또는 `final` | ✅ 필수 |
| `status` | 작업 상태 | `pending` / `in_progress` / `completed` | 기본값 `in_progress` |

**알아두면 좋은 규칙**

- 값이 비어 있거나 공백만 있으면 → `"…는 필수입니다."`,
  글자 수를 넘기면 → `"…는 N자 이하여야 합니다 (현재 X자)."` 메시지로 등록이 거부됩니다.
- `problems` / `solution` / `result` 세 가지는 **항상 필수**입니다.
  (MCP는 임시저장이 아니라 **최종 제출**(`is_draft=false`)로만 등록하기 때문이에요.)
- 기능을 **완전히 끝냈으면** `status`를 `completed`로, **진행 중이면** `in_progress`로 둡니다.
- 한 번 등록하면 **즉시 데일리 로그 화면에 반영**됩니다(임시저장 아님).

---

## 🛠️ 제공 도구

| 도구 | 하는 일 |
|------|---------|
| `login` | 터미널 로그인 방법을 안내합니다 (비밀번호는 AI가 받지 않음). |
| `submit_daily_log` | 오늘 한 작업을 데일리 로그로 **최종 등록**합니다. |
| `whoami` | 현재 로그인 상태·소속 코호트·토큰 유효성을 확인합니다. |

---

## ❓ 문제 해결 (FAQ)

| 증상 | 원인 / 해결 |
|------|-------------|
| "로그인이 필요합니다" | 터미널에서 `npx chwijung-mcp login` (또는 `node ./chwijung-mcp/build/cli.js login`) 실행 |
| "세션이 만료되었습니다" | refresh 토큰 체인이 끊김(폐기) → 터미널에서 다시 `login` |
| "학생(student) 계정만 …" | 코치/멘토/운영자 계정으로는 등록 불가. 로그인 단계에서 비-학생은 세션 저장이 거부됨 |
| "…필수입니다 / N자 이하" | 필수 필드 누락·길이 초과. AI가 내용을 채워 다시 호출하게 두면 됨 |
| MCP 서버가 안 뜸 | `npm run build` 했는지, `node -v` ≥18, `build/index.js`(또는 `build/cli.js`) 경로, `CHWIJUNG_API_BASE_URL` 확인 |

---
---

## 🧑‍💻 개발자용 (참고)

> 여기부터는 **MCP 서버를 등록·유지보수하는 사람**을 위한 내용입니다. 수강생은 위 내용만으로 충분해요.

### 다른 도구에 MCP 등록하기

백엔드 주소는 환경변수 `CHWIJUNG_API_BASE_URL`로 주입합니다(배포 주소, 로컬은 `http://localhost:8000`).
**비밀번호·토큰은 설정 파일에 넣지 않습니다.** 인증은 터미널 `login` 1회로 끝납니다.

**Claude Code** — 레포 루트 `.mcp.json`에 이미 포함되어 있어 자동 인식됩니다.

```jsonc
// .mcp.json (레포 루트, 커밋됨)
{
  "mcpServers": {
    "chwijung": {
      "command": "node",
      "args": ["./chwijung-mcp/build/index.js"],
      "env": { "CHWIJUNG_API_BASE_URL": "${CHWIJUNG_API_BASE_URL:-http://localhost:8000}" }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`에 추가 (경로는 절대경로 권장):

```toml
[mcp_servers.chwijung]
command = "node"
args = ["C:/Users/<당신>/.../Chwijung/chwijung-mcp/build/index.js"]
env = { CHWIJUNG_API_BASE_URL = "https://<백엔드-주소>" }
```

**Cursor** — `.cursor/mcp.json` (레포 루트, 포함됨):

```json
{
  "mcpServers": {
    "chwijung": {
      "command": "node",
      "args": ["./chwijung-mcp/build/index.js"],
      "env": { "CHWIJUNG_API_BASE_URL": "http://localhost:8000" }
    }
  }
}
```

### 이 패키지 자체 개발

```bash
cd chwijung-mcp
npm install
npm test           # Vitest (단위 + 인메모리 MCP 통합)
npm run build      # tsc → build/
```

구조 (`src/`):

- `session.ts` — 토큰 캐시(`~/.chwijung/session.json`, 소유자 전용 권한). 테스트는 `CHWIJUNG_SESSION_FILE`로 경로 격리
- `client.ts` — 백엔드 `/api/v2` 호출(login/refresh/submit). `fetchFn` 주입으로 모킹
- `auth.ts` — 로그인 저장 + 만료 시 **회전 갱신**(refresh 토큰 회전 저장) + 학생 게이트
- `server.ts` — MCP 도구(`login`=터미널 안내, `submit_daily_log`, `whoami`) + 입력 검증
- `cli.ts` — 터미널 진입점(서브커맨드 `login`/`logout`/`whoami`, 인자 없으면 서버 실행). 비밀번호 에코 숨김
- `serve.ts` — MCP stdio 서버 실행(공유)
- `index.ts` — stdio 진입점(`.mcp.json`이 직접 실행)

### (선택) npx 무설치 배포

npm에 publish 하면 빌드·설치 단계 없이 배포할 수 있습니다:

```json
"chwijung": { "command": "npx", "args": ["-y", "chwijung-mcp"], "env": { "CHWIJUNG_API_BASE_URL": "https://<백엔드-주소>" } }
```
