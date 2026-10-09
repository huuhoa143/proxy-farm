// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://proxyfarm.lingoreup.com',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  integrations: [
    sitemap({
      i18n: { defaultLocale: 'vi', locales: { vi: 'vi', en: 'en' } },
      filter: (page) => !page.includes('/404'),
    }),
  ],
});
