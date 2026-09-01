/**
 * 마크다운 파일의 ```text 블록 3개를 프롬프트 슬롯 ①②③으로 읽어 DB에 넣는다.
 *   pnpm run prompts:load <파일경로>
 */
import { readFile } from "node:fs/promises";
import { savePrompt, PromptSlot } from "../src/domain/prompts";

const SLOTS: PromptSlot[] = ["weekly", "purchase", "recommend"];

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("사용법: pnpm run prompts:load <파일경로>");

  const md = await readFile(path, "utf8");
  const blocks = [...md.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1].trim());

  if (blocks.length !== 3) {
    throw new Error(`\`\`\`text 블록이 3개여야 하는데 ${blocks.length}개입니다`);
  }

  for (const [i, slot] of SLOTS.entries()) {
    await savePrompt(slot, blocks[i]);
    console.log(`${slot}: ${blocks[i].length}자 저장`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
