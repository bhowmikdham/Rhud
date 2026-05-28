// Inline stroke icons (Fluent / Lucide style), ported from the design's
// shared.jsx. Single <Icon> primitive; each named icon is a thin wrapper.

import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  stroke?: number;
  style?: CSSProperties;
}

function Icon({
  d,
  size = 16,
  stroke = 1.6,
  style,
}: IconProps & { d: string | string[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}

export const I = {
  close: (p: IconProps) => <Icon {...p} d="M6 6l12 12 M18 6L6 18" />,
  edit: (p: IconProps) => <Icon {...p} d={['M4 20h4l11-11-4-4L4 16v4z', 'M14 5l5 5']} />,
  check: (p: IconProps) => <Icon {...p} d="M4 12l5 5L20 6" />,
  chevDown: (p: IconProps) => <Icon {...p} d="M6 9l6 6 6-6" />,
  chevRight: (p: IconProps) => <Icon {...p} d="M9 6l6 6-6 6" />,
  sparkles: (p: IconProps) => (
    <Icon
      {...p}
      d={[
        'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z',
        'M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z',
      ]}
    />
  ),
  mail: (p: IconProps) => (
    <Icon {...p} d={['M3 7l9 6 9-6', 'M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z']} />
  ),
  send: (p: IconProps) => <Icon {...p} d="M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z" />,
  arrowRight: (p: IconProps) => <Icon {...p} d="M5 12h14 M13 5l7 7-7 7" />,
  helpHex: (p: IconProps) => (
    <Icon {...p} d={['M12 2l8 5v10l-8 5-8-5V7l8-5z', 'M9.5 9a2.5 2.5 0 015 0c0 2-2.5 2-2.5 4 M12 17h.01']} />
  ),
  grid: (p: IconProps) => <Icon {...p} d={['M3 3h8v8H3z', 'M13 3h8v8h-8z', 'M3 13h8v8H3z', 'M13 13h8v8h-8z']} />,
  alert: (p: IconProps) => (
    <Icon
      {...p}
      d={['M12 9v4', 'M12 17h.01', 'M10.3 3.86l-8.18 14.5A2 2 0 003.86 21h16.28a2 2 0 001.74-2.64L13.7 3.86a2 2 0 00-3.4 0z']}
    />
  ),
  link: (p: IconProps) => (
    <Icon {...p} d={['M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.5 1.5', 'M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.5-1.5']} />
  ),
  clock: (p: IconProps) => <Icon {...p} d={['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M12 7v5l3 2']} />,
  refresh: (p: IconProps) => (
    <Icon {...p} d={['M3 12a9 9 0 0115-6.7L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 01-15 6.7L3 16', 'M3 21v-5h5']} />
  ),
};
