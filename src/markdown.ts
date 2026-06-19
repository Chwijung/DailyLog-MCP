/**
 * 마크다운 → HTML 변환.
 *
 * 데일리 로그 `content`는 프론트(DailyScrumDetail)가 dangerouslySetInnerHTML로
 * 렌더링하므로 HTML이어야 한다(프론트 Tiptap 에디터도 getHTML()로 HTML을 저장).
 * MCP는 마크다운 원문을 받으므로, 전송 직전에 여기서 HTML로 변환해 포맷을 맞춘다.
 *
 * 새니타이징은 적용하지 않는다 — 기존 Tiptap 저장 경로도 새니타이징 없이 HTML을
 * 저장/렌더링하므로 동작 일관성을 유지한다.
 */

import { marked } from "marked";

const options = {
  async: false as const,
  gfm: true, // 표·취소선·체크리스트 등 GitHub Flavored Markdown
  breaks: true, // 단일 줄바꿈을 <br>로 — 사용자가 작성한 줄바꿈을 그대로 보존
};

/** 마크다운 문자열을 HTML로 변환. 빈/공백 문자열은 그대로 반환. */
export function markdownToHtml(md: string): string {
  if (!md || !md.trim()) return md ?? "";
  return marked.parse(md, options) as string;
}
