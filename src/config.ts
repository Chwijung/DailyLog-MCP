/**
 * 환경 설정.
 *
 * 취몽 백엔드 주소는 환경변수 CHWIJUNG_API_BASE_URL로 주입한다.
 * (.mcp.json 등 버전관리 파일에 노출돼도 안전한 값 — 비밀이 아님)
 */

export const DEFAULT_BASE_URL = "https://back.chwimong.com";

/** 취몽 백엔드 베이스 URL (끝의 슬래시 제거). 예: https://api.chwijung.example */
export function getBaseUrl(): string {
  return (process.env.CHWIJUNG_API_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}
