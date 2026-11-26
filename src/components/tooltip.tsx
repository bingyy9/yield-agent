"use client";
import { useCallback, useState, type ReactNode } from "react";

interface Tip {
  x: number;
  y: number;
  w: number;
  content: ReactNode;
}

// 图表悬停提示：在带 data-tip-root 的容器内绝对定位，鼠标与键盘焦点都可触发
export function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);

  const show = useCallback((e: { clientX?: number; clientY?: number; currentTarget: Element }, content: ReactNode) => {
    const root = e.currentTarget.closest("[data-tip-root]");
    const box = root?.getBoundingClientRect();
    if (!box) return;
    let x: number;
    let y: number;
    if (typeof e.clientX === "number" && typeof e.clientY === "number" && (e.clientX || e.clientY)) {
      x = e.clientX - box.left;
      y = e.clientY - box.top;
    } else {
      const r = e.currentTarget.getBoundingClientRect();
      x = r.left + r.width / 2 - box.left;
      y = r.top - box.top;
    }
    setTip({ x, y, w: box.width, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  const layer = tip ? (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 max-w-72 rounded-md bg-ink px-2.5 py-1.5 text-xs leading-relaxed text-white shadow-lg num"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(${tip.x < 120 ? "-10%" : tip.x > tip.w - 120 ? "-90%" : "-50%"}, calc(-100% - 12px))`,
      }}
    >
      {tip.content}
    </div>
  ) : null;

  return { root: { "data-tip-root": "" }, show, hide, layer };
}

// 给图表标记（SVG 或 HTML）绑定悬停 + 键盘焦点提示
export function tipProps(t: ReturnType<typeof useTip>, content: ReactNode, label: string) {
  return {
    tabIndex: 0,
    "aria-label": label,
    onMouseMove: (e: React.MouseEvent<Element>) => t.show(e, content),
    onMouseLeave: t.hide,
    onFocus: (e: React.FocusEvent<Element>) => t.show({ currentTarget: e.currentTarget }, content),
    onBlur: t.hide,
  };
}
