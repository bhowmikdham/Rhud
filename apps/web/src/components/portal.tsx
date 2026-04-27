'use client';

/**
 * Tiny portal wrapper. Mounts children directly into <body>, escaping
 * any ancestor that creates a new containing block via `transform`,
 * `filter`, `will-change`, etc. — most notably the `.route-enter`
 * wrapper used for page-change animations, which would otherwise
 * trap any `position: fixed` modal overlay inside the page area.
 *
 * SSR-safe: renders nothing on the server pass; mounts the portal
 * after hydration so we don't try to access `document` at build time.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface PortalProps {
  children: React.ReactNode;
}

export function Portal({ children }: PortalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
