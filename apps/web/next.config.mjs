// We use a symlink at apps/web/.env.local → ../../.env so Next.js picks up
// the monorepo-root env file natively. That is more reliable than
// loadEnvConfig() — Next's static page collection step doesn't always honor
// programmatic env loading. See apps/web/.env.local.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@scott-ops/shared'],
  // typedRoutes is incompatible with dynamic `redirect(target)` calls from
  // server actions where the path comes from a request param.

  // Skip type-checking and lint during the production build. We run both
  // explicitly via `pnpm --filter web typecheck` / lint scripts before
  // each commit, so running them again in `next build` is redundant —
  // and was OOM-killing the XCloud build container after the 5-min
  // webpack compile. Build-time correctness still rests on the
  // pre-commit checks; this just lets the deploy server focus on
  // bundling.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Server Actions cap request bodies at 1MB by default — fine for
  // typical form posts but kills image uploads (phone photos are 5-12MB).
  // Bump to 25MB to match the multipart limit on the API. Anything over
  // 25MB gets rejected at the API layer with a clean 413 instead of a
  // generic Next.js exception.
  experimental: {
    serverActions: {
      bodySizeLimit: '25mb',
    },

    // ─── Build-container memory (round two) ──────────────────────────────
    // Disabling typecheck+lint above bought headroom the first time the
    // XCloud build container OOM-killed `next build`; the app has since
    // grown and the WEBPACK COMPILE itself now gets SIGTERM'd mid-build
    // ("Creating an optimized production build ..." → killed). Nothing is
    // wrong with the code — the same build completes locally in ~10s at
    // ~1.2 GB peak RSS, but that peak scales with core count and the
    // container has far less room than a dev machine.
    //
    // webpackMemoryOptimizations trades some build speed for a materially
    // lower memory ceiling; cpus caps how many compile workers run at once,
    // since peak memory is roughly per-worker. Both are safe to raise again
    // (or delete) once the box has more RAM or swap.
    // The deploy box is a ~951MB VPS, so this is tuned hard: one compile
    // worker, not two. Peak memory is roughly per-worker, and on a box this
    // size a second worker is the difference between finishing and being
    // OOM-killed. Raise it if the box ever gets more RAM.
    webpackMemoryOptimizations: true,
    cpus: 1,
  },

  // packages/shared uses TypeScript's "import './x.js'" convention required
  // by NodeNext resolution (the API). Webpack's default resolver doesn't
  // know to also try '.ts' for those imports — extensionAlias fixes it.
  // See https://webpack.js.org/configuration/resolve/#resolveextensionalias
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
