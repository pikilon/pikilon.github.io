#!/usr/bin/env node
/**
 * build.mjs — Genera el sitio estático completo a partir de db/pikilon.db.
 *
 * Escribe en public/, que es una carpeta autocontenida: ábrela con cualquier
 * servidor estático y funciona. No hay dependencias externas ni paso de
 * compilación: sólo Node y el esquema SQLite del repositorio.
 *
 * Uso:
 *   node scripts/build.mjs                 # genera public/
 *   node scripts/build.mjs --out=otra/dir  # otro destino
 *   node scripts/build.mjs --drafts        # incluye borradores (para revisar)
 *
 * Estructura generada:
 *   /                             portada / CV
 *   /writing/                     índice de artículos
 *   /code/<slug>/  /imho/<slug>/  cada artículo en su URL original
 *   /cat/<slug>/   /tag/<slug>/   archivos de taxonomía
 *   /feed.xml  /sitemap.xml  /404.html  /robots.txt
 *
 * Las URLs imitan las del WordPress original (que usaba /<categoría>/<slug>/)
 * para no romper los enlaces ya existentes ni el posicionamiento en buscadores.
 */

import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './markdown.mjs';
import { layout, card, formatDate, escapeHtml, escapeAttr } from './templates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'db', 'pikilon.db');

const args = process.argv.slice(2);
const OUT = resolve(ROOT, (args.find((a) => a.startsWith('--out=')) || '').split('=')[1] || 'public');
const INCLUDE_DRAFTS = args.includes('--drafts');

/* --------------------------------------------------------------- utilidades */

const written = [];
const pages = [];

/** Escribe un archivo creando los directorios que falten. */
async function emit(relPath, content) {
  const full = join(OUT, relPath);
  await mkdir(dirname(full), { recursive: true });
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await writeFile(full, body);
  written.push(relPath);
}

/** Registra una página para el sitemap. */
const page = (url, { priority = 0.6, changefreq = 'monthly', lastmod } = {}) =>
  pages.push({ url, priority, changefreq, lastmod });

/* ------------------------------------------------------------------ datos */

function loadData() {
  if (!existsSync(DB_PATH)) {
    throw new Error('No existe db/pikilon.db. Ejecuta antes: node scripts/import.mjs');
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const site = one('SELECT * FROM site WHERE id = 1');
  if (!site) throw new Error('La tabla site está vacía. Vuelve a ejecutar scripts/import.mjs');

  const statuses = INCLUDE_DRAFTS ? ['published', 'draft'] : ['published'];

  const entries = all(
    `SELECT * FROM entries
     WHERE status IN (${statuses.map(() => '?').join(',')})
     ORDER BY published_at DESC`,
    ...statuses,
  );

  // Términos de cada entrada, ya agrupados, para no consultar dentro del bucle.
  const termsByEntry = new Map();
  for (const row of all(`
    SELECT et.entry_id, t.id, t.kind, t.slug, t.name
    FROM entry_terms et JOIN terms t ON t.id = et.term_id
    ORDER BY t.position
  `)) {
    if (!termsByEntry.has(row.entry_id)) termsByEntry.set(row.entry_id, []);
    termsByEntry.get(row.entry_id).push(row);
  }

  const media = new Map(all('SELECT * FROM media').map((m) => [m.id, m]));

  const terms = all(`
    SELECT t.*, COUNT(e.id) AS entries
    FROM terms t
    LEFT JOIN entry_terms et ON et.term_id = t.id
    LEFT JOIN entries e ON e.id = et.entry_id AND e.status = 'published'
    GROUP BY t.id
    ORDER BY t.kind, t.position, t.name
  `);

  const links = all('SELECT * FROM links WHERE visible = 1 ORDER BY position');
  db.close();

  // Los artículos se publican bajo su categoría principal, igual que en
  // WordPress; si no tienen ninguna, caen en /writing/.
  const withMeta = entries.map((e) => {
    const own = termsByEntry.get(e.id) || [];
    const cats = own.filter((t) => t.kind === 'category');
    const tags = own.filter((t) => t.kind === 'tag');
    const primary = cats[0];
    const url =
      e.kind === 'page'
        ? `/${e.slug}/`
        : `/${primary ? primary.slug : 'writing'}/${e.slug}/`;
    return {
      ...e,
      categories: cats,
      tags,
      primaryCategory: primary,
      url,
      html: normalizeAssetUrls(renderMarkdown(e.body || '')),
      featured: e.featured_id ? media.get(e.featured_id) : null,
      featuredUrl: e.featured_id ? mediaUrl(media.get(e.featured_id)) : '',
      readingMinutes: readingTime(e.body || ''),
    };
  });

  return { site, entries: withMeta, terms, links, media };
}

/** Estimación de tiempo de lectura a 200 palabras por minuto. */
function readingTime(md) {
  const words = String(md).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/**
 * URL servible de un medio, siempre absoluta desde la raíz del sitio.
 * En la base de datos las rutas son relativas a assets/ (p. ej.
 * "wp-content/uploads/…"), así que aquí se les añade el prefijo.
 */
export const mediaUrl = (m) => (m ? assetHref(m.path) : '');

/**
 * Normaliza una ruta de recurso a una URL absoluta del sitio.
 * Acepta las tres formas que aparecen en el contenido migrado:
 *   "assets/…"        -> "/assets/…"          (Markdown ya migrado)
 *   "/wp-content/…"   -> "/assets/wp-content/…" (HTML original de WordPress)
 *   "wp-content/…"    -> "/assets/wp-content/…"
 */
export function assetHref(path) {
  let p = String(path || '').replace(/^\.\//, '');
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith('/wp-content/') || p.startsWith('wp-content/')) {
    p = p.replace(/^\/?(wp-content\/)/, 'assets/$1');
  }
  if (!p.startsWith('/') && !p.startsWith('assets/')) p = `assets/${p}`;
  return p.startsWith('/') ? p : `/${p}`;
}

/**
 * Reescribe las rutas de los recursos dentro del HTML ya renderizado.
 * El conversor de Markdown no conoce la raíz del sitio, así que la
 * normalización se hace aquí, en un único punto y para todo el contenido.
 */
export function normalizeAssetUrls(html) {
  return String(html).replace(
    /\b(src|href)="((?:\.\/)?(?:assets\/|\/?wp-content\/)[^"]*)"/gi,
    (_, attrName, url) => `${attrName}="${assetHref(url)}"`,
  );
}

/* -------------------------------------------------------------- generación */

async function build() {
  const t0 = Date.now();
  const { site, entries, terms, links } = loadData();
  const posts = entries.filter((e) => e.kind === 'post');
  const pagesOnly = entries.filter((e) => e.kind === 'page');

  console.log(`Generando ${entries.length} entradas + ${terms.length} términos en ${OUT.replace(ROOT + '/', '')}/\n`);

  // La carpeta se recrea entera salvo assets/, que se copia tal cual: así no
  // quedan páginas huérfanas de ejecuciones anteriores.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  if (existsSync(join(ROOT, 'assets'))) {
    await cp(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });
  }

  const ctx = { site, links, entries, posts, terms };

  // ---- portada / CV -----------------------------------------------------
  const home = pagesOnly.find((e) => e.slug === 'home') || pagesOnly[0];
  const recent = posts.slice(0, 6);

  await emit(
    'index.html',
    layout({
      site,
      title: site.title,
      description: site.description || site.tagline || '',
      content: home
        ? `${home.html}${postsSection(recent, site)}`
        : postsSection(recent, site),
      url: '/',
      nav: 'home',
    }),
  );
  page('/', { priority: 1.0, changefreq: 'weekly', lastmod: latestDate(entries) });

  // ---- artículo con la home, por si tiene slug propio --------------------
  if (home && home.slug !== 'home') {
    await emit(
      `${home.slug}/index.html`,
      layout({ site, title: home.title, description: home.summary || '', content: home.html, url: `/${home.slug}/`, nav: 'home' }),
    );
    page(`/${home.slug}/`, { priority: 0.8 });
  }

  // ---- índice de artículos ----------------------------------------------
  await emit(
    'writing/index.html',
    layout({
      site,
      title: `Writing`,
      description: `Todos los artículos de ${site.author_name}`,
      content: `<h1>Writing</h1>\n<p class="lead">${posts.length} artículos sobre desarrollo web, rendimiento y opinión.</p>\n${postsSection(posts, site, { all: true })}`,
      url: '/writing/',
      nav: 'writing',
    }),
  );
  page('/writing/', { priority: 0.8, changefreq: 'weekly', lastmod: latestDate(posts) });

  // ---- cada entrada ------------------------------------------------------
  for (const e of entries) {
    const related = posts
      .filter((p) => p.id !== e.id && p.primaryCategory?.slug && p.primaryCategory.slug === e.primaryCategory?.slug)
      .slice(0, 3);

    await emit(
      `${e.url.replace(/^\//, '')}index.html`,
      layout({
        site,
        title: e.title,
        description: e.summary || '',
        url: e.url,
        nav: e.kind === 'post' ? 'writing' : '',
        ogType: e.kind === 'post' ? 'article' : 'website',
        publishedAt: e.published_at,
        updatedAt: e.updated_at,
        featured: e.featuredUrl,
        content: article({ entry: e, related, site }),
      }),
    );
    page(e.url, {
      priority: e.kind === 'post' ? 0.7 : 0.6,
      lastmod: (e.updated_at || e.published_at || '').slice(0, 10),
    });
  }

  // ---- taxonomías --------------------------------------------------------
  for (const t of terms) {
    const own = entries.filter((e) =>
      [...e.categories, ...e.tags].some((x) => x.id === t.id),
    );
    if (!own.length) continue; // los términos vacíos no generan página
    const dir = t.kind === 'category' ? 'cat' : 'tag';

    await emit(
      `${dir}/${t.slug}/index.html`,
      layout({
        site,
        title: `${t.kind === 'category' ? 'Categoría' : 'Etiqueta'}: ${t.name}`,
        description: `Artículos en ${t.name}`,
        content: `<h1>${t.kind === 'category' ? '' : '<span class="tagmark">#</span>'}${escapeHtml(t.name)}</h1>
<p class="lead">${own.length} ${own.length === 1 ? 'artículo' : 'artículos'}${t.kind === 'category' ? ' en esta categoría' : ' con esta etiqueta'}.</p>
${postsSection(own, site, { all: true })}`,
        url: `/${dir}/${t.slug}/`,
      }),
    );
    page(`/${dir}/${t.slug}/`, { priority: 0.4, changefreq: 'weekly', lastmod: latestDate(own) });
  }

  // ---- archivo de taxonomías (para no dejar términos inalcanzables) ------
  await emit('topics/index.html', layout({
    site,
    title: 'Temas',
    description: 'Todas las categorías y etiquetas del sitio',
    content: topicsIndex(terms, entries, site),
    url: '/topics/',
  }));
  page('/topics/', { priority: 0.4 });

  // ---- feed, sitemap, robots y 404 --------------------------------------
  await emit('feed.xml', rssFeed({ site, posts: posts.slice(0, 20) }));
  await emit('sitemap.xml', sitemap(site));
  await emit('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`);
  await emit('favicon.svg', FAVICON);
  await emit('404.html', layout({
    site,
    title: 'Página no encontrada',
    description: '',
    url: '/404.html',
    content: `<h1>404</h1>\n<p class="lead">Esa página no existe (o ya no). Prueba desde <a href="/">la portada</a> o el <a href="/writing/">archivo de artículos</a>.</p>`,
  }));

  // ---- redirecciones de URLs antiguas de WordPress ----------------------
  await emit(
    '_redirects',
    [
      '# Categorías: WordPress servía /category/<slug>/ además de /cat/<slug>/.',
      ...terms.filter((t) => t.kind === 'category' && t.entries > 0).map((t) => `/category/${t.slug}/  /cat/${t.slug}/  301`),
      '',
      '# El feed antiguo como XML.',
      '/feed/  /feed.xml  301',
      '',
    ].join('\n'),
  );

  // ---- informe -----------------------------------------------------------
  const bytes = (
    await Promise.all(written.filter((f) => f.endsWith('.html')).map((f) => readFile(join(OUT, f)).then((b) => b.length)))
  ).reduce((a, b) => a + b, 0);

  const db = new DatabaseSync(DB_PATH);
  db.prepare(`INSERT INTO builds (started_at, finished_at, tool, entries, output_dir, notes)
              VALUES (?, ?, 'build.mjs', ?, ?, ?)`).run(
    new Date(t0).toISOString(),
    new Date().toISOString(),
    entries.length,
    OUT.replace(ROOT + '/', ''),
    INCLUDE_DRAFTS ? 'incluye borradores' : '',
  );
  db.close();

  console.log(`${written.length} archivos escritos (${(bytes / 1024).toFixed(0)} KB de HTML)`);
  console.log(`${pages.length} URLs en el sitemap`);
  console.log(`Listo en ${((Date.now() - t0) / 1000).toFixed(2)}s\n`);

  return { written, pages, out: OUT };
}

/** Fecha más reciente de un conjunto de entradas, para `lastmod`. */
const latestDate = (list) =>
  list
    .map((e) => (e.updated_at || e.published_at || '').slice(0, 10))
    .filter(Boolean)
    .sort()
    .pop();

/** Icono del sitio, incrustado para no depender de ningún archivo externo. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Pikilon">
<rect width="64" height="64" rx="14" fill="#1f6feb"/>
<text x="32" y="45" font-family="ui-sans-serif,system-ui,Helvetica,Arial,sans-serif" font-size="38" font-weight="700" fill="#fff" text-anchor="middle">P</text>
</svg>
`;

/* -------------------------------------------------------------- fragmentos */

/** Sección de tarjetas de artículos. */
function postsSection(posts, site, { all = false } = {}) {
  if (!posts.length) return '<p class="lead">Todavía no hay artículos publicados.</p>';
  return `<div class="cards">\n${posts
    .map((p) => card({ entry: p, site, showCategory: all }))
    .join('\n')}\n</div>`;
}

/** Página de artículo: cabecera, cuerpo y navegación relacionada. */
function article({ entry, related, site }) {
  const cats = entry.categories
    .map((c) => `<a class="chip chip--cat" href="/cat/${c.slug}/">${escapeHtml(c.name)}</a>`)
    .join(' ');
  const tags = entry.tags
    .map((t) => `<a class="chip chip--tag" href="/tag/${t.slug}/">#${escapeHtml(t.name)}</a>`)
    .join(' ');

  const meta = [
    entry.published_at ? `<time datetime="${escapeAttr(entry.published_at)}">${formatDate(entry.published_at)}</time>` : '',
    `<span>${entry.readingMinutes} min de lectura</span>`,
  ]
    .filter(Boolean)
    .join(' · ');

  const featured = entry.featured
    ? `<img class="hero" src="${escapeAttr(entry.featuredUrl)}" alt="${escapeAttr(entry.featured.alt || '')}" width="${entry.featured.width || ''}" height="${entry.featured.height || ''}" loading="eager" decoding="async">`
    : '';

  const relatedBlock = related.length
    ? `<aside class="related">\n<h2>Sigue leyendo</h2>\n<ul>\n${related
        .map((r) => `<li><a href="${escapeAttr(r.url)}">${escapeHtml(r.title)}</a></li>`)
        .join('\n')}\n</ul>\n</aside>`
    : '';

  return `<article class="entry">
<header class="entry__header">
<h1>${escapeHtml(entry.title)}</h1>
<p class="entry__meta">${meta}</p>
${cats || tags ? `<p class="entry__terms">${cats} ${tags}</p>` : ''}
</header>
${featured}
<div class="prose">
${entry.html}
</div>
<footer class="entry__footer">
<p><a href="/writing/">← Todos los artículos</a></p>
</footer>
</article>
${relatedBlock}`;
}

/** Índice de todos los temas: categorías con sus etiquetas. */
function topicsIndex(terms, entries, site) {
  const cats = terms.filter((t) => t.kind === 'category' && t.entries > 0);
  const tags = terms.filter((t) => t.kind === 'tag' && t.entries > 0);

  return `<h1>Temas</h1>
<p class="lead">Categorías y etiquetas de todo lo publicado.</p>
<section>
<h2>Categorías</h2>
<ul class="topic-list">
${cats.map((c) => `<li><a href="/cat/${c.slug}/">${escapeHtml(c.name)}</a> <span class="count">${c.entries}</span></li>`).join('\n')}
</ul>
</section>
<section>
<h2>Etiquetas</h2>
<ul class="topic-list topic-list--tags">
${tags.map((t) => `<li><a href="/tag/${t.slug}/">#${escapeHtml(t.name)}</a> <span class="count">${t.entries}</span></li>`).join('\n')}
</ul>
</section>`;
}

/** Feed RSS 2.0 con el contenido completo. */
function rssFeed({ site, posts }) {
  const items = posts
    .map((p) => {
      const link = `${site.url}${p.url}`;
      return `  <item>
    <title>${escapeHtml(p.title)}</title>
    <link>${escapeHtml(link)}</link>
    <guid isPermaLink="true">${escapeHtml(link)}</guid>
    <pubDate>${p.published_at ? new Date(p.published_at).toUTCString() : ''}</pubDate>
${p.categories.map((c) => `    <category>${escapeHtml(c.name)}</category>`).join('\n')}
    <description>${escapeHtml(p.summary || '')}</description>
  </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeHtml(site.title)}</title>
  <link>${escapeHtml(site.url)}/</link>
  <description>${escapeHtml(site.description || site.tagline || '')}</description>
  <language>${escapeHtml(site.lang || 'en')}</language>
  <atom:link href="${escapeHtml(site.url)}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>
`;
}

/** Sitemap XML estándar. */
function sitemap(site) {
  const urls = pages
    .map(
      (p) => `  <url>
    <loc>${escapeHtml(site.url + p.url)}</loc>${p.lastmod ? `\n    <lastmod>${p.lastmod}</lastmod>` : ''}
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority.toFixed(1)}</priority>
  </url>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

/* -------------------------------------------------------------------- main */

build().catch((err) => {
  console.error('\nERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
