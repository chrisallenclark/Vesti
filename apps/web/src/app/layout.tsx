import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vesti",
  description: "Evidence-driven investment and trading intelligence.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Vesti" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
    { media: "(prefers-color-scheme: light)", color: "#edebe5" },
  ],
};

const TABS = [
  { href: "/", label: "Desk", icon: <path d="M3 15V9M7.5 15V5M12 15v-4M16.5 15V7" strokeLinecap="round" /> },
  { href: "/portfolio", label: "Portfolio", icon: <><circle cx="10" cy="10" r="7" /><path d="M10 3v7h7" strokeLinecap="round" /></> },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="appHeader">
            <div className="wordmark">
              Ves<span>ti</span>
            </div>
          </header>
          {children}
        </div>

        <nav className="tabbar" aria-label="Primary">
          <div className="tabbarInner">
            {TABS.map((tab) => (
              <Link key={tab.href} className="tab" href={tab.href}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  {tab.icon}
                </svg>
                <span className="t">{tab.label}</span>
              </Link>
            ))}
          </div>
        </nav>
      </body>
    </html>
  );
}
