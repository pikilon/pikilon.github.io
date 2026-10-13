/**
 * templates.mjs — Plantillas HTML y formato compartido.
 *
 * Un sitio de una sola columna, tipografía del sistema y estilos en línea en
 * un único <style>: cero peticiones externas, cero cambios de diseño por una
 * dependencia que cambie. El objetivo es que el contenido mande.
 */

import { escapeAttr, escapeHtml } from './markdown.mjs';

export { escapeAttr, escapeHtml };

/** Fechas legibles y estables: "14 dic 2015". */
const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
};

export function formatDate(iso, lang = 'en') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const months = MONTHS[lang] || MONTHS.en;
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ------------------------------------------------------------ navegación */

function nav(site, current) {
  const items = [
    ['', 'CV'],
    ['writing/', 'Writing'],
    ['topics/', 'Temas'],
  ];
  return items
    .map(([href, label]) => {
      const key = href.replace('/', '') || 'home';
      const active = current === key ? ' aria-current="page"' : '';
      return `<a href="/${href}"${active}>${escapeHtml(label)}</a>`;
    })
    .join('\n      ');
}

/* --------------------------------------------------------------- plantilla */

/**
 * Envuelve el contenido en el documento HTML completo.
 *
 * @param {object} o
 * @param {object} o.site       fila de la tabla site
 * @param {string} o.title      título de la página (sin el sufijo del sitio)
 * @param {string} o.content    HTML del cuerpo
 * @param {string} o.url        ruta canónica, p. ej. "/code/foo/"
 * @param {string} [o.description]
 * @param {string} [o.nav]      clave de la sección activa
 * @param {string} [o.ogType]
 * @param {string} [o.publishedAt]
 * @param {string} [o.updatedAt]
 * @param {string} [o.featured] URL de la imagen social (ya normalizada)
 */
export function layout({
  site,
  title,
  content,
  url = '/',
  description = '',
  nav: current = '',
  ogType = 'website',
  publishedAt,
  updatedAt,
  featured,
}) {
  const fullTitle = url === '/' ? `${site.title} — ${site.tagline || 'CV'}` : `${title} · ${site.title}`;
  const desc = (description || site.description || '').replace(/\s+/g, ' ').slice(0, 300);
  const canonical = `${site.url}${url}`;
  const ogImage = featured ? `${site.url}${String(featured).startsWith('/') ? '' : '/'}${featured}` : '';

  return `<!DOCTYPE html>
<html lang="${escapeAttr(site.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
${desc ? `<meta name="description" content="${escapeAttr(desc)}">` : ''}
<link rel="canonical" href="${escapeAttr(canonical)}">
<meta property="og:type" content="${escapeAttr(ogType)}">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:url" content="${escapeAttr(canonical)}">
${desc ? `<meta property="og:description" content="${escapeAttr(desc)}">` : ''}
${ogImage ? `<meta property="og:image" content="${escapeAttr(ogImage)}">` : ''}
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
${publishedAt ? `<meta property="article:published_time" content="${escapeAttr(publishedAt)}">` : ''}
${updatedAt ? `<meta property="article:modified_time" content="${escapeAttr(updatedAt)}">` : ''}
<link rel="alternate" type="application/rss+xml" title="${escapeAttr(site.title)}" href="/feed.xml">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Saltar al contenido</a>
<header class="topbar">
  <a class="brand" href="/">${escapeHtml(site.author_name || site.title)}</a>
  <nav class="topnav">
      ${nav(site, current)}
  </nav>
</header>
<main id="main">
${content}
</main>
<footer class="sitefoot">
  <p>© ${new Date().getUTCFullYear()} ${escapeHtml(site.author_name || site.title)}${site.author_email ? ` · <a href="mailto:${escapeAttr(site.author_email)}">${escapeHtml(site.author_email)}</a>` : ''}</p>
  <p class="sitefoot__meta"><a href="/feed.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a></p>
</footer>
</body>
</html>
`;
}

/* ----------------------------------------------------------------- tarjeta */

/** Tarjeta de un artículo para los listados. */
export function card({ entry, site, showCategory = false }) {
  const cat = showCategory && entry.primaryCategory
    ? `<span class="chip chip--cat">${escapeHtml(entry.primaryCategory.name)}</span>`
    : '';
  const thumb = entry.featuredUrl
    ? `<img class="card__thumb" src="${escapeAttr(entry.featuredUrl)}" alt="" width="${entry.featured?.width || ''}" height="${entry.featured?.height || ''}" loading="lazy" decoding="async">`
    : '';

  return `<article class="card">
  <a class="card__link" href="${escapeAttr(entry.url)}">
    ${thumb}
    <div class="card__body">
      <h3 class="card__title">${escapeHtml(entry.title)}</h3>
      ${entry.summary ? `<p class="card__summary">${escapeHtml(entry.summary.slice(0, 180))}</p>` : ''}
      <p class="card__meta">${entry.published_at ? `<time datetime="${escapeAttr(entry.published_at)}">${formatDate(entry.published_at, site.lang)}</time>` : ''}${cat}</p>
    </div>
  </a>
</article>`;
}

/* ------------------------------------------------------------------ estilos */

const STYLES = `
:root{
  --bg:#fbfbfa; --fg:#16181d; --muted:#6b7280; --line:#e5e5e2;
  --accent:#1f6feb; --accent-soft:#eaf1fd; --card:#ffffff;
  --code-bg:#f4f4f2; --max:42rem; --wide:60rem;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#101216; --fg:#e8e8e6; --muted:#9aa0a6; --line:#282c33;
    --accent:#6ea8fe; --accent-soft:#1a2433; --card:#161a20; --code-bg:#1b1f26;
  }
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-kerning:normal;
}
.skip{position:absolute;left:-9999px}
.skip:focus{left:1rem;top:1rem;z-index:9;background:var(--card);padding:.5rem .75rem;border-radius:.4rem}
a{color:var(--accent);text-decoration-thickness:.06em;text-underline-offset:.15em}
a:hover{text-decoration-thickness:.14em}
img{max-width:100%;height:auto}

/* barra superior */
.topbar{
  display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;justify-content:space-between;
  max-width:var(--wide);margin:0 auto;padding:1.5rem 1.25rem .75rem;
}
.brand{font-weight:700;letter-spacing:-.01em;color:var(--fg);text-decoration:none}
.topnav{display:flex;gap:1rem;font-size:.94rem}
.topnav a{color:var(--muted);text-decoration:none;padding-bottom:.15rem;border-bottom:2px solid transparent}
.topnav a:hover{color:var(--fg)}
.topnav a[aria-current]{color:var(--fg);border-bottom-color:var(--accent)}

main{max-width:var(--wide);margin:0 auto;padding:1rem 1.25rem 3rem}
main > h1{letter-spacing:-.02em;line-height:1.2;margin:.5rem 0 .25rem}
.lead{color:var(--muted);font-size:1.05rem;margin:.25rem 0 2rem}

/* contenido */
.prose,main > p,main > ul,main > ol,main > h1,main > h2,main > h3,main > blockquote,main > figure,main > table{
  max-width:var(--max);
}
.prose{max-width:var(--max)}
.prose h2,.prose h3,.prose h4{letter-spacing:-.01em;line-height:1.25;margin:2.2rem 0 .6rem}
.prose h2{font-size:1.4rem}
.prose h3{font-size:1.15rem}
.prose p{margin:0 0 1.1rem}
.prose ul,.prose ol{margin:0 0 1.1rem;padding-left:1.4rem}
.prose li{margin:.25rem 0}
.prose img{border-radius:.5rem;margin:.5rem 0}
.prose blockquote{
  margin:1.5rem 0;padding:.2rem 0 .2rem 1rem;border-left:3px solid var(--line);color:var(--muted)
}
.prose blockquote p:last-child{margin-bottom:0}
.prose code{
  background:var(--code-bg);padding:.15em .4em;border-radius:.3rem;
  font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.prose pre{
  background:var(--code-bg);border:1px solid var(--line);border-radius:.55rem;
  padding:1rem;overflow-x:auto;margin:1.5rem 0;
}
.prose pre code{background:none;padding:0;font-size:.86rem;line-height:1.55}
.prose table{border-collapse:collapse;width:100%;margin:1.5rem 0;font-size:.95rem}
.prose th,.prose td{border:1px solid var(--line);padding:.5rem .65rem;text-align:left}
.prose hr{border:none;border-top:1px solid var(--line);margin:2.5rem 0}
.prose figure{margin:1.75rem 0}
.prose figcaption{color:var(--muted);font-size:.9rem;text-align:center;margin-top:.5rem}
.prose iframe{
  width:100%;border:1px solid var(--line);border-radius:.55rem;background:var(--card);display:block
}
.wp-caption img{border-radius:.5rem}

/* portada */
#profile_photo img,.portrait{
  border-radius:50%;width:170px;height:170px;object-fit:cover;
  border:1px solid var(--line);margin:0 0 1.25rem
}
#profile_photo p{margin:0}

/* tarjetas */
.cards{
  display:grid;gap:1rem;margin:2.5rem 0 0;
  grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));
}
.card{
  background:var(--card);border:1px solid var(--line);border-radius:.7rem;overflow:hidden;
  transition:border-color .15s,transform .15s;
}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card__link{display:block;color:inherit;text-decoration:none;height:100%}
.card__thumb{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;border-bottom:1px solid var(--line)}
.card__body{padding:.9rem 1rem 1rem}
.card__title{margin:0 0 .35rem;font-size:1.02rem;line-height:1.35;letter-spacing:-.01em}
.card__summary{margin:0 0 .6rem;color:var(--muted);font-size:.92rem;line-height:1.5}
.card__meta{margin:0;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;color:var(--muted);font-size:.82rem}

.chip{
  display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.78rem;
  background:var(--accent-soft);color:var(--accent);text-decoration:none;white-space:nowrap
}
.chip--tag{background:transparent;border:1px solid var(--line);color:var(--muted)}

/* artículo */
.entry__header{margin-bottom:1.5rem;max-width:var(--max)}
.entry__header h1{letter-spacing:-.025em;line-height:1.15;margin:.5rem 0 .5rem;font-size:clamp(1.6rem,4vw,2.1rem)}
.entry__meta{margin:0 0 .75rem;color:var(--muted);font-size:.9rem}
.entry__terms{display:flex;flex-wrap:wrap;gap:.4rem;margin:0}
.entry__footer{margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid var(--line);max-width:var(--max)}
.hero{width:100%;max-width:var(--max);border-radius:.6rem;margin:.5rem 0 1.75rem;border:1px solid var(--line)}
.related{margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--line);max-width:var(--max)}
.related h2{font-size:1.05rem;margin:0 0 .6rem}
.related ul{margin:0;padding-left:1.2rem}

/* temas */
.topic-list{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.6rem;max-width:var(--max)}
.topic-list li{
  display:flex;gap:.5rem;align-items:baseline;background:var(--card);
  border:1px solid var(--line);border-radius:.5rem;padding:.4rem .7rem
}
.topic-list a{text-decoration:none}
.count{color:var(--muted);font-size:.82rem}
.tagmark{color:var(--muted);font-weight:400}

/* pie */
.sitefoot{
  max-width:var(--wide);margin:0 auto;padding:2rem 1.25rem 3rem;
  border-top:1px solid var(--line);color:var(--muted);font-size:.88rem
}
.sitefoot p{margin:.2rem 0}
`;
