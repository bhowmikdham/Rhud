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
  // Tell Next that the workspace root is two levels up so file tracing
  // captures @rhud/shared and other monorepo deps in the standalone bundle.
  outputFileTracingRoot: path.join(__dirname, '../../'),
};

export default nextConfig;
