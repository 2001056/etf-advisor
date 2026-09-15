import { splitProblems } from "@/domain/docFormat";
import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { researchDocs } from "@/db/schema";
import { Card, Notice, Page } from "@/components/ui";
import { DeleteAllDocsButton, DeleteDocButton } from "./delete-button";

export const dynamic = "force-dynamic";

export default async function DocsPage() {
  const docs = await db
    .select({
      id: researchDocs.id,
      docDate: researchDocs.docDate,
      type: researchDocs.type,
      title: researchDocs.title,
      parseProblems: researchDocs.parseProblems,
      createdAt: researchDocs.createdAt,
    })
    .from(researchDocs)
    .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
    .limit(100);

  return (
    <Page current="/docs">
      <h1 className="text-xl font-bold">조사 문서</h1>

      {docs.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-600">
            아직 문서가 없습니다. 정기 조사는 월/목 07:30에 자동 실행되고,{" "}
            <Link href="/runs" className="underline">
              실행 이력
            </Link>
            에서 지금 바로 한 번 돌려볼 수도 있습니다.
          </p>
        </Card>
      ) : (
        <Card
          title={`${docs.length}건`}
          action={<DeleteAllDocsButton count={docs.length} />}
        >
          <ul className="divide-y divide-neutral-100">
            {docs.map((d) => {
              const split = splitProblems(d.parseProblems as string[] | null);
              return (
                <li key={d.id} className="flex items-center gap-2 py-3">
                  <Link
                    href={`/docs/${d.id}`}
                    className="flex flex-1 flex-wrap items-center gap-2 hover:underline"
                  >
                    <span className="text-sm font-medium">{d.docDate}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        d.type === "scheduled"
                          ? "bg-neutral-200 text-neutral-700"
                          : "bg-blue-100 text-blue-800"
                      }`}
                    >
                      {d.type === "scheduled" ? "정기" : "매입시점"}
                    </span>
                    <span className="text-sm text-neutral-600">{d.title}</span>
                    {split.format.length > 0 && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                        형식 경고 {split.format.length}
                      </span>
                    )}
                    {split.data.length > 0 && (
                      <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800">
                        수치 주의 {split.data.length}
                      </span>
                    )}
                  </Link>
                  <DeleteDocButton id={d.id} title={d.title} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Notice>
        문서는 DB에 저장되고, 맥 로컬 <code>data/research/</code> 에도 같은
        내용의 md 사본이 남습니다.
      </Notice>
    </Page>
  );
}
