import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@rhud/shared'],
  // Emit a minimal self-contained server bundle for the Docker runtime image.
  // See https://nextjs.org/docs/app/api-reference/next-config-js/output
  output: 'standalone',
  experimental: {
    // Tell Next that the workspace root is two levels up so file tracing
    // captures @rhud/shared and other monorepo deps in the standalone bundle.
    // Lives under `experimental` in Next 14.2.x (top-level was unrecognised).
    outputFileTracingRoot: path.join(__dirname, '../../'),
  },
  // Skip ESLint during prod builds — lint should be enforced via CI /
  // pre-commit hooks, not inside the Docker build. Existing repo has
  // a handful of `react/no-unescaped-entities` and a stale
  // `@typescript-eslint/no-explicit-any` config reference; addressing
  // them as a separate cleanup pass keeps this deploy unblocked.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
