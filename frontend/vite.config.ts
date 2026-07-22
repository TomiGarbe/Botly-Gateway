import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.ico', 'favicon.svg', 'favicon-16x16.png', 'favicon-32x32.png',
        'apple-touch-icon.png', 'android-chrome-192x192.png', 'android-chrome-512x512.png',
        'mstile-150x150.png', 'safari-pinned-tab.svg', 'browserconfig.xml',
        'logo-gateway.svg', 'logo-gateway-light.svg', 'logo-gateway-mark.svg', 'logo-gateway.png',
      ],
      manifest: {
        id: '/',
        name: 'Botly Gateway',
        short_name: 'Botly Gateway',
        description: 'Conecta y administra tus canales, mensajes y webhooks.',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'es',
        icons: [
          {
            src: '/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
