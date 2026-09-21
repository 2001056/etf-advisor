import { getGrowthRoleWeights, getMonthlyTopup } from "@/domain/ledger";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  formatKRW,
} from "@/domain/money";
import {
  activeCategories,
  GROWTH_ROLES,
  GROWTH_ROLE_HINT,
  GROWTH_ROLE_LABEL,
  ROLE_CATEGORY,
} from "@/domain/recommendation";
import { getAllPrompts, PROMPT_META, PromptSlot } from "@/domain/prompts";
import { Card, Notice, Page } from "@/components/ui";
import PromptForm from "./prompt-form";
import TopupForm from "./topup-form";
import GrowthRolesForm from "./growth-roles-form";

export const dynamic = "force-dynamic";

const SLOTS: PromptSlot[] = ["weekly", "purchase", "recommend"];

export default async function SettingsPage() {
  const [topup, prompts, roleWeights] = await Promise.all([
    getMonthlyTopup(),
    getAllPrompts(),
    getGrowthRoleWeights(),
  ]);
  const total = CATEGORIES.reduce((s, c) => s + topup[c], 0);
  // 전부 0이면 세 카테고리 모두 활성이라 충전액 0만으로는 비활성이 아니다
  const roleActive = activeCategories(topup).includes(ROLE_CATEGORY);

  return (
    <Page current="/settings">
      <h1 className="text-xl font-bold">설정</h1>

      <Card title={`월 충전액 · 합계 ${formatKRW(total)}`}>
        <TopupForm
          values={topup}
          labels={Object.fromEntries(
            CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]]),
          )}
        />
      </Card>

      <Card title={`${CATEGORY_LABEL[ROLE_CATEGORY]} 자리별 비중`}>
        {!roleActive && (
          <div className="mb-3">
            <Notice kind="warn">
              {CATEGORY_LABEL[ROLE_CATEGORY]} 월 충전액이 0이라 이번 회차{" "}
              {CATEGORY_LABEL[ROLE_CATEGORY]}은 비활성입니다. 아래 비중은 다시
              충전액을 넣은 회차부터 쓰입니다.
            </Notice>
          </div>
        )}
        <p className="mb-3 text-sm text-neutral-600">
          {CATEGORY_LABEL[ROLE_CATEGORY]}은 한 종목에 몰아넣지 않고 성격이 다른 두
          자리에 나눠 담습니다. 추천 에이전트는 자리마다 ETF를 하나씩 고르고,
          자리별 배정액은 {CATEGORY_LABEL[ROLE_CATEGORY]} 잔액을 아래 비중대로 나눈
          값입니다.
        </p>
        <GrowthRolesForm
          values={roleWeights}
          labels={Object.fromEntries(
            GROWTH_ROLES.map((r) => [r, GROWTH_ROLE_LABEL[r]]),
          )}
          hints={Object.fromEntries(
            GROWTH_ROLES.map((r) => [r, GROWTH_ROLE_HINT[r]]),
          )}
        />
      </Card>

      <Notice>
        프롬프트 3개는 각 에이전트에게 &lsquo;무엇을 할지&rsquo;를 알려주는
        지시문입니다. 아래 자리표시자를 직접 쓰신 내용으로 바꾸시면 그때부터
        그대로 실행됩니다.
      </Notice>

      {SLOTS.map((slot) => {
        const meta = PROMPT_META[slot];
        const p = prompts[slot];
        return (
          <Card
            key={slot}
            title={`${meta.label} — ${meta.agent}`}
            action={
              p.isPlaceholder ? (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  자리표시자
                </span>
              ) : (
                <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
                  직접 작성됨
                </span>
              )
            }
          >
            <p className="mb-3 text-sm text-neutral-600">{meta.description}</p>
            <PromptForm
              slot={slot}
              body={p.body}
              isPlaceholder={p.isPlaceholder}
              updatedAt={
                p.updatedAt
                  ? new Intl.DateTimeFormat("ko-KR", {
                      timeZone: "Asia/Seoul",
                      dateStyle: "short",
                      timeStyle: "short",
                    }).format(p.updatedAt)
                  : null
              }
            />
          </Card>
        );
      })}

      <Card title="정기 조사 스케줄">
        <p className="text-sm text-neutral-600">
          매주 <b>월요일·목요일 07:30</b> (KST) 자동 실행. macOS launchd가
          트리거하며, 그 시각에 맥이 잠들어 있었으면 깨어난 뒤 한 번 실행됩니다.
        </p>
      </Card>
    </Page>
  );
}
