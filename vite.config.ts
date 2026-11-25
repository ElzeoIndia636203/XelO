import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function sitemapPlugin(siteUrl: string): Plugin {
  return {
    name: 'xeio-sitemap',
    closeBundle() {
      const base = siteUrl.replace(/\/+$/, '');
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        `  <url><loc>${base}/</loc></url>`,
        `  <url><loc>${base}/app/login</loc></url>`,
        '</urlset>',
        '',
      ].join('\n');
      writeFileSync(resolve(import.meta.dirname, 'dist/sitemap.xml'), xml, 'utf8');
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const siteUrl = env.VITE_SITE_URL || 'https://xeio.in';

  return {
    plugins: [react(), sitemapPlugin(siteUrl)],
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          app: resolve(import.meta.dirname, 'app/index.html'),
        },
        output: {
          manualChunks(id) {
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('react-router') || id.includes('react-dom') || id.includes('\\react\\') || id.includes('/react/')) {
              return 'vendor-react';
            }
          },
        },
      },
    },
  };
});
