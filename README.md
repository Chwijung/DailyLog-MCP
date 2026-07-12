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

## 🎬 데모 영상

> MCP 연결부터 데일리 로그 자동 등록까지 한 번에 보기

https://github.com/user-attachments/assets/7a7c0dd9-b40d-46a4-9757-aa12af491c2f

---

## ✅ 시작 전 준비물

| 필요한 것 | 확인 방법 |
|-----------|-----------|
| **Node.js 18 이상** | 터미널에서 `node -v` |
| **취몽 학생(student) 계정** | 데일리 로그는 **학생 계정만** 작성할 수 있어요 |

---

## 🚀 빠른 시작 (4단계)

### 1단계 — 설치 (최초 1회)

> 📌 **클론 위치·폴더명은 무관합니다.** 한 번만 설치해 두면 이후 어떤 프로젝트에서든
> `npx chwijung-mcp …` 로 쓸 수 있어요.

```bash
git clone <…>/DailyLog-MCP.git   # 폴더명은 무엇이든 OK
cd DailyLog-MCP                   # 클론한 폴더로 이동
npm install
npm run build                    # build/ 가 생성됩니다
npm install -g .                 # 전역 명령어 'chwijung-mcp' 등록
```

이제 `npx chwijung-mcp whoami` 가 **아무 폴더에서나** 동작하면 설치 성공입니다.

### 2단계 — 내 AI 도구에 등록 (최초 1회)

쓰는 도구의 MCP 설정에 아래 항목을 추가하세요.

**Claude Code** — 작업하는 프로젝트의 `.mcp.json` (또는 터미널 `claude mcp add`)에:

```json
{
  "mcpServers": {
    "chwijung": {
      "command": "npx",
      "args": ["-y", "chwijung-mcp"]
    }
  }
}
```

> 터미널에서 한 줄로 끝내려면: `claude mcp add chwijung -- npx -y chwijung-mcp`

**Cursor** — `.cursor/mcp.json` 에 위와 동일한 내용을 추가합니다.

**Antigravity** — `~/.gemini/config/mcp_config.json` 에 위와 동일한 `mcpServers` JSON을 추가합니다.
(IDE에서는 설정 → Customizations → Open MCP Config 로 같은 파일을 열 수 있어요.)

**Codex CLI** — `~/.codex/config.toml` 에:

```toml
[mcp_servers.chwijung]
command = "npx"
args = ["-y", "chwijung-mcp"]
```

> 터미널에서 한 줄로 끝내려면: `codex mcp add chwijung -- npx -y chwijung-mcp`

> 등록되면 `/mcp` 로 연결 상태를 확인할 수 있어요. 처음 한 번 MCP 서버 사용 승인
> 프롬프트에만 동의하면 끝!

### 3단계 — 연결 (최초 1회)

두 가지 방법이 있어요. **웹에서 연결 코드를 발급받는 [방법 1]이 더 간편하고 안전합니다**
(비밀번호를 어디에도 입력하지 않아요). 터미널에서 직접 로그인하려면 [방법 2]를 쓰세요.

#### [방법 1] 웹에서 연결 코드로 연결 (권장)

1. 취몽 웹에 로그인한 뒤, 데일리 로그 화면에서 **`MCP 연결`** 을 엽니다.
2. **`연결 코드 생성`** 을 누르면 일회용 코드가 나와요 (약 5분간 유효 · 1회용).
3. 화면에 표시된 명령을 그대로 터미널에 붙여넣어 실행합니다:

```bash
npx chwijung-mcp connect <코드>
```

- **비밀번호를 입력하지 않아도 돼요.** 성공하면 토큰만 `~/.chwijung/session.json`에 저장됩니다.

#### [방법 2] 터미널에서 직접 로그인

> 🔒 **보안을 위해 비밀번호는 AI 채팅창이 아니라, 여러분이 터미널에 직접 입력합니다.**

```bash
npx chwijung-mcp login
```

- **Claude Code 사용자**는 채팅창에 `! chwijung-mcp login` 을 입력하면
  이 세션의 터미널에서 바로 실행됩니다.
- 이메일·비밀번호를 차례로 묻고, **비밀번호는 입력 중 화면에 표시되지 않아요.**
  성공하면 토큰만 `~/.chwijung/session.json`에 저장됩니다(비밀번호는 저장 안 됨).

### 4단계 — 사용 (이후엔 자동!)

이제 **세션을 마무리하거나 기능 하나를 끝낼 때 AI가 알아서** 데일리 로그를 등록합니다.
직접 시키고 싶으면 이렇게 말하면 돼요:

> 💬 "오늘 작업 정리해서 데일리 로그 등록해줘."

---

## 🔐 로그인 자세히 (보안)

- **비밀번호는 사람이 터미널에 직접 입력**하고(에코 숨김), **토큰만** 로컬에 캐시됩니다.
  비밀번호는 저장되지 않고, AI 대화나 MCP 로그에도 남지 않아요.
- 데일리 로그는 **학생(student) 계정만** 작성할 수 있어, 비-학생 계정은 로그인 정보를 저장하지 않습니다.
- access 토큰은 약 1시간 유효하지만, 갱신 시 **회전된 refresh 토큰을 저장**하므로
  재로그인 없이 세션이 계속 유지됩니다. (refresh 체인이 끊겨 세션이 폐기된 경우에만 다시 `login`)

상태 확인 / 로그아웃:

```bash
npx chwijung-mcp whoami    # 현재 로그인 상태 확인
npx chwijung-mcp logout    # 로그아웃
```

> 🛡️ 토큰 파일(`~/.chwijung/session.json`)은 평문입니다. POSIX는 `0600`, Windows는 `icacls`로
> 현재 사용자만 접근하도록 best-effort 제한합니다. **공용 PC에서는 사용 후 `logout`** 을 권장합니다.

---

## 🗑️ 전체 삭제 (언인스톨)

설치가 남긴 흔적을 **한 번에** 정리합니다.

```bash
npx chwijung-mcp uninstall      # 확인 후 모두 삭제
npx chwijung-mcp uninstall -y   # 확인 없이 바로 삭제 (--yes)
```

이 명령이 **자동으로 제거**하는 것:

| 대상 | 방법 |
|------|------|
| 전역 명령 `chwijung-mcp` | `npm uninstall -g chwijung-mcp` |
| 토큰 캐시 `~/.chwijung` | 폴더째 삭제 |
| MCP 설정의 `chwijung` 항목 | `claude mcp remove` · `codex mcp remove` CLI + **현재 폴더**의 `.mcp.json`/`.cursor/mcp.json`, `~/.cursor/mcp.json`, `~/.gemini/config/mcp_config.json` 의 JSON 항목 |
| 클론한 레포 폴더 | 현재 작업 폴더가 **레포 밖일 때** 폴더째 삭제 |

> ⚠️ **수동 정리가 필요한 경우** (명령이 안내문으로 알려줍니다)
> - **다른 프로젝트 폴더**의 `.mcp.json` / `.cursor/mcp.json` 항목은 자동 탐지되지 않아요 → 직접 제거
> - **Codex CLI가 없으면** `~/.codex/config.toml` 의 `[mcp_servers.chwijung]` 블록을 직접 삭제
> - **레포 폴더 안에서 실행**했거나(자기 자신은 못 지움) 파일이 잠겨 삭제가 실패하면, 출력된 `rm -rf` 명령을 레포 밖에서 직접 실행

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
| "로그인이 필요합니다" | 터미널에서 `npx chwijung-mcp login` 실행 (또는 웹 연결 코드로 `connect`) |
| "세션이 만료되었습니다" | refresh 토큰 체인이 끊김(폐기) → 터미널에서 다시 `login` |
| "학생(student) 계정만 …" | 코치/멘토/운영자 계정으로는 등록 불가. 로그인 단계에서 비-학생은 세션 저장이 거부됨 |
| "…필수입니다 / N자 이하" | 필수 필드 누락·길이 초과. AI가 내용을 채워 다시 호출하게 두면 됨 |
| `npx chwijung-mcp` 가 안 됨 | 1단계의 `npm run build` + `npm install -g .` 를 했는지, `node -v` ≥18 확인 |
| MCP 서버가 안 뜸 | 전역 설치(`npm install -g .`) 여부, `node -v` ≥18 확인. `/mcp` 로 연결 상태 점검 |
| 🪟 Windows에서 `npx` 가 전역 명령을 못 찾음 | 등록 설정의 `"command": "npx"` 를 `"command": "chwijung-mcp"` 로 바꿔보세요 |
| 완전히 지우고 싶음 | `npx chwijung-mcp uninstall` (확인) 또는 `... -y` (즉시). 자동/수동 정리 범위는 위 **🗑️ 전체 삭제** 참고 |
