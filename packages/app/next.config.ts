import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages are TS source, not prebuilt — transpile them here
  // rather than adding a build step to each one.
  transpilePackages: ['@job-digest/core', '@job-digest/db', '@job-digest/ingest', '@job-digest/worker'],
  experimental: {
    staleTimes: {
      // Next 15 changed the client Router Cache default to 0s for dynamic
      // routes — every navigation, even back to a page visited seconds ago,
      // re-fetches from scratch (design: perf pass, Aug 2026 — found live as
      // part of why tab-switching felt slow). 30s restores Next 14's old
      // default. This is safe with I9 (a failed run never empties the
      // screen): every mutation already calls revalidatePath, which busts
      // this cache for that path explicitly — a stale read only happens
      // within 30s of a navigation nobody acted on.
      dynamic: 30,
    },
    // Server Actions default to a 1MB body limit — well under
    // MAX_CV_BYTES (8MB, packages/ingest/src/cv-pdf.ts). Without this, a
    // real CV upload fails with an opaque "Body exceeded 1mb limit" before
    // uploadCv (docs/adr-001-role-discovery.md §3) ever runs.
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

export default nextConfig;
