# etf-advisor

월간 ETF 적립 매수 도우미 (1인용, 맥북 자체 호스팅). 설계는 [기획서.md](기획서.md).

**접속**: http://192.168.0.2:3111 (같은 와이파이의 폰·PC에서도)

## 구성

| 경로 | 역할 |
|---|---|
| `web/` | Next.js 앱 — UI + API + 에이전트 실행 관리 |
| `scripts/run-agent.sh` | launchd에서 codex를 찾게 해주는 PATH 래퍼 |
| `scripts/start-web.sh` | 앱 상주 실행 |
| `scripts/trigger-research.sh` | 정기 조사 트리거 (재시도 3회) |
| `data/research/` | 조사 md 로컬 사본 |
| `data/logs/` | 실행 로그 |

DB는 도커 Postgres 16 컨테이너 `etf-advisor-db` (127.0.0.1:5433, `restart=always`).

## 상주 서비스 (launchd)

| Label | 하는 일 |
|---|---|
| `com.etf-advisor.web` | 앱 상주 (KeepAlive — 죽으면 자동 재시작, 부팅 시 자동 시작) |
| `com.etf-advisor.research` | 월·목 07:30 정기 조사 트리거 |
| `com.etf-advisor.watch` | 매일 13:00 보유 점검 트리거 |
| `com.etf-advisor.consolidate` | 매월 1일 13:30 종목 정리 검토 트리거 |
| `com.etf-advisor.docker` | 로그인 시 + 5분마다 colima·DB 확인 (절전 복구) |

```bash
launchctl list | grep etf-advisor          # 상태 확인
launchctl kickstart -k gui/$UID/com.etf-advisor.web   # 앱 재시작
```

도커(colima)는 `com.etf-advisor.docker`가 로그인 시와 5분마다 확인해 자동으로 올린다.
수동으로 확인하려면 `scripts/ensure-docker.sh` (여러 번 실행해도 안전).

## 에이전트 5개

1. **정기 조사** — 월/목 07:30 자동. 시장·후보 ETF 조사 → 표준 형식 문서로 저장
2. **매입 시점 조사** — "매입 추천" 버튼. 문서에 등장한 종목 + 보유 종목 **전체**를 같은 시점 기준으로 재조사
3. **추천** — 조사 결과 + 카테고리별 잔액으로 종목 선정
4. **보유 점검** — **매일 13:00 자동**. 보유 종목이 위험해졌는지 살피고, 위험하면 매도·대체 종목까지 제안
5. **종목 정리 검토** — **매월 1일 13:30 자동**. 같은 카테고리에 쌓인 ETF들이 실질적으로 같은 걸
   사고 있으면 하나로 모으는 안을 제안. 팔지 않고 **신규 매수만 한쪽으로 모으는 대안**을 반드시 함께 제시

④·⑤의 문서는 종류가 `watch`/`consolidate`라 **③ 추천의 주입 대상에서 제외**된다 — 매일 쌓여도 정기 조사를 밀어내지 않는다.
판정은 `보유 유지` / `신규 매수 중단` / `매도·교체 검토` 세 단계이며, 매도는 상장폐지·거래정지·
운용전략 중대 변경·분배 재원의 원금 잠식·순자산 급감처럼 **구조적 문제일 때만** 쓰도록 프롬프트에 못박았다
(단기 가격 하락은 매도 사유가 아니다). 보유 종목이 없으면 codex를 아예 부르지 않는다.
⑤도 마찬가지로 2종목 이상인 카테고리가 하나도 없으면 부르지 않으며, 카테고리를 넘나드는
통합(배당성장↔고배당)은 정규화 단계에서 거부된다. 제안은 대시보드 카드에 뜬다.

프롬프트 5개는 사이트의 **설정** 화면에서 편집한다. 비워두면 자리표시자가 쓰이고 경고가 뜬다.
출력 형식(frontmatter·고정 헤딩·데이터 표)은 시스템이 자동으로 붙으므로 프롬프트에는 "무엇을 조사할지"만 쓰면 된다.

프롬프트를 고칠 때 지켜야 하는 필드명·형식 계약은 [docs/프롬프트-시스템-계약.md](docs/프롬프트-시스템-계약.md)에 정리돼 있다.
마크다운 파일에서 한꺼번에 넣으려면:

```bash
pnpm --dir web run prompts:load ~/Documents/Codex/2026-08-27/new-chat/outputs/etf-agent-prompts-v1.md
```

## 종목 입력

매입 기록·분배금 화면의 **종목** 칸은 검색 상자다. 종목코드든 이름 일부든 치면
`종목코드 (종목명)` 형태로 후보가 뜨고, 고르면 **종목명과 구분까지 함께 채워진다**.

후보는 **보유 종목 + 최근 조사 문서 8건에 등장한 종목**을 합친 것이라, 조사에서 본 종목을
다른 화면에서 복사해 올 필요가 없다. 후보에 없는 종목은 코드와 이름을 직접 쳐도 된다.

## 수익 보기

대시보드 **총수익** 카드에 세 가지 수익률이 나온다. 서로 다른 질문에 답하므로 합산되지 않는다.

| 지표 | 뜻 | 언제 보나 |
|---|---|---|
| **연환산 · 투자된 돈 기준** (XIRR) | 실제 매수에 들어간 돈의 성과. 매입(−)·분배금(+)·평가액(+) 흐름 | 기본 지표 |
| **연환산 · 넣은 돈 전체 기준** (XIRR) | 안 쓰고 남긴 잔액까지 포함 — 잔액을 놀린 대가가 반영됨 | 건너뜀 이월이 쌓였을 때 |
| **시간가중수익률** (TWR) | 납입 시점 영향을 제거한 종목 자체의 성과 | 보조 지표 |

적립식에서 `(평가손익+분배금) ÷ 매입원금`은 3년 전 납입과 이번 달 납입을 같은 무게로 나눠
연환산 수익률을 **절반 수준으로 과소표시**한다(12개월 적립 예시: 7.14% vs XIRR 14.82%).
그래서 헤드라인은 XIRR이고, 원금 대비 비율은 참고값으로만 남겼다.

TWR은 `prices` 테이블에 일별 종가가 쌓여야 계산된다 — 대시보드를 열 때마다 자동 적재되며,
이틀치가 모이면 나온다. 그 전에는 "가격 이력이 N일치뿐입니다"라고 표시된다.

분배금은 **세후 실수령액**이 기준이고, 세전 총액·세액을 함께 넣으면 배당 수익 옆에 병기된다.

주의: GIPS는 개인 계좌를 규율하지 않는다. XIRR을 기본으로 두는 근거는 "MWR의 정의상
납입 타이밍이 반영된다"는 것뿐이며, 업계 표준이라서가 아니다.

### 목표 비중 대비 이탈 (drift)

대시보드에 카테고리별 현재 비중과 목표 비중(월 충전액에서 유도, 현재 50/30/20)의 차이를 표시한다.
`맞추려면` 열은 지금 비중을 목표로 되돌리는 데 필요한 금액이다 — 양수면 더 사야 하는 쪽.

**리밸런싱 트리거는 의도적으로 넣지 않았다.** 달력 기준·임계값 기준·혼합 중 무엇이 효과적인지,
신규 매수만으로 비중을 맞추는 방식(cash-flow rebalancing)이 실효가 있는지에 대해
조사에서 살아남은 근거가 하나도 없었다. 계산은 산술적으로 자명하므로 넣되, 규칙은 사람 판단에 맡긴다.

### 세 갈래 수익 구성

대시보드는 수익을 세 갈래로도 나눠 보여준다.

- **주가 손익** — 현재가 × 보유수량 − 매입원금
- **배당 수익** — 분배금 화면에 기록한 금액의 합
- **합계 수익** — 위 둘의 합, 그리고 매입원금 대비 수익률

바로 아래 표에서 배당성장·자산성장·고배당 **각 카테고리별로 같은 세 수치**를 볼 수 있다.
분배금은 잔액(ledger)에 더해지지 않는다 — 월 적립 규칙과 섞이지 않게 수익 집계에만 쓴다.
(재투자로 잔액에 더하는 기능은 `domain/dividends.ts`의 `addToBalance`로 남아 있고, 폼에서는 뺐다.)

## 에이전트 모델 설정

앱이 codex를 부를 때 쓰는 값은 코드에 못박혀 있다 (`src/server/codex.ts`).
전역 `~/.codex/config.toml`을 물려받지 않으므로, 다른 작업으로 전역 설정을 바꿔도 조사 품질이 흔들리지 않는다.

| 항목 | 값 | 근거 |
|---|---|---|
| 모델 | `gpt-5.6-sol` | 카탈로그상 "Latest frontier agentic coding model", priority 1의 최상위 |
| 속도 | `service_tier=priority` | 카탈로그 표기명이 그대로 **Fast** — "1.5x speed, increased usage" |
| 추론 | `model_reasoning_effort=xhigh` | 사다리: low < medium < high < xhigh < max < ultra |

`gpt-5.6-pro`는 ChatGPT 계정으로 호출하면 400(미지원)이라 쓸 수 없다 (실측 2026-08-27).

환경변수로 덮어쓸 수 있다 — `CODEX_MODEL`, `CODEX_EFFORT`, `CODEX_SERVICE_TIER`, `AGENT_TIMEOUT_MIN`.
추론을 `max`/`ultra`로 올리면 품질은 오르지만 실행 시간이 늘어 30분 타임아웃에 걸릴 수 있다.

## 개발

```bash
cd web
pnpm dev --port 3111      # 개발 서버 (상주 앱을 먼저 멈출 것)
pnpm run check:parser     # 조사 문서 파서 검증 (DB 불필요)
pnpm run check:recommend  # ③ 추천 출력 정규화·재배분 검증 (DB 불필요)
pnpm run check:live       # 실시간 시세 조회 검증 (네트워크 필요)
pnpm run check:xirr       # XIRR·ROAI 검증 (DB 불필요)
pnpm run check:twr        # TWR 검증 (DB 불필요)
pnpm run check:drift      # 목표 비중 이탈 계산 검증 (DB 불필요)
pnpm run check:watch      # ④ 보유 점검 판정 정규화 검증 (DB 불필요)
pnpm run check:consolidate # ⑤ 종목 정리 제안 정규화 검증 (DB 불필요)
pnpm run check:data       # 수집 수치 자가검증 게이트 (DB 불필요)
pnpm run check:official   # 공식 시세 API 필드·괴리율 검증 (키 필요)
pnpm run check:usage      # codex 사용량 수집 검증 (세션 기록 필요)
pnpm run db:push          # 스키마 반영
pnpm build                # 타입 검사 포함
```

문서 삭제 검증도 테이블을 비우므로 별도 DB에서 돌린다: `scripts/check-docdelete.ts`

원장·잔액 로직 검증은 **테이블을 비우므로** 별도 DB에서 돌린다 (실데이터가 있으면 자동으로 거부된다):

```bash
DATABASE_URL="postgresql://etf_advisor:$(grep -m1 '^POSTGRES_PASSWORD=' web/.env.local | cut -d= -f2-)@localhost:5433/etf_advisor_test" pnpm --dir web exec tsx scripts/check-ledger.ts
```

문제가 생기면 먼저 이걸 실행한다:

```bash
~/Projects/etf-advisor/scripts/status.sh
```

`web/.env.local` — `DATABASE_URL`, `SESSION_SECRET`, `CRON_SECRET`, `POSTGRES_PASSWORD`. git에 올리지 않는다.

## 진행 상황

- [x] M0 — codex 웹 검색(`-c tools.web_search=true`) 실동작 확인, launchd 환경 포함
- [x] M1 — 로그인, 온보딩, 카테고리별 원장, 매입 기록, 보유 현황
- [x] M2 — 정기 조사 파이프라인, 문서 뷰어, 실행 이력, 수동 재실행
- [x] M3 — 매입 추천 흐름(② → ③), 추천 결과 화면, 추천 → 매입 기록 확정
- [x] M4 — 실패 알림(맥 알림 센터), 시세 연동(현재금액·배당금 예상)
- [x] 코드 리뷰 2회 반영 — 정적 프리렌더 리다이렉트 루프, 고아 실행 영구 잠금, 동시실행 판별,
      파서 유령 행·통화기호·코드펜스, 시세 필드별 병합, 서버 액션 세션 검증, 폼 0원 입력 등
- [x] 프롬프트 v1 적재 및 시스템 계약 정렬 — [docs/프롬프트-시스템-계약.md](docs/프롬프트-시스템-계약.md)
- [x] 실제 프롬프트로 ②→③ 전체 흐름 1회 성공 (9종목 재조사 → 카테고리별 추천)
- [ ] 실제 매입 1사이클 완주 (매입 기록 → 마감 → 다음 달 충전)
