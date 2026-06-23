/**
 * 취몽 MCP 서버 — 도구 등록 + 입력 검증.
 *
 * 도구
 * - login(): 터미널 CLI 로그인 방법을 안내(비밀번호는 AI가 아닌 사용자가 터미널에 입력).
 * - submit_daily_log(...): 개발 세션/도메인 종료 시 그날 작업을 데일리 로그로 최종 제출(is_draft=false).
 * - whoami(): 현재 로그인 상태 확인.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import * as auth from "./auth.js";
import { BackendError, ChwijungClient } from "./client.js";
import { getBaseUrl } from "./config.js";
import { markdownToHtml } from "./markdown.js";
import { isAccessValid, loadSession } from "./session.js";

// DailyScrumEntryCreate 스키마(Backend/app/schemas/scrum.py)와 일치
const LIMITS = {
  title: 40,
  feature_name: 100,
  problems: 200,
  solution: 200,
  result: 200,
  content: 6000,
} as const;

type RequiredField =
  | "title"
  | "feature_name"
  | "problems"
  | "solution"
  | "result";

function client(): ChwijungClient {
  return new ChwijungClient(getBaseUrl());
}

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

export interface DailyLogArgs {
  title: string;
  feature_name: string;
  problems: string;
  solution: string;
  result: string;
  category: string;
  status: string;
  content: string;
}

/** 최종 제출(is_draft=false) 기준으로 필드를 검증하고 오류 메시지 목록을 반환. */
export function validate(args: DailyLogArgs): string[] {
  const errors: string[] = [];

  const required = (name: RequiredField, value: string): void => {
    if (!value || !value.trim()) {
      errors.push(`'${name}'는 필수입니다.`);
    } else if (value.length > LIMITS[name]) {
      errors.push(
        `'${name}'는 ${LIMITS[name]}자 이하여야 합니다 (현재 ${value.length}자).`,
      );
    }
  };

  required("title", args.title);
  required("feature_name", args.feature_name);
  required("problems", args.problems);
  required("solution", args.solution);
  required("result", args.result);

  if (args.content && args.content.length > LIMITS.content) {
    errors.push(
      `'content'는 ${LIMITS.content}자 이하여야 합니다 (현재 ${args.content.length}자).`,
    );
  }
  if (args.category !== "mini" && args.category !== "final") {
    errors.push("'category'는 'mini' 또는 'final'이어야 합니다.");
  }
  if (!["pending", "in_progress", "completed"].includes(args.status)) {
    errors.push(
      "'status'는 'pending', 'in_progress', 'completed' 중 하나여야 합니다.",
    );
  }

  return errors;
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "login",
    {
      description:
        "취몽(Chwijung) 로그인 방법을 안내합니다. 보안을 위해 비밀번호는 AI 채팅창이 아니라 " +
        "사용자가 터미널에 직접 입력합니다. 로그인이 필요하면 이 도구를 호출해 안내를 받으세요.",
      inputSchema: {},
    },
    async () => {
      const loggedIn = (await loadSession()) != null;
      const status = loggedIn
        ? "현재 로그인되어 있습니다."
        : "현재 로그인되어 있지 않습니다.";
      return text(
        `${status}\n` +
          "로그인 방법은 두 가지입니다(둘 다 학생 계정만, 최초 1회면 됩니다).\n\n" +
          "[방법 1] 웹에서 연결 코드 발급 (권장, 터미널 비밀번호 입력 불필요)\n" +
          "  웹에 로그인한 뒤 'MCP 연결'에서 코드를 발급받아 터미널에서 실행:\n" +
          "    npx chwijung-mcp connect <코드>\n\n" +
          "[방법 2] 터미널 로그인\n" +
          "  보안상 비밀번호는 AI 채팅에 입력하지 말고, 사용자가 직접 터미널에서 실행:\n" +
          "    npx chwijung-mcp login\n" +
          "  이메일/비밀번호를 묻고, 비밀번호는 입력 중 화면에 표시되지 않습니다.\n\n" +
          "토큰만 로컬(~/.chwijung/session.json)에 캐시되며 이후 자동 회전되어 재로그인이 거의 필요 없습니다.\n" +
          "Claude Code 사용자는 채팅창에 `! npx chwijung-mcp connect <코드>` 처럼 입력하면 이 세션에서 바로 실행됩니다.",
      );
    },
  );

  server.registerTool(
    "submit_daily_log",
    {
      description:
        "오늘 개발한 내용을 취몽 데일리 로그로 최종 등록합니다(is_draft=false). " +
        "개발 세션을 마무리하거나 하나의 기능/도메인을 완료했을 때 호출하세요. " +
        "모든 텍스트는 한국어로, 해당 세션에서 실제로 한 일을 바탕으로 작성합니다(추측·과장 금지). " +
        "이 로그는 ① 팀원과 진행상황·어려움·해결책을 공유하고 ② 취업 포트폴리오/면접 자료로 쓰입니다. " +
        "그래서 '어떤 파일의 어떤 함수를 고쳤다'는 구현 디테일이 아니라 " +
        "'무슨 문제를 어떻게 판단해 풀었고 무엇이 나아졌나'(문제→접근·의사결정→결과·임팩트) 중심으로 쓰세요. " +
        "파일/함수/API명은 남겨도 되지만 항상 '왜 건드렸고 어떤 효과였는지'와 함께 적고, " +
        "개발 용어는 코드베이스를 모르는 면접관도 이해하도록 한 줄 풀이를 곁들입니다. " +
        "problems/solution/result는 필수입니다.",
      inputSchema: {
        title: z
          .string()
          .describe(
            "작업 요약 제목 (최대 40자). 성과가 드러나게. 예: 팀원 로그 공유로 협업 가시성 개선",
          ),
        feature_name: z
          .string()
          .describe(
            "작업한 기능명 (최대 100자). 예: 데일리 로그 팀 단위 조회(읽기 전용)",
          ),
        problems: z
          .string()
          .describe(
            "겪은 문제·이슈 (최대 200자, 필수). 상황과 '왜 어려웠는지'를 구체적으로. " +
              "이 필드는 포트폴리오에 잘리지 않고 그대로 쓰이니 한 문장이라도 알차게.",
          ),
        solution: z
          .string()
          .describe(
            "어떻게 해결했는지 (최대 200자, 필수). 접근·의사결정과 그 근거(고려한 대안/트레이드오프). " +
              "개발 용어는 풀어서. 포트폴리오에 그대로 쓰임.",
          ),
        result: z
          .string()
          .describe(
            "결과·성과 (최대 200자, 필수). 가능하면 수치/지표로(예: 전송량 5배↓, 응답 200ms, 쿼리 N→M건). " +
              "수치가 없으면 무엇이 어떻게 나아졌는지라도 명시. 포트폴리오에 그대로 쓰임.",
          ),
        category: z
          .enum(["mini", "final"])
          .default("mini")
          .describe("프로젝트 구분"),
        content: z
          .string()
          .default("")
          .describe(
            "상세 내용 (선택, 최대 6000자, 마크다운 가능). " +
              "중복 금지: problems/solution/result(요약 3필드)를 다시 쓰지 마세요. " +
              "요약 3필드가 '무엇을 했나'를 담고, content는 거기 안 담기는 깊이만 — " +
              "원인을 찾아간 과정, 고려한 대안과 트레이드오프(왜 A 대신 B를 택했나), 배운 점·회고, 막혔던 지점. " +
              "읽기 쉽게 마크다운 서식으로 구분하세요: 핵심 판단은 **굵게**, 길면 '## 의사결정'·'## 막힌 지점'·'## 배운 점' 같은 소제목이나 목록으로. " +
              "단 '문제/해결/결과'처럼 요약 3필드를 그대로 옮긴 제목은 금지(중복) — 소제목은 깊이를 드러내는 이름으로. " +
              "첫 문단(3~5줄)에 핵심을 front-load. " +
              "서식은 팀원이 보는 웹 화면용이고, 포트폴리오 생성기는 서식을 벗겨 앞 600자만 쓰므로 서식을 지워도 글이 말이 되게 쓰세요. " +
              "파일/함수명은 효과와 함께만, 개발 용어는 한 줄 풀이를 곁들입니다. " +
              "작은 작업이면 비워도 됩니다(요약 3줄로 충분).",
          ),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .default("in_progress")
          .describe("작업 상태. 기능을 완전히 끝냈으면 completed"),
      },
    },
    async (raw) => {
      const args: DailyLogArgs = {
        title: raw.title,
        feature_name: raw.feature_name,
        problems: raw.problems,
        solution: raw.solution,
        result: raw.result,
        category: raw.category ?? "mini",
        content: raw.content ?? "",
        status: raw.status ?? "in_progress",
      };

      const errors = validate(args);
      if (errors.length) {
        return text(
          "데일리 로그를 등록하려면 아래를 수정해 다시 호출하세요:\n- " +
            errors.join("\n- "),
        );
      }

      const payload = {
        title: args.title,
        // 프론트는 content를 HTML로 렌더링하므로 마크다운을 HTML로 변환해 전송한다.
        content: args.content ? markdownToHtml(args.content) : "",
        category: args.category,
        status: args.status,
        feature_name: args.feature_name,
        problems: args.problems,
        solution: args.solution,
        result: args.result,
        is_draft: false,
      };

      try {
        const entry = await auth.submitDailyLog(client(), payload);
        return text(
          `데일리 로그 등록 완료 ✅ (id: ${entry.id ?? "?"}) — "${args.title}"`,
        );
      } catch (err) {
        if (err instanceof auth.NotLoggedInError) return text(err.message);
        if (err instanceof auth.NotStudentError) return text(err.message);
        const message = err instanceof BackendError ? err.message : String(err);
        return text(`등록 실패: ${message}`);
      }
    },
  );

  server.registerTool(
    "whoami",
    {
      description: "현재 로그인 상태/소속 코호트/토큰 유효성을 확인합니다.",
      inputSchema: {},
    },
    async () => {
      const session = await loadSession();
      if (!session)
        return text(
          "로그인되어 있지 않습니다. 터미널에서 `npx chwijung-mcp login` 을 실행하세요 (login 도구로 안내를 받을 수 있습니다).",
        );
      const name = session.user.full_name || session.user.email || "사용자";
      const tokenState = isAccessValid(session)
        ? "유효"
        : "만료(다음 호출 시 자동 갱신 또는 재로그인 필요)";
      return text(
        `로그인됨: ${name} (역할: ${session.user.role}, cohort: ${session.cohort_id}, 토큰: ${tokenState})`,
      );
    },
  );
}
