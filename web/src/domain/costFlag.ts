/**
 * ①② 데이터 표 note 의 비용 플래그를 읽는 단 하나의 규칙.
 *
 * 전에는 watch.ts(무엇을 잰 값인가)와 dataChecks.ts(적혀는 있는가)가 각자 정규식을 들고 있어
 * 한쪽만 알아보는 표기가 생길 수 있었다(외부 검토 9차). 두 곳이 이 함수를 부른다.
 *
 * 규칙은 두 가지다.
 * - 공백 무시: "비용 : 실부담"도 "비용:실부담"과 같다.
 * - 접두 일치: "비용:실부담비용"처럼 뒤에 설명이 붙어도 실부담으로 읽는다.
 * "합성총보수"는 "총보수"로 시작하지 않으므로 셋은 서로 겹치지 않는다.
 */

/**
 * cost_pct에 들어온 값이 무엇인가.
 * total: 실부담비용 / synthetic: 합성총보수(= 총보수 + 기타비용) / ter_only: 총보수만.
 */
export type CostBasis = "total" | "synthetic" | "ter_only";

/**
 * note 앞부분(구분자 기준 4조각)에서 비용 플래그를 찾는다.
 * 플래그가 없거나 셋 중 어느 것도 아니면 null — 호출부가 총보수만으로 취급할지 정한다.
 * 자산성장 행은 "자리 / 환헤지 / 비용 플래그" 순이라 플래그가 세 번째 조각이다.
 */
export function parseCostFlag(note: string): CostBasis | null {
  for (const seg of note.split(/[,/;|]/).slice(0, 4)) {
    const m = /^비용[:：](.*)$/.exec(seg.replace(/\s+/g, ""));
    if (!m) continue;
    const v = m[1];
    if (v.startsWith("실부담")) return "total";
    if (v.startsWith("합성총보수")) return "synthetic";
    if (v.startsWith("총보수")) return "ter_only";
  }
  return null;
}
