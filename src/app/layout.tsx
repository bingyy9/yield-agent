import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
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
