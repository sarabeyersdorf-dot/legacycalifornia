#!/usr/bin/env node
/*
 * Regenerates public/sitemap.xml from the list of public marketing pages below.
 *
 * Run it any time you add/edit a public page:
 *     npm run sitemap
 *
 * <lastmod> for each page comes from that file's last git commit date (not
 * "today for everything" — uniform dates are a search-spam signal). If a file
 * isn't committed yet it falls back to the file's modified time.
 *
 * To add a new public page: add one line to PAGES and re-run. Utility / logged-in
 * / IDX-shell pages are intentionally left out.
 */
import { execSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const ORIGIN = 'https://legacycalifornia.com';

// file (in public/)            → URL path            priority
const PAGES = [
  ['index.html',                 '/',                  '1.0'],
  ['about.html',                 '/about.html',        '0.9'],
  ['how-we-work.html',           '/how-we-work.html',  '0.7'],
  ['relocate.html',              '/relocate.html',     '0.8'],
  ['towns.html',                 '/towns.html',        '0.8'],
  ['town-murphys.html',          '/town-murphys.html', '0.8'],
  ['town-arnold.html',           '/town-arnold.html',  '0.8'],
  ['town-angels-camp.html',      '/town-angels-camp.html', '0.8'],
  ['town-copperopolis.html',     '/town-copperopolis.html', '0.8'],
  ['town-sutter-creek.html',     '/town-sutter-creek.html', '0.8'],
  ['town-shenandoah-valley.html','/town-shenandoah-valley.html', '0.8'],
  ['river-mountain.html',        '/river-mountain.html', '0.7'],
  ['fire-zone.html',             '/fire-zone.html',    '0.7'],
  ['commute.html',               '/commute.html',      '0.6'],
  ['valuation.html',             '/valuation.html',    '0.7'],
  ['market-report.html',         '/market-report.html','0.7'],
  ['ledger.html',                '/ledger.html',       '0.6'],
  ['find-my-match.html',         '/find-my-match.html','0.7'],
  ['property-search.html',       '/property-search.html', '0.7'],
  ['featured-listings.html',     '/featured-listings.html', '0.6'],
  ['sold-featured-listings.html','/sold-featured-listings.html', '0.5'],
  ['open-home-listings.html',    '/open-home-listings.html', '0.6'],
  ['mortgage-calculator.html',   '/mortgage-calculator.html', '0.5'],
];

function lastmod(file) {
  const abs = join(PUBLIC, file);
  try {
    const d = execSync(`git log -1 --format=%cs -- "public/${file}"`, { cwd: ROOT })
      .toString().trim();
    if (d) return d;
  } catch { /* not committed yet */ }
  return statSync(abs).mtime.toISOString().slice(0, 10);
}

const urls = PAGES.map(([file, path, priority]) => {
  statSync(join(PUBLIC, file)); // throws if a listed page is missing
  return [
    '  <url>',
    `    <loc>${ORIGIN}${path}</loc>`,
    `    <lastmod>${lastmod(file)}</lastmod>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n');
});

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

writeFileSync(join(PUBLIC, 'sitemap.xml'), xml);
console.log(`sitemap.xml written with ${PAGES.length} URLs.`);
