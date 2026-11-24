import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "Помрок",
  description: "Карпатська бувальщина про зниклий світанок, лісових істот і двобої у Telegram.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="uk"><body>{children}</body></html>;
}
