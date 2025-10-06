// next.config.js

const withPWA = require("next-pwa")({
  dest: "public",            // where the service worker will live
  register: true,            // automatically registers service worker
  skipWaiting: true,         // updates the PWA as soon as a new build is available
  disable: process.env.NODE_ENV !== "production", // only run PWA in production (i.e. on Vercel)
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true, // don't fail Vercel builds if ESLint errors exist
  },
  typescript: {
    ignoreBuildErrors: true, // don't fail Vercel builds if TypeScript errors exist
  },
};

// ✅ Export the Next.js config wrapped with PWA support
module.exports = withPWA(nextConfig);

