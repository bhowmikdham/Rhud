'use client';

/**
 * Onboarding tour — first-visit walkthrough of the Rhud UI.
 *
 * Uses driver.js for the "spotlight one element, dim the rest" effect.
 * Mounted from AppShell so any authenticated page can trigger it; auto-fires
 * once per browser on the first /dashboard visit. Re-runnable by appending
 * `?tour=1` to any URL (handy for admins onboarding a new teammate over a
 * call: "open this link...").
 *
 * The default driver.js overlay is rgba(0,0,0,0.7) — exactly the "black
 * tinted background" the spec called for. No custom styling needed for that.
 */

import { useEffect } from 'react';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { driver, type Config, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';

const LS_KEY = 'rhud.onboarding.completed';

/**
 * Step definitions. Order matters — driver.js walks them sequentially.
 * Targets are CSS selectors against rendered AppShell elements; steps
 * without an `element` render as centered welcome/done cards.
 */
const STEPS: DriveStep[] = [
  {
    popover: {
      title: 'Welcome to Rhud 👋',
      description:
        "Let's take a quick tour of your workspace. " +
        "You can skip anytime with the × button, and replay later by visiting any page with <code>?tour=1</code>.",
      showButtons: ['next', 'close'],
    },
  },
  {
    element: '.sidebar-head',
    popover: {
      title: 'Your workspace',
      description:
        "The Rhud mark always takes you back to the dashboard. " +
        "Everything you do happens inside your current workspace.",
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '.workspace-switcher',
    popover: {
      title: 'Workspace details',
      description:
        "Click here to jump into workspace settings — rename, manage members, " +
        "configure approval thresholds, set up integrations.",
      side: 'right',
      align: 'start',
    },
  },
  {
    element: 'a.nav-item[href="/opportunities"]',
    popover: {
      title: 'Opportunities',
      description:
        "Every client engagement lives here. " +
        "From first intake through scope gathering, pricing, approval, drafting, and final delivery — " +
        "all in one thread per opportunity.",
      side: 'right',
      align: 'start',
    },
  },
  {
    element: 'a.nav-item[href="/templates"]',
    popover: {
      title: 'Templates',
      description:
        "Decision-tree templates guide clients through scope intake. " +
        "Build branching questions once, generate a tokenised link, and the client self-serves while you focus on closing.",
      side: 'right',
      align: 'start',
    },
  },
  {
    element: 'a.nav-item[href="/rate-cards"]',
    popover: {
      title: 'Rate cards',
      description:
        "Your pricing structure. Define services, tiers, and modifiers; " +
        "Rhud applies them deterministically so quotes are explainable, not just a black-box number.",
      side: 'right',
      align: 'start',
    },
  },
  {
    element: 'a.nav-item[href="/settings"]',
    popover: {
      title: 'Settings',
      description:
        "Workspace configuration: team members and roles, integrations (Odoo, Outlook, Gamma), " +
        "approval thresholds, notification routing, billing.",
      side: 'right',
      align: 'start',
    },
  },
  {
    popover: {
      title: "You're set",
      description:
        "Start by creating an <strong>Opportunity</strong> or building a <strong>Template</strong>. " +
        "Need to see this again? Add <code>?tour=1</code> to any URL.",
      showButtons: ['close'],
    },
  },
];

const DRIVER_CONFIG: Config = {
  showProgress: true,
  showButtons: ['next', 'previous', 'close'],
  progressText: '{{current}} of {{total}}',
  nextBtnText: 'Next',
  prevBtnText: 'Back',
  doneBtnText: 'Got it',
  allowClose: true,
  allowKeyboardControl: true,
  // Tinted background — driver.js default is already rgba(0,0,0,0.7) which
  // matches the spec; we can dial it darker if you want a more cinematic feel.
  overlayColor: 'rgba(0, 0, 0, 0.72)',
  smoothScroll: true,
  stagePadding: 6,
  stageRadius: 8,
  steps: STEPS,
};

export function OnboardingTour() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    // Two triggers: explicit ?tour=1 always fires; otherwise auto-fire on
    // first /dashboard visit per browser.
    const forced = params.get('tour') === '1';
    const onDashboard = pathname === '/dashboard';
    if (!forced && !onDashboard) return;

    const alreadyDone = typeof window !== 'undefined' && localStorage.getItem(LS_KEY) === '1';
    if (!forced && alreadyDone) return;

    // Defer a frame so AppShell has rendered before we try to anchor steps.
    const t = window.setTimeout(() => {
      const d = driver({
        ...DRIVER_CONFIG,
        onDestroyed: () => {
          try {
            localStorage.setItem(LS_KEY, '1');
          } catch {
            // localStorage may be unavailable (e.g. Safari private mode);
            // tour just re-fires next visit, harmless.
          }
          // Strip ?tour=1 from the URL so back-navigation doesn't replay.
          if (forced) {
            const url = new URL(window.location.href);
            url.searchParams.delete('tour');
            router.replace(url.pathname + (url.search ? url.search : ''));
          }
        },
      });
      d.drive();
    }, 200);
    return () => window.clearTimeout(t);
    // Intentionally only re-evaluate when route changes; we don't want the
    // tour to re-fire on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return null;
}
