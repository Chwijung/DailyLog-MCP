## 변경 요약
<!-- 무엇을, 왜 바꿨는지 한두 줄로 -->

## PR 제목 규칙 (필수)
- feat: 기능 추가
- fix: 버그 수정
- refactor: 리팩토링
- chore: 설정/배포/잡일

---

## PR 라벨 규칙 (필수)
- [ ] 버전 라벨 1개 선택: ✨ major / ✨ minor / ✨ patch
- [ ] 분류 라벨 1개 이상 선택: feature / fix / refactor / chore

> dev → main 릴리스 PR은 머지 전에 package.json의 version을 최신 릴리스보다 올려 두세요.
> (올리지 않으면 Release Version Check가 실패합니다. package-lock.json은 바꾸지 않습니다.)
> main에 머지되면 그 version 그대로 `v{버전}` 태그·릴리즈가 발행됩니다.
