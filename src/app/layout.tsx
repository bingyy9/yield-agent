import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// 字体文件随仓库提供（来自 @fontsource-variable/archivo，OFL 协议），构建时不需要访问 Google Fonts
const archivo = localFont({
  src: "./fonts/archivo-latin-wght-normal.woff2",
  variable: "--font-archivo",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "FAgent 良率与失效分析",
  description: "面向 DRAM 晶圆厂的良率异常调查与 8D 报告 Agent",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${archivo.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
