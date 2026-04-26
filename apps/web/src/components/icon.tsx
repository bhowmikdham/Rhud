/**
 * Icon set — minimal line icons, 1.75px stroke, currentColor.
 * Ported from prototype/icons.jsx with TS types.
 */
import type { ReactElement, SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: number;
  sw?: number;
}

function makeIcon(path: ReactElement, defaultSize = 16) {
  const Component = ({ size, sw, ...rest }: IconProps) => (
    <svg
      width={size ?? defaultSize}
      height={size ?? defaultSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw ?? 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {path}
    </svg>
  );
  return Component;
}

export const Icon = {
  Home: makeIcon(<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9.5Z" />),
  Inbox: makeIcon(<><path d="M3 5h18v10H3z" /><path d="M3 15l4-4h4l2 2h4l2-2h2" /></>),
  Thread: makeIcon(<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M8 6h3a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8" /></>),
  Link: makeIcon(<><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66L11 7" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66L13 17" /></>),
  Plus: makeIcon(<path d="M12 5v14M5 12h14" />),
  Check: makeIcon(<path d="M5 12.5 10 17l9-10" />),
  CheckCircle: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M8 12.5 11 15l5-6" /></>),
  X: makeIcon(<path d="M6 6l12 12M18 6 6 18" />),
  ChevronDown: makeIcon(<path d="m6 9 6 6 6-6" />),
  ChevronRight: makeIcon(<path d="m9 6 6 6-6 6" />),
  ChevronLeft: makeIcon(<path d="m15 6-6 6 6 6" />),
  ArrowRight: makeIcon(<path d="M5 12h14M13 5l7 7-7 7" />),
  ArrowUpRight: makeIcon(<path d="M7 17 17 7M8 7h9v9" />),
  Sparkle: makeIcon(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />),
  Sparkles: makeIcon(<><path d="m12 3 1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Z" /><path d="M19 15v4M17 17h4" /></>),
  Clock: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  Shield: makeIcon(<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />),
  Lock: makeIcon(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  User: makeIcon(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  Users: makeIcon(<><circle cx="9" cy="8" r="3.5" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7" /><path d="M17 21a7 7 0 0 0-2-5" /></>),
  Search: makeIcon(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></>),
  Send: makeIcon(<path d="M21 3 10 14M21 3l-7 18-4-8-8-4 18-7Z" />),
  Settings: makeIcon(<><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.09-1.1l2-1.55-2-3.46-2.36.95a7 7 0 0 0-1.9-1.1L14.3 3h-4l-.35 2.74a7 7 0 0 0-1.9 1.1L5.7 5.9l-2 3.46 2 1.55a7 7 0 0 0 0 2.2l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 1.9 1.1l.35 2.74h4l.35-2.74a7 7 0 0 0 1.9-1.1l2.36.95 2-3.46-2-1.55A7 7 0 0 0 19 12Z" /></>),
  Paperclip: makeIcon(<path d="M20.4 11.6 12 20a5.66 5.66 0 0 1-8-8L13 3a4 4 0 0 1 5.66 5.66L10 17.31a2 2 0 1 1-2.83-2.83l7-7" />),
  FileText: makeIcon(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></>),
  File: makeIcon(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6" /></>),
  Copy: makeIcon(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>),
  Bell: makeIcon(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></>),
  More: makeIcon(<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>),
  Filter: makeIcon(<path d="M4 5h16l-6 8v6l-4-2v-4L4 5Z" />),
  Calendar: makeIcon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>),
  Zap: makeIcon(<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />),
  Brain: makeIcon(<><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3c0 1.2.7 2.2 1.7 2.7A3 3 0 0 0 5 17a3 3 0 0 0 4 2.8V20a2 2 0 0 0 3 0v-16a2 2 0 0 0-3 0v.2Z" /><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-1.7 2.7A3 3 0 0 1 19 17a3 3 0 0 1-4 2.8" /></>),
  Mail: makeIcon(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 7 9-7" /></>),
  Globe: makeIcon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
  TrendUp: makeIcon(<path d="M3 17 9 11l4 4 8-8M14 4h7v7" />),
  Eye: makeIcon(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>),
  Download: makeIcon(<path d="M12 3v13M6 11l6 6 6-6M5 21h14" />),
  Edit: makeIcon(<><path d="M4 20h4l10-10-4-4L4 16v4Z" /><path d="m14 6 4 4" /></>),
  Dot: makeIcon(<circle cx="12" cy="12" r="3" fill="currentColor" />),
  Circle: makeIcon(<circle cx="12" cy="12" r="9" />),
  Slack: makeIcon(<><rect x="3" y="10" width="4" height="11" rx="2" /><rect x="10" y="3" width="11" height="4" rx="2" /><rect x="10" y="10" width="11" height="11" rx="2" /></>),
  LogOut: makeIcon(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>),
  CreditCard: makeIcon(<><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 11h18M7 16h4" /></>),
  Code: makeIcon(<><path d="m8 16-4-4 4-4" /><path d="m16 8 4 4-4 4" /><path d="m14 4-4 16" /></>),
  MoreHorizontal: makeIcon(<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>),
  Hash: makeIcon(<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />),
} as const;

export type IconName = keyof typeof Icon;
