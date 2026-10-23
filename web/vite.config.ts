import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH is set by the GitHub Pages build (e.g. /jk-bhairavi/); local dev serves from /.
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    // Makes the app installable and lets it open offline. Only the app's own files are
    // precached; Supabase requests are never cached, so data is always live.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'JK Bhairavi',
        short_name: 'JK Bhairavi',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#f7f7f5',
        theme_color: '#f7f7f5',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // .mjs covers the pdf.js worker used for invoice imports.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png}'],
        // Deep links like /orders get index.html, matching the Cloudflare SPA fallback.
        navigateFallback: `${base}index.html`,
        // pdf.js worker and chart bundles can exceed Workbox's 2 MiB default.
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
    }),
  ],
})
