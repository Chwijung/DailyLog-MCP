// tsc 성공 뒤 build/ 가 어느 버전 소스로, 언제 만들어졌는지 기록한다.
// 자동 업데이트(src/update.ts)가 소스만 받고 빌드하지 않은 설치본을 구분하는 데 쓴다.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
writeFileSync(
  new URL("../build/.version", import.meta.url),
  JSON.stringify({ version, builtAt: new Date().toISOString() }),
);
