// next.config.js
const withPWA = require('next-pwa')({
  dest: 'public',
  // Off in dev, ON in production (Vercel sets NODE_ENV=production)
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  // Keep the SW from trying to cache browser extension URLs
  workboxOptions: {
    runtimeCaching: [
      {
        // Only handle http/https requests
        urlPattern: ({ url }) => url.protocol === 'http:' || url.protocol === 'https:',
        handler: 'NetworkFirst',
        options: {
          cacheName: 'http-cache',
          expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
        },
      },
    ],
    clientsClaim: true,
    navigateFallbackDenylist: [/^\/_next\//],
  },
});

module.exports = withPWA({
  reactStrictMode: true,
});
