/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@rhud/shared'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
