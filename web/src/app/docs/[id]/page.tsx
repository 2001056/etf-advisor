import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { researchDocs } from "@/db/schema";
import { parseResearchDoc, splitProblems } from "@/domain/docFormat";
import { Card, Notice, Page } from "@/components/ui";
import { DeleteDocButton } from "../delete-button";

export const dynamic = "force-dynamic";

export default async function DocPage({ params }: PageProps<"/docs/[id]">) {
  const { id } = await params;
  // 정수가 아니면 질의 자체가 500을 낸다 (Postgres integer 바인딩 실패)
  const docId = Number(id);
  if (!Number.isInteger(docId) || docId < 1 || docId > 2_147_483_647) notFound();

  const rows = await db
    .select()
    .from(researchDocs)
    .where(eq(researchDocs.id, docId))
    .limit(1);

  if (!rows.length) notFound();
  const doc = rows[0];
  const parsed = parseResearchDoc(doc.content);
  const split = splitProblems(doc.parseProblems as string[] | null);

  return (
    <Page current="/docs">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{doc.title}</h1>
        <div className="flex items-center gap-3">
          <DeleteDocButton id={doc.id} title={doc.title} redirectToList />
          <Link href="/docs" className="text-sm text-neutral-500 hover:underline">
            목록으로
          </Link>
        </div>
      </div>

      {split.format.length > 0 && (
        <Notice kind="warn">
          표준 형식과 어긋난 부분이 있습니다 — 추천 에이전트가 이 문서를 제대로
          읽지 못할 수 있습니다.
          <ul className="mt-2 list-disc pl-5">
            {split.format.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}

      {split.data.length > 0 && (
        <Notice kind="info">
          수치 자가검증에서 걸린 항목입니다 — 형식 문제는 아니며, 추천 시 참고용으로
          함께 전달됩니다.
          <ul className="mt-2 list-disc pl-5">
            {split.data.map((p) => (
              <li key={p}>{p.replace(/^\[주의\]\s*/, "")}</li>
            ))}
          </ul>
        </Notice>
      )}

      {parsed.dataRows.length > 0 && (
        <Card title="데이터 표 (기계 파싱 결과)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">종목코드</th>
                  <th>종목명</th>
                  <th>구분</th>
                  <th className="text-right">가격</th>
                  <th className="text-right">분배율</th>
                  <th className="text-right">괴리율</th>
                  <th>비고</th>
                </tr>
              </thead>
              <tbody>
                {parsed.dataRows.map((r, i) => (
                  <tr key={`${r.ticker}-${i}`} className="border-b border-neutral-100">
                    <td className="py-2">{r.ticker}</td>
                    <td>{r.name}</td>
                    <td>{r.category}</td>
                    <td className="text-right tabular-nums">
                      {r.price?.toLocaleString("ko-KR") ?? "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.distYield != null ? `${r.distYield}%` : "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.premium != null ? `${r.premium}%` : "—"}
                    </td>
                    <td className="text-neutral-500">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="원문">
        <pre className="overflow-x-auto whitespace-pre-wrap text-sm leading-relaxed">
          {doc.content}
        </pre>
      </Card>

      {doc.filePath && (
        <p className="text-xs text-neutral-500">로컬 사본: {doc.filePath}</p>
      )}
    </Page>
  );
}
