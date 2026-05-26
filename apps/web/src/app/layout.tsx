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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
