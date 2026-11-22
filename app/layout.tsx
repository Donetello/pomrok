import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "Pomrok",
  description: "A Telegram auto-battler. Descend into dungeons, duel rivals, and draw from the D6 marble box.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
