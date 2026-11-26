# FAgent：DRAM 良率与失效分析 Agent（Demo）

> 第一次接触？先读 **[docs/学习指南.md](docs/学习指南.md)**：从芯片制造基础、Agent 原理讲到代码走读和动手练习。要部署到国内服务器，看 **[docs/部署指南.md](docs/部署指南.md)**。

面向存储芯片 fab 的良率 / 失效分析助手。给它一个良率异常，它会自己调用工具一步步查：
批次良率 → Bin 柏拉图 → 晶圆图空间模式 → 设备共性分析（卡方检验）→ 设备日志 → 在线量测 → 历史 FA 案例 → 影响范围 → 8D 报告草稿。

所有数据都是模拟的（D1b LPDDR5 16Gb，约 30 个批次），但工具里的统计计算是真的在跑。

## 运行

```bash
npm install
npm run dev        # http://localhost:3000
```

### 两种模式

- **离线回放**（默认）：没配 API Key 时，用确定性脚本驱动同一套工具，过程和结果都是真实计算出来的，适合在没有外网的环境演示。
- **在线 Agent**：在 `.env.local` 里配置

  ```
  ANTHROPIC_API_KEY=sk-ant-...
  # 可选，默认 claude-opus-5
  CLAUDE_MODEL=claude-opus-5
  ```

  配好后由 Claude 自主决定调用哪些工具。页头可以勾选「强制回放」切回脚本。

## 演示脚本（三个预置场景）

| 场景 | 现象 | Agent 查到的根因 |
| --- | --- | --- |
| N3B417 | 数据保持失效（Bin 7）呈边缘环 | ETCH-07 腔体 C 换聚焦环后边缘刻蚀不足，p = 6.6×10⁻²⁴；5 个在制批次共 46 片需要拦截 |
| N3B409 | 阵列不可修复（Bin 6），少数晶圆有弧线 | CMP-03 研磨头 H2 划伤 |
| N3B412 | IDD 漏电（Bin 4）在晶圆中心成团 | DEP-11 腔体 B 喷淋头中心堵塞，TiN 顶电极偏薄 |

## 目录

- `src/lib/fab/`：模拟 fab，包括晶圆与 Bin 生成、设备与事件、量测、FA 案例库、统计分析
- `src/lib/agent/`：工具定义（zod 校验）、在线循环（Claude 流式 + 工具调用）、离线回放
- `src/app/api/agent/route.ts`：以 NDJSON 流式输出 Agent 事件
- `src/components/`：工作台界面、晶圆图、图表
- `scripts/try-tool.ts`：在命令行直接调用某个工具，看它返回给模型的数据，例如 `npx tsx scripts/try-tool.ts get_lot_summary '{"lot_id":"N3B417"}'`
- `docs/学习指南.md`：零基础学习指南
- `docs/部署指南.md`：部署到国内云服务器（Nginx + pm2，离线回放模式）
