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

  // Variantes de cada medio (los tamaños que generó WordPress). Se sirven
  // todas con `srcset` para que el navegador descargue la que necesita en vez
  // del original: el retrato de la portada pasa de 79 KB a 18 KB.
  const variantsByMedia = new Map();
  for (const v of all('SELECT * FROM media_variants ORDER BY width')) {
    if (!v.width || !v.height) continue;
    if (!variantsByMedia.has(v.media_id)) variantsByMedia.set(v.media_id, []);
    variantsByMedia.get(v.media_id).push(v);
  }

  const terms = all(`
    SELECT t.*, COUNT(e.id) AS entries
    FROM terms t
    LEFT JOIN entry_terms et ON et.term_id = t.id
    LEFT JOIN entries e ON e.id = et.entry_id AND e.status = 'published'
    GROUP BY t.id
    ORDER BY t.kind, t.position, t.name
  `);

  const links = all('SELECT * FROM links WHERE visible = 1 ORDER BY position');

  // Datos estructurados del CV. Se leen siempre, aunque estén vacíos: la
  // plantilla decide si merece la pena mostrar cada sección.
  const cv = {
    experience: all('SELECT * FROM experience WHERE visible = 1 ORDER BY position, started_at DESC'),
    education: all('SELECT * FROM education WHERE visible = 1 ORDER BY position, ended_at DESC'),
    skills: all('SELECT * FROM skills WHERE visible = 1 ORDER BY position, area, name'),
    projects: all('SELECT * FROM projects WHERE visible = 1 ORDER BY position, name'),
  };
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
      featuredSrcset: e.featured_id
        ? srcsetFor(media.get(e.featured_id), variantsByMedia.get(e.featured_id), mediaUrl)
        : '',
      readingMinutes: readingTime(e.body || ''),
    };
  });

  return { site, entries: withMeta, terms, links, media, variantsByMedia, cv };
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
 * Variantes de la foto del CV.
 * En la tabla `media` la ruta va sin el prefijo `assets/`, que es como la
 * guarda el importador; aquí hay que normalizarla para poder buscar la fila.
 */
function portraitVariantsOf(site, media, variantsByMedia) {
  if (!site?.author_photo) return [];
  const wanted = String(site.author_photo).replace(/^\/?(assets\/)?/, '');
  for (const [id, m] of media) {
    if (m.path === wanted) return variantsByMedia.get(id) || [];
  }
  return [];
}

/**
 * Construye el atributo `srcset` de un medio con todas sus variantes.
 *
 * WordPress generó cinco tamaños de cada imagen y se estaban sirviendo los
 * originales: el retrato de la portada pesaba 79 KB para mostrarse a 170 px.
 * Con `srcset` el navegador elige según el ancho real y la densidad de
 * pantalla, así que en un móvil no se descarga la imagen grande.
 *
 * Se descartan las variantes de menos de 100 px de ancho: sólo aportan ruido
 * al atributo y nunca ganan la elección.
 *
 * @param {object} main       fila de `media` (el original)
 * @param {object[]} variants filas de `media_variants`
 * @param {(m: object) => string} toUrl
 * @returns {string} el valor de `srcset`, o cadena vacía si no hay variantes
 */
function srcsetFor(main, variants, toUrl) {
  if (!main) return '';
  const byWidth = new Map();

  // El original entra por su ancho real (si lo conocemos).
  if (main.width) byWidth.set(main.width, toUrl(main));
  for (const v of variants || []) {
    if (v.width < 100) continue;
    // A igual ancho, se queda la primera (las variantes vienen ordenadas).
    if (!byWidth.has(v.width)) byWidth.set(v.width, assetHref(v.path));
  }

  const entries = [...byWidth].sort((a, b) => a[0] - b[0]);
  if (entries.length < 2) return ''; // con una sola no hay nada que elegir
  return entries.map(([w, url]) => `${url} ${w}w`).join(', ');
}

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
  const { site, entries, terms, links, media, variantsByMedia, cv } = loadData();
  const posts = entries.filter((e) => e.kind === 'post');

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
  // La portada no sale de una entrada: se compone con la presentación de la
  // tabla `site` más las secciones estructuradas del CV. Así el CV es dato,
  // no un párrafo enterrado en un Markdown.
  const recent = posts.slice(0, 6);

  await emit(
    'index.html',
    layout({
      site,
      title: site.title,
      description: site.description || site.tagline || '',
      content: cvPage({
        site,
        cv,
        links,
        // Variantes del retrato, para poder servirlo en el tamaño que se ve.
        portraitVariants: portraitVariantsOf(site, media, variantsByMedia),
      }) + postsSection(recent, site),
      url: '/',
      nav: 'home',
    }),
  );
  page('/', { priority: 1.0, changefreq: 'weekly', lastmod: latestDate(entries) });

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
    // La portada la compone el CV, y `import.mjs` ya no trae la página `home`.
    // Esta salvaguarda cubre bases de datos anteriores a ese cambio: antes que
    // generar una página duplicada, se emite una redirección a `/`.
    if (e.kind === 'page' && e.slug === 'home') {
      await emit(`${e.slug}/index.html`, redirectPage({ from: `/${e.slug}/`, to: '/', site }));
      continue;
    }

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
  // GitHub Pages NO admite el formato `_redirects` de Netlify, así que las
  // URLs antiguas necesitan un archivo de verdad. Se genera una página de
  // salto con <link rel="canonical">, que es lo que los buscadores leen como
  // redirección permanente cuando no se puede emitir un 301 real.
  const redirects = legacyRedirects(terms, site);
  for (const [from, to] of redirects) {
    await emit(`${from.replace(/^\//, '')}index.html`, redirectPage({ from, to, site }));
  }
  // Se mantiene además `_redirects`: no molesta en GitHub Pages y sirve si el
  // sitio se publica algún día en Netlify o Cloudflare Pages.
  await emit('_redirects', redirects.map(([from, to]) => `${from}  ${to}  301`).join('\n') + '\n');

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

/**
 * URLs que servía el WordPress original y que ya no se generan.
 *
 * Devolver una redirección por cada una evita perder los enlaces entrantes y
 * el posicionamiento acumulado. Las categorías son el caso importante:
 * WordPress las servía en /category/<slug>/ (con 301 a /cat/<slug>/), y un
 * 404 en una URL con enlaces externos es lo peor que se puede dejar.
 *
 * @returns {Array<[string, string]>} pares [origen, destino]
 */
function legacyRedirects(terms, site) {
  const out = [];
  // WordPress servía también /category/<slug>/ (con 301 a /cat/<slug>/).
  for (const t of terms) {
    if (t.kind === 'category' && t.entries > 0) out.push([`/category/${t.slug}/`, `/cat/${t.slug}/`]);
  }
  // El feed que servía WordPress en /feed/.
  out.push(['/feed/', '/feed.xml']);
  // La antigua página de inicio tenía slug `home`; ahora la portada es `/`.
  out.push(['/home/', '/']);
  return out;
}

/** Página mínima de redirección permanente. */
function redirectPage({ from, to, site }) {
  const target = to.startsWith('http') ? to : `${site.url}${to}`;
  const html = `<!DOCTYPE html>
<html lang="${escapeAttr(site.lang || 'en')}">
<head>
<meta charset="utf-8">
<title>Redirigido a ${escapeHtml(to)}</title>
<link rel="canonical" href="${escapeAttr(target)}">
<meta name="robots" content="noindex, follow">
<meta http-equiv="refresh" content="0; url=${escapeAttr(to)}">
</head>
<body>
<p>Esta página se ha movido a <a href="${escapeAttr(to)}">${escapeHtml(to)}</a>.</p>
</body>
</html>
`;
  return html;
}

/**
 * Portada: el CV.
 *
 * Se compone con la presentación (`site.bio`, en Markdown) y las secciones
 * estructuradas. Cada sección se omite si no tiene datos, así el CV se puede
 * ir rellenando poco a poco sin que queden huecos vacíos.
 */
function cvPage({ site, cv, links, portraitVariants = [] }) {  const out = [];

  // --- cabecera: foto, nombre y presentación ---
  const photo = site.author_photo ? assetHref(site.author_photo) : null;
  out.push('<header class="cv__head">');
  if (photo) {
    // El retrato se muestra a 170 px; sin `srcset` se descargaba el original
    // de 538 px (79 KB en vez de 18 KB) en todas las visitas.
    const set = srcsetFor(
      { path: String(site.author_photo).replace(/^assets\//, ''), width: null },
      portraitVariants,
      (m) => assetHref(m.path),
    );
    out.push(
      `<img class="portrait" src="${escapeAttr(photo)}"` +
      `${set ? ` srcset="${escapeAttr(set)}" sizes="170px"` : ''} ` +
      `alt="${escapeAttr(site.author_name)}" ` +
      `width="170" height="170" loading="eager" decoding="async">`,
    );
  }
  out.push(`<h1>${escapeHtml(site.author_name)}</h1>`);
  if (site.tagline) out.push(`<p class="cv__tagline">${escapeHtml(site.tagline)}</p>`);
  out.push('</header>');

  if (site.bio?.trim()) {
    out.push(`<div class="prose cv__bio">${normalizeAssetUrls(renderMarkdown(site.bio))}</div>`);
  }

  // Botón de impresión: un CV acaba en papel o en PDF más veces de las que
  // parece, y la hoja de estilos ya está preparada para ello. Sin JavaScript,
  // el botón simplemente no se muestra (ver .cv__print).
  out.push(
    '<p class="cv__print"><button type="button" onclick="window.print()">' +
    'Imprimir o guardar en PDF</button></p>',
  );

  // --- datos de contacto y perfiles ---
  // El correo se añade delante: es lo primero que se busca en un CV.
  const contacts = [
    ...(site.author_email
      ? [{ label: 'Email', icon: 'email', url: `mailto:${site.author_email}` }]
      : []),
    ...links.filter((l) => l.url),
  ];
  if (contacts.length) {
    out.push('<nav class="cv__links" aria-label="Contacto y perfiles">');
    for (const l of contacts) {
      const label = socialLabel(l);
      out.push(
        `<a class="cv__link" href="${escapeAttr(l.url)}"` +
        `${/^https?:/.test(l.url) ? ' rel="me noopener"' : ''}>${escapeHtml(label)}</a>`,
      );
    }
    out.push('</nav>');
  }

  // --- experiencia ---
  if (cv.experience.length) {
    out.push('<section class="cv__section">');
    out.push('<h2>Experiencia</h2>');
    for (const e of cv.experience) {
      const range = `${monthLabel(e.started_at)} — ${e.ended_at ? monthLabel(e.ended_at) : 'actualidad'}`;
      out.push('<article class="cv__item">');
      out.push('<div class="cv__itemHead">');
      out.push(`<h3>${escapeHtml(e.role)}${e.company ? ` · <span class="cv__org">${escapeHtml(e.company)}</span>` : ''}</h3>`);
      out.push(`<p class="cv__when">${escapeHtml(range)}${e.location ? ` · ${escapeHtml(e.location)}` : ''}</p>`);
      out.push('</div>');
      if (e.summary) out.push(`<p>${escapeHtml(e.summary)}</p>`);
      const highlights = String(e.highlights || '').split('\n').filter(Boolean);
      if (highlights.length) {
        out.push(`<ul>${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`);
      }
      if (e.stack) out.push(`<p class="cv__stack">${stackChips(e.stack)}</p>`);
      out.push('</article>');
    }
    out.push('</section>');
  }

  // --- formación ---
  if (cv.education.length) {
    out.push('<section class="cv__section">');
    out.push('<h2>Formación</h2>');
    for (const e of cv.education) {
      const when = [monthLabel(e.started_at), e.ended_at ? monthLabel(e.ended_at) : null]
        .filter(Boolean)
        .join(' — ');
      out.push('<article class="cv__item">');
      out.push('<div class="cv__itemHead">');
      out.push(`<h3>${escapeHtml(e.title)}</h3>`);
      out.push(
        `<p class="cv__when">${escapeHtml(e.institution || '')}` +
        `${when ? ` · ${escapeHtml(when)}` : ''}` +
        `${e.grade ? ` · ${escapeHtml(e.grade)}` : ''}</p>`,
      );
      out.push('</div>');
      if (e.summary) out.push(`<p>${escapeHtml(e.summary)}</p>`);
      out.push('</article>');
    }
    out.push('</section>');
  }

  // --- tecnologías, agrupadas por área ---
  if (cv.skills.length) {
    const byArea = new Map();
    for (const s of cv.skills) {
      if (!byArea.has(s.area)) byArea.set(s.area, []);
      byArea.get(s.area).push(s);
    }
    out.push('<section class="cv__section">');
    out.push('<h2>Tecnologías</h2>');
    out.push('<div class="cv__skills">');
    for (const [area, items] of byArea) {
      out.push('<div class="cv__skillArea">');
      out.push(`<h3>${escapeHtml(area)}</h3>`);
      out.push(`<p>${items.map((s) => `<span class="chip">${escapeHtml(s.name)}</span>`).join(' ')}</p>`);
      out.push('</div>');
    }
    out.push('</div>');
    out.push('</section>');
  }

  // --- proyectos ---
  if (cv.projects.length) {
    out.push('<section class="cv__section">');
    out.push('<h2>Proyectos</h2>');
    out.push('<div class="cards cards--projects">');
    for (const p of cv.projects) {
      const href = p.demo || p.url;
      const inner = [
        '<div class="card__body">',
        `<h3 class="card__title">${escapeHtml(p.name)}</h3>`,
        p.tagline ? `<p class="card__summary">${escapeHtml(p.tagline)}</p>` : '',
        p.description ? `<p class="card__summary">${escapeHtml(p.description)}</p>` : '',
        p.stack ? `<p class="cv__stack">${stackChips(p.stack)}</p>` : '',
        p.demo ? `<p class="card__meta"><a href="${escapeAttr(p.demo)}">Ver en vivo</a></p>` : '',
        '</div>',
      ].filter(Boolean).join('');
      out.push(
        href
          ? `<article class="card"><a class="card__link" href="${escapeAttr(href)}"${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${inner}</a></article>`
          : `<article class="card">${inner}</article>`,
      );
    }
    out.push('</div>');
    out.push('</section>');
  }

  return out.join('\n');
}

/**
 * Nombre visible de un enlace de contacto.
 * El `icon` de la base de datos es una clave estable en minúsculas, no un
 * nombre para mostrar; aquí se traduce a algo presentable.
 */
function socialLabel(link) {
  const KNOWN = {
    github: 'GitHub', twitter: 'Twitter', x: 'X', facebook: 'Facebook',
    linkedin: 'LinkedIn', codepen: 'CodePen', youtube: 'YouTube',
    instagram: 'Instagram', mastodon: 'Mastodon', bluesky: 'Bluesky',
    email: 'Email', mail: 'Email', web: 'Web', proyecto: 'Proyecto',
    stackoverflow: 'Stack Overflow',
  };
  const key = String(link.icon || link.label || '').toLowerCase();
  if (KNOWN[key]) return KNOWN[key];
  // Si no lo conocemos, se usa la etiqueta tal cual o el dominio del enlace.
  if (link.label && link.label !== key) return link.label;
  try {
    return new URL(link.url).hostname.replace(/^www\./, '');
  } catch {
    return link.label || key;
  }
}

/** `2020-03-01` -> `mar 2020`. */
function monthLabel(value) {  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `TypeScript, Vue` -> etiquetas. */
function stackChips(stack) {
  return String(stack)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `<span class="chip chip--tag">${escapeHtml(s)}</span>`)
    .join(' ');
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
    ? `<img class="hero" src="${escapeAttr(entry.featuredUrl)}"` +
      `${entry.featuredSrcset ? ` srcset="${escapeAttr(entry.featuredSrcset)}" sizes="(max-width: 900px) 100vw, 42rem"` : ''}` +
      ` alt="${escapeAttr(entry.featured.alt || '')}" width="${entry.featured.width || ''}" height="${entry.featured.height || ''}" loading="eager" decoding="async">`
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
