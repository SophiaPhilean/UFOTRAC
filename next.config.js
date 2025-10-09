// next.config.js
const withPWA = require('next-pwa')({
  dest: 'public',
  // PWA off in dev, on in production (Vercel sets NODE_ENV=production)
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,

  // Put runtimeCaching at the TOP LEVEL (no workboxOptions)
  runtimeCaching: [
    {
      // Only cache http/https (ignore chrome-extension:// etc.)
      urlPattern: ({ url }) => url.protocol === 'http:' || url.protocol === 'https:',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'http-cache',
        expiration: {
          maxEntries: 200,
          maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
        },
      },
    },
  ],
});

module.exports = withPWA({
  reactStrictMode: true,

  // Don’t fail the build on lint / type warnings while we iterate
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
});
