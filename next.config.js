// next.config.js
const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  // Only handle http(s) requests so we don't touch chrome-extension://
  workboxOptions: {
    // Ensure the SW doesn't try to cache extension requests
    runtimeCaching: [
      {
        urlPattern: ({ url }) => url.protocol === 'http:' || url.protocol === 'https:',
        handler: 'NetworkFirst',
        options: {
          cacheName: 'http-cache',
          expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
        },
      },
    ],
    // Be resilient
    clientsClaim: true,
    navigateFallbackDenylist: [/^\/_next\//],
  },
});

module.exports = withPWA({
  reactStrictMode: true,
});
