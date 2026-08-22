/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The cache snapshot is read from disk at request time by the /api routes,
  // so it must not be bundled or traced away.
  outputFileTracingIncludes: {
    '/api/**/*': ['./data/**/*'],
  },
};
export default nextConfig;
