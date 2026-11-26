export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

export { sci } from "@/lib/sci";

export const md = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
export const mdShort = (date: string) => date.slice(5, 10);

export const dayNum = (date: string) => Date.parse(date.slice(0, 10) + "T00:00:00Z") / 86400000 + (date.length > 10 ? (Number(date.slice(11, 13)) * 60 + Number(date.slice(14, 16))) / 1440 : 0);
export const fromDayNum = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10);
