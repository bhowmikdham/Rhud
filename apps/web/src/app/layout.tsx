import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import { ConfirmProvider } from '@/components/confirm';

export const metadata: Metadata = {
  title: 'rhud',
  description: 'Scope-to-proposal automation',
  // Single source-of-truth icon: apps/web/public/logo.png (copied into the
  // Next standalone runtime by infra/prod/Dockerfile.web). Browsers pick
  // the most appropriate of these three slots; we point them all at the
  // same PNG.
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
    apple: '/logo.png',
  },
};

// Resolve and apply the saved theme BEFORE first paint so dark-mode users
// never see a white flash. Mirrors the logic in components/theme-toggle.tsx's
// useTheme(); kept as a tiny inline string because it must run pre-hydration.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||((!t||t==='system')&&matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.dataset.theme=d?'dark':'light';e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script sets data-theme on <html>
    // before React hydrates, so the client tree legitimately differs from the
    // server-rendered attribute. Scoped to <html>; does not affect children.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <AuthProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
