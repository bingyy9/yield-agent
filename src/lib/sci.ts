const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

// p 值显示：大于 0.001 用小数，否则用上标科学计数法，如 6.6×10⁻²⁴
export function sci(p: number) {
  if (p >= 0.001) return p.toFixed(3);
  const [m, e] = p.toExponential(1).split("e");
  return `${m}×10${String(Number(e)).replace(/./g, (c) => SUP[c] ?? c)}`;
}
