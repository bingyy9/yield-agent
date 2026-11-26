// 学习用：在命令行里直接调用一个 Agent 工具，看它返回给模型的数据（forModel）。
// 用法：npx tsx scripts/try-tool.ts <工具名> '<JSON 参数>'
// 例子：npx tsx scripts/try-tool.ts get_lot_summary '{"lot_id":"N3B417"}'
import { runTool } from "../src/lib/agent/tools";

const [name = "list_lots", json = "{}"] = process.argv.slice(2);
const r = runTool(name, JSON.parse(json));
if (r.ok) {
  console.log("summary（显示在工具卡片上的一句话）：", r.output.summary);
  console.log("forModel（真正发给 Claude 的数据）：");
  console.log(JSON.stringify(r.output.forModel, null, 2));
} else {
  console.log(`出错了 [${r.code}]：${r.message}`);
}
