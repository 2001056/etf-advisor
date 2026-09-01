import { redirect } from "next/navigation";
import { onboardingAction } from "../actions";
import { isOnboarded } from "@/domain/ledger";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  DEFAULT_MONTHLY_TOPUP,
} from "@/domain/money";
import { buttonClass, Card, Field, inputClass, Notice, Page } from "@/components/ui";

// 정적 프리렌더되면 빌드 시점 DB 상태로 리다이렉트가 구워져 / ↔ /onboarding 루프가 된다.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  if (await isOnboarded()) redirect("/");

  return (
    <Page current="/">
      <h1 className="text-xl font-bold">초기 설정</h1>
      <Notice>
        지금 증권사 계좌에 있는 <b>카테고리별 예수금</b>을 입력하세요. 이 금액이
        시작 잔액이 되고, 이후로는 매입할 때 차감되고 매입 마감 다음날 월
        충전액이 더해집니다. 잘 모르겠으면 이번 달 몫(기본값)을 그대로 두세요.
      </Notice>

      <Card title="카테고리별 시작 잔액">
        <form action={onboardingAction} className="space-y-4">
          {CATEGORIES.map((c) => (
            <Field
              key={c}
              label={`${CATEGORY_LABEL[c]} (월 ${DEFAULT_MONTHLY_TOPUP[c].toLocaleString("ko-KR")}원)`}
            >
              <input
                name={c}
                type="number"
                inputMode="numeric"
                defaultValue={DEFAULT_MONTHLY_TOPUP[c]}
                className={inputClass}
              />
            </Field>
          ))}
          <button className={buttonClass}>시작하기</button>
        </form>
      </Card>

      <p className="text-xs text-neutral-500">
        이미 사둔 ETF는 시작 후 &lsquo;매입 기록&rsquo;에서 추가하세요. 과거 매입은
        위 잔액에 이미 반영된 것으로 보고 원장에서 다시 차감하지 않습니다.
      </p>
    </Page>
  );
}
