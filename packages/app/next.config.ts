import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages are TS source, not prebuilt — transpile them here
  // rather than adding a build step to each one.
  transpilePackages: ['@job-digest/core', '@job-digest/db', '@job-digest/ingest', '@job-digest/worker'],
};

export default nextConfig;
