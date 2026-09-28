/**
 * 매입·갈아타기 폼 값을 도메인 입력으로 바꾸는 순수 로직.
 * 서버 액션("use server")은 async 함수만 내보낼 수 있고 요청 문맥이 있어야 돌아서,
 * 검증을 여기 두어 DB·Next 없이 검사한다 (scripts/check-form-parse.ts).
 * 잘못된 값은 한국어 메시지로 던진다 — 아무것도 쓰기 전에.
 */
import type { PurchaseInput, SwitchInput } from "./purchases";
import { CATEGORIES, CATEGORY_LABEL, Category } from "./money";
import { GrowthRole, ROLE_CATEGORY, toGrowthRole } from "./recommendation";

/** 폼에서 온 금액·수량. 빈칸이나 0 이하를 조용히 0으로 넘기지 않는다. */
export function positiveNum(v: FormDataEntryValue | null, label: string): number {
  const raw = String(v ?? "").trim();
  if (!raw) throw new Error(`${label}을(를) 입력하세요`);
  const n = Number(raw.replace(/[,\s원]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label}은(는) 0보다 커야 합니다`);
  return n;
}

export function category(v: FormDataEntryValue | null): Category {
  const s = String(v ?? "");
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  throw new Error(`알 수 없는 카테고리: ${s}`);
}

/** 매입·갈아타기 폼의 "자리" 칸. 빈칸 = 지정 안 함. 자리를 두는 카테고리의 매수에만 받는다 */
export function optionalSeat(
  v: FormDataEntryValue | null,
  cat: Category,
): GrowthRole | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const role = toGrowthRole(raw);
  if (!role) throw new Error(`알 수 없는 자리: ${raw}`);
  if (cat !== ROLE_CATEGORY) {
    throw new Error(
      `자리는 ${CATEGORY_LABEL[ROLE_CATEGORY]} 매수에만 지정할 수 있습니다`,
    );
  }
  return role;
}

/** 수기 매입 폼 → addManualPurchase 입력 */
export function parsePurchaseForm(
  fd: FormData,
  today: string,
): { input: PurchaseInput; allowOverBalance: boolean; role: GrowthRole | null } {
  const cat = category(fd.get("category"));
  const role = optionalSeat(fd.get("role"), cat);
  return {
    input: {
      boughtAt: String(fd.get("boughtAt") || today),
      category: cat,
      ticker: String(fd.get("ticker") ?? "").trim(),
      etfName: String(fd.get("etfName") ?? "").trim(),
      qty: positiveNum(fd.get("qty"), "수량"),
      unitPrice: positiveNum(fd.get("unitPrice"), "매입 단가"),
      memo: String(fd.get("memo") ?? "") || null,
      skipLedger: fd.get("skipLedger") === "on",
    },
    allowOverBalance: fd.get("allowOverBalance") === "on",
    role,
  };
}

/**
 * 갈아타기 폼 → executeSwitch 입력.
 *
 * 매수 카테고리가 매도와 다르면, 폼은 "매도대금 전액이 … 옮겨집니다" 경고를 띄운 동안에만
 * crossConfirm = `매도>매수` 를 싣는다. 경고 없이 다른 카테고리로 가거나 경고와 실제 두 카테고리가
 * 다르면(화면과 제출값이 어긋남) 거부한다. 같은 카테고리면 crossConfirm 이 없어야 한다.
 */
export function parseSwitchForm(fd: FormData, today: string): SwitchInput {
  // 매도 종목 선택값은 "category::ticker" — 매도 카테고리를 정한다
  const sellKey = String(fd.get("sell") ?? "");
  const sep = sellKey.indexOf("::");
  const sellTicker = sep < 0 ? "" : sellKey.slice(sep + 2).trim();
  if (!sellTicker) throw new Error("매도할 보유 종목을 고르세요");
  const cat = category(sellKey.slice(0, sep));

  // 매수 카테고리 칸이 없으면(옛 화면) 매도 카테고리 그대로 — 예전 동작
  const rawBuyCat = String(fd.get("buyCategory") ?? "").trim();
  if (rawBuyCat && !(CATEGORIES as readonly string[]).includes(rawBuyCat)) {
    throw new Error(`알 수 없는 매수 카테고리: ${rawBuyCat}`);
  }
  const buyCat = rawBuyCat ? (rawBuyCat as Category) : cat;

  const confirm = String(fd.get("crossConfirm") ?? "").trim();
  if (buyCat !== cat && confirm !== `${cat}>${buyCat}`) {
    throw new Error(
      `매도대금 이전(${CATEGORY_LABEL[cat]} → ${CATEGORY_LABEL[buyCat]})이 화면에서 확인되지 않았습니다. 화면을 새로 고쳐 다시 실행하세요`,
    );
  }
  if (buyCat === cat && confirm) {
    throw new Error(
      "화면에는 매도대금 이전이 표시됐지만 매수 카테고리가 매도와 같습니다. 화면을 새로 고쳐 다시 실행하세요",
    );
  }

  return {
    category: cat,
    buyCategory: buyCat,
    executedAt: String(fd.get("executedAt") || today),
    sell: {
      ticker: sellTicker,
      qty: positiveNum(fd.get("sellQty"), "매도 수량"),
      unitPrice: positiveNum(fd.get("sellUnitPrice"), "매도 단가"),
    },
    buy: {
      ticker: String(fd.get("buyTicker") ?? "").trim(),
      etfName: String(fd.get("buyEtfName") ?? "").trim(),
      qty: positiveNum(fd.get("buyQty"), "매수 수량"),
      unitPrice: positiveNum(fd.get("buyUnitPrice"), "매수 단가"),
    },
    memo: String(fd.get("memo") ?? "") || null,
    role: optionalSeat(fd.get("role"), buyCat),
  };
}
