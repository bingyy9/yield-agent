import { stackedMap } from "@/lib/fab/analysis";
import { STEP_BY_ID } from "@/lib/fab/core";
import { allLots } from "@/lib/fab/wafers";
import { Workbench, type LotCard } from "@/components/workbench";

export default function Page() {
  const lots: LotCard[] = allLots().map((l) => ({
    id: l.id,
    status: l.status,
    start: l.start,
    cpDate: l.cpDate,
    currentStep: STEP_BY_ID[l.currentStep]?.name ?? l.currentStep,
    yield: l.yield,
    density: l.binCounts ? stackedMap(l.wafers).map((v) => +v.toFixed(3)) : null,
  }));
  return <Workbench lots={lots} liveAvailable={!!process.env.ANTHROPIC_API_KEY || !!process.env.LLM_API_KEY} />;
}
