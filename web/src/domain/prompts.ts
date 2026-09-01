import { eq } from "drizzle-orm";
import { db } from "@/db";
import { prompts } from "@/db/schema";

export type PromptSlot =
  | "weekly"
  | "purchase"
  | "recommend"
  | "watch"
  | "consolidate";

export const PROMPT_META: Record<
  PromptSlot,
  { label: string; agent: string; description: string }
> = {
  weekly: {
    label: "① 정기 조사",
    agent: "월/목 07:30 자동 실행",
    description:
      "시장 전반과 후보 ETF를 발굴·조사합니다. 어떤 종목군을 볼지, 무엇을 따질지 여기에 쓰세요.",
  },
  purchase: {
    label: "② 매입 시점 조사",
    agent: "‘매입 추천’ 버튼을 누를 때 실행",
    description:
      "그동안 문서에 등장한 종목과 보유 종목 전체를 같은 시점 기준으로 재조사합니다. 종목 목록은 시스템이 자동으로 넣어줍니다.",
  },
  watch: {
    label: "④ 보유 점검",
    agent: "매일 13:00 자동 실행",
    description:
      "지금 들고 있는 종목이 위험해졌는지 매일 살핍니다. 위험하면 팔고 갈아탈 대상까지 제안합니다. 종목 목록은 시스템이 자동으로 넣어줍니다.",
  },
  consolidate: {
    label: "⑤ 종목 정리 검토",
    agent: "매월 1일 13:30 자동 실행",
    description:
      "적립하다 보면 같은 카테고리에 비슷한 ETF가 쌓입니다. 실질적으로 같은 걸 사고 있는지 보고 통합할 만한지 제안합니다. 보유 목록은 시스템이 자동으로 넣어줍니다.",
  },
  recommend: {
    label: "③ 추천",
    agent: "② 직후 실행",
    description:
      "조사 결과를 보고 카테고리별로 살 종목을 고릅니다. 선정 기준·갈아타기 허용 여부 등을 쓰세요.",
  },
};

/**
 * 자리표시자 프롬프트. 사용자가 직접 작성한 프롬프트를 넣기 전까지 쓰인다.
 * 최소한만 지시하고, 시스템이 형식 지시문(§5.4)을 뒤에 자동으로 붙인다.
 */
export const PLACEHOLDER_PROMPT: Record<PromptSlot, string> = {
  weekly: `한국 상장 ETF 중 미국 주식에 투자하는 상품을 조사한다.
배당성장형·자산성장형·고배당형 세 갈래로 나눠, 각 갈래의 대표 ETF들의 현재가와 분배율, 최근 동향을 웹 검색으로 확인해 정리한다.
수치는 반드시 웹에서 확인한 것만 쓰고 출처를 남긴다.`,

  purchase: `아래 지정된 종목 전체를 지금 시점 기준으로 조사한다.
각 종목의 현재가(또는 최근 종가), 최근 분배금과 분배율, 괴리율, 최근 한 달 내 주요 이벤트를 웹 검색으로 확인한다.
지정된 종목은 하나도 빠뜨리지 말고 데이터 표에 모두 넣는다.`,

  watch: `지금 보유 중인 종목들이 계속 들고 있어도 되는 상태인지 점검한다.

각 종목에 대해 웹 검색으로 최신 상태를 확인하고, 아래 위험 신호가 있는지 본다.
- 분배율이 높은데 총투자수익률이 그에 못 미치거나 NAV가 추세적으로 하락 중인가
- 주당 분배금 절대액이 줄고 있는가
- 순자산이 급감했거나 거래대금이 말랐는가
- 괴리율이 비정상적으로 벌어졌는가
- 거래정지·상장폐지·운용전략 변경 같은 사건이 있었는가

위험이 확인되면 같은 카테고리 안에서 더 나은 대체 종목이 있는지 함께 조사한다.
근거 없이 불안을 조장하지 말고, 문제가 없으면 문제 없다고 분명히 적는다.`,

  consolidate: `같은 카테고리 안에 보유 중인 ETF들이 실질적으로 같은 것을 사고 있는지 살핀다.

각 종목의 기초지수, 상위 편입 종목, 운용 전략을 웹 검색으로 확인해 서로 얼마나 겹치는지 본다.
거의 같은 지수를 추종한다면 여러 개로 나눠 갖는 의미가 없으므로 하나로 모으는 게 나은지 검토한다.
반대로 서로 다른 지수·전략이면 그건 정상적인 분산이니 통합을 제안하지 않는다.

통합을 제안할 때는 어느 쪽을 남길지(비용·추적 품질·유동성·순자산 기준)와
지금 옮기면 생기는 비용(실현손익, 세금, 거래비용)을 함께 적는다.`,

  recommend: `주어진 조사 문서들을 근거로, 세 카테고리(배당성장·자산성장·고배당) 각각에서 이번 달에 매수할 ETF를 하나씩 고른다.
각 카테고리에 배정된 금액 안에서 몇 주를 살 수 있는지 계산하고, 왜 그 종목인지 근거를 조사 문서의 수치를 인용해 설명한다.
배정 금액으로 1주도 살 수 없으면 skip을 true로 하고 그 이유를 적는다.`,
};

export async function getPrompt(
  slot: PromptSlot,
): Promise<{ body: string; isPlaceholder: boolean; updatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(prompts)
    .where(eq(prompts.slot, slot))
    .limit(1);

  if (!rows.length) {
    return {
      body: PLACEHOLDER_PROMPT[slot],
      isPlaceholder: true,
      updatedAt: null,
    };
  }
  return {
    body: rows[0].body,
    isPlaceholder: false,
    updatedAt: rows[0].updatedAt,
  };
}

export async function getAllPrompts() {
  const slots: PromptSlot[] = [
    "weekly",
    "purchase",
    "recommend",
    "watch",
    "consolidate",
  ];
  return Object.fromEntries(
    await Promise.all(
      slots.map(async (s) => [s, await getPrompt(s)] as const),
    ),
  ) as Record<
    PromptSlot,
    { body: string; isPlaceholder: boolean; updatedAt: Date | null }
  >;
}

export async function savePrompt(slot: PromptSlot, body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    // 비우면 자리표시자로 되돌린다
    await db.delete(prompts).where(eq(prompts.slot, slot));
    return;
  }
  await db
    .insert(prompts)
    .values({ slot, body: trimmed })
    .onConflictDoUpdate({
      target: prompts.slot,
      set: { body: trimmed, updatedAt: new Date() },
    });
}
