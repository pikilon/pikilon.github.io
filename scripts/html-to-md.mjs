/**
 * html-to-md.mjs — Convierte el HTML de WordPress en Markdown limpio.
 *
 * WordPress guarda el contenido ya renderizado con un subconjunto pequeño y
 * predecible de HTML. Este módulo lo traduce a Markdown en lugar de arrastrar
 * el HTML para siempre: el Markdown es el formato que vas a editar a mano en
 * el nuevo sitio, así que la conversión tiene que ser fiel y legible.
 *
 * Además resuelve los shortcodes que usaba el WordPress original:
 *   [codepen_embed ...]            -> figura con <iframe> de CodePen
 *   [gist id="..."]                -> figura con el gist enlazado
 *   [lazy_responsive_img ids="N"]  -> imagen de la biblioteca (por id de WP)
 *   [email]...[/email]             -> enlace mailto
 *
 * Sin dependencias externas: un tokenizador propio basta para este HTML.
 *
 * ORDEN DE LAS FASES (importante): el marcado en línea se resuelve *de abajo
 * arriba* mientras el HTML sigue siendo HTML. Sólo al final se decodifican las
 * entidades y se quitan las etiquetas que sobren. Hacerlo al revés corrompe
 * los bloques que se conservan en HTML, como los <iframe>.
 */

/* ------------------------------------------------------------- entidades */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', times: '×', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', bull: '•', middot: '·',
};

/** Decodifica entidades HTML, incluidas las numéricas. */
export function decodeEntities(str = '') {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const safeChar = (code) => {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
};

/* ------------------------------------------------------- shortcodes → HTML */

/**
 * Traduce los shortcodes del WordPress original a HTML equivalente.
 * Se ejecuta ANTES del parseo, cuando el contenido todavía es HTML crudo.
 *
 * @param {string} html  contenido renderizado de WordPress
 * @param {Map<number,string>} mediaById  id WP -> ruta relativa de la imagen
 */
export function expandShortcodes(html, mediaById = new Map()) {
  let out = String(html || '');

  // [codepen_embed height="265" theme_id="dark" slug_hash="vKBgJp" ...]
  // El texto entre la etiqueta de apertura y la de cierre es el fallback que
  // genera CodePen; lo descartamos y construimos un iframe limpio.
  out = out.replace(
    /\[codepen_embed([^\]]*)\]([\s\S]*?)\[\/codepen_embed\]/g,
    (_, attrs, caption) => {
      const a = parseAttrs(attrs);
      if (!a.slug_hash || !a.user) return '';
      const tab = a.default_tab ? `?default-tab=${encodeURIComponent(a.default_tab)}` : '';
      const height = digits(a.height) || '300';
      const title = cleanCaption(caption) || `CodePen de ${a.user}`;
      const url = `https://codepen.io/${esc(a.user)}/pen/${esc(a.slug_hash)}`;
      return (
        `<figure class="embed embed--codepen">` +
        `<iframe src="${url}${esc(tab)}" title="${esc(title)}" loading="lazy" ` +
        `height="${height}" allowfullscreen></iframe>` +
        `<figcaption>${esc(title)} — <a href="${url}">ver en CodePen</a></figcaption>` +
        `</figure>`
      );
    },
  );

  // [gist id="e6f8a1f1397efa9019de"] — sólo tenemos el id, así que enlazamos.
  out = out.replace(/\[gist([^\]]*)\]/g, (_, attrs) => {
    const id = parseAttrs(attrs).id;
    if (!id) return '';
    const url = `https://gist.github.com/${esc(id)}`;
    return (
      `<figure class="embed embed--gist">` +
      `<a href="${url}">Gist ${esc(id)}</a>` +
      `<figcaption>Código completo en <a href="${url}">GitHub Gist</a></figcaption>` +
      `</figure>`
    );
  });

  // [lazy_responsive_img ids="172"] — imagen de la biblioteca por id de WP.
  out = out.replace(/\[lazy_responsive_img([^\]]*)\]/g, (_, attrs) => {
    const id = Number(String(parseAttrs(attrs).ids || '').split(',')[0]);
    const path = mediaById.get(id);
    if (!path) return '';
    return `<figure class="wp-caption"><img src="${esc(path)}" alt=""></figure>`;
  });

  // [email]algo@dominio.com[/email] -> enlace mailto
  out = out.replace(/\[email\]([\s\S]*?)\[\/email\]/g, (_, addr) => {
    const clean = decodeEntities(String(addr)).trim();
    return `<a href="mailto:${esc(clean)}">${esc(clean)}</a>`;
  });

  return out;
}

/**
 * Convierte `height="265"` en un objeto.
 *
 * Hay que decodificar las entidades ANTES de buscar los atributos: WordPress
 * guarda las comillas como entidades y, al sanear el contenido, las normaliza
 * de forma inconsistente, de modo que un cortocircuito acaba con comillas que
 * ni son rectas ni coinciden entre sí. En el contenido real aparece:
 *
 *   slug_hash=&#8221;abc&#8243;   ->   slug_hash=”abc″
 *
 * Es decir, abre con `”` (U+201D, comilla de cierre) y cierra con `″`
 * (U+2033, doble prima). Por eso se acepta como delimitador cualquier
 * carácter tipográfico de cita, sin exigir que la pareja coincida: lo que
 * cierra el valor es la siguiente comilla, sea la que sea.
 */
const QUOTES = '"\u201c\u201d\u2033\u2018\u2019\u201a\u201e\u201f\u00ab\u00bb\'';

export function parseAttrs(str = '') {
  const decoded = decodeEntities(String(str));
  const out = {};
  const quoted = new RegExp(`([a-z_][\\w-]*)\\s*=\\s*[${QUOTES}]([^${QUOTES}]*)[${QUOTES}]`, 'gi');
  for (const m of decoded.matchAll(quoted)) out[m[1].toLowerCase()] = m[2].trim();

  // Atributos sin comillas. Se buscan por separado para no reinterpretar el
  // contenido de un valor ya capturado.
  const bare = new RegExp(`([a-z_][\\w-]*)\\s*=\\s*(?![${QUOTES}])([^\\s${QUOTES}\\]]+)`, 'gi');
  for (const m of decoded.matchAll(bare)) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = m[2].trim();
  }
  return out;
}

/** Del fallback de CodePen sólo queremos el título, sin el HTML enlazado. */
function cleanCaption(html = '') {
  // El fallback que genera CodePen trae las etiquetas *codificadas*
  // (`&lt;a href=…&gt;Título&lt;/a&gt;`), así que hay que decodificar ANTES de
  // quitar etiquetas; al revés no se elimina nada. Se decodifica dos veces
  // porque el contenido ya venía escapado una vez por WordPress.
  const decoded = decodeEntities(decodeEntities(String(html)));
  const text = decodeEntities(decoded.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const m = text.match(/See the Pen\s+(.*?)\s+by\s+/i);
  return m ? m[1].trim() : text.slice(0, 120);
}

const digits = (s = '') => (String(s).match(/\d+/) || [''])[0];

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------ markdown */

/**
 * Convierte el HTML de un artículo de WordPress a Markdown.
 *
 * @param {string} html
 * @param {object} opts
 * @param {Map<string,string>} [opts.imageMap]  URL original -> ruta local
 * @param {string} [opts.prefix]  prefijo para recursos locales ('' por defecto)
 * @returns {string}
 */
export function htmlToMarkdown(html, { imageMap = new Map(), prefix = '' } = {}) {
  if (!html) return '';
  const preserved = [];

  let src = String(html).replace(/\r\n?/g, '\n');

  // ---- Fase 0: apartar los bloques que se conservan como HTML -------------
  // Se sustituyen por un marcador que sobrevive intacto a todas las fases.
  src = src.replace(/<figure\b[^>]*class="[^"]*\bembed\b[^"]*"[\s\S]*?<\/figure>/gi, (m) =>
    stash(preserved, tidyHtml(m)));
  src = src.replace(/<pre\b[\s\S]*?<\/pre>/gi, (m) => stash(preserved, tidyHtml(m)));
  src = src.replace(/<table\b[\s\S]*?<\/table>/gi, (m) => stash(preserved, tidyHtml(m)));

  // ---- Fase 1: normalizar la estructura de bloques ------------------------
  src = src
    // El &nbsp; de WordPress casi siempre hace de espacio normal. Se pasa a
    // espacio de verdad AQUÍ, antes del marcado en línea: si no, la fase de
    // texto lo colapsa y las palabras quedan pegadas.
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer)>/gi, '\n\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, (_, t) => `\n\n<${t}>`)
    .replace(/<\/(h[1-6])>/gi, (_, t) => `</${t}>\n\n`)
    .replace(/<(ul|ol)\b[^>]*>/gi, '\n\n<$1>\n')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n<li>')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n<blockquote>\n')
    .replace(/<\/blockquote>/gi, '\n</blockquote>\n\n')
    // WordPress envuelve <figure> dentro de <p>, lo que produce HTML inválido.
    .replace(/<p\b[^>]*>\s*(<figure|<img|<iframe)/gi, '$1')
    .replace(/(<\/figure>|<\/p>)\s*<\/p>/gi, '$1');

  // ---- Fase 2: marcado en línea, de dentro hacia fuera --------------------
  // Primero las hojas (sin anidar), después las que pueden contenerlas.
  for (let pass = 0; pass < 3; pass++) {
    src = src
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, i) => inlineWrap(i, '`'))
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, i) => inlineWrap(i, '**'))
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, i) => inlineWrap(i, '_'))
      .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, i) => `~${inlineText(i).trim()}~`)
      .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, i) => `^${inlineText(i).trim()}`)
      .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
        const href = attr(`<a${attrs}>`, 'href');
        const text = inlineText(inner).trim();
        if (!href) return text;
        if (!text) return '';
        return `[${text}](${href})`;
      });
    // Los <span> sólo aportan estilo: fuera.
    src = src.replace(/<\/?span\b[^>]*>/gi, '');
  }

  // ---- Fase 3: párrafos sueltos y figuras con pie ------------------------
  src = src
    .replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi, (_, inner) => {
      const t = inlineText(inner).trim();
      return t ? `\n\n_${t}_\n\n` : '';
    })
    .replace(/<\/?figure\b[^>]*>/gi, '\n\n');

  // ---- Fase 4: imágenes ------------------------------------------------
  src = src.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcUrl = attr(tag, 'src');
    if (!srcUrl) return '';
    const alt = attr(tag, 'alt') || '';
    const local =
      imageMap.get(srcUrl) ||
      imageMap.get(stripSizeSuffix(srcUrl)) ||
      (prefix && isLocalAsset(srcUrl) ? prefix + srcUrl.replace(/^https?:\/\/[^/]+\//, '') : srcUrl);
    return `![${escapeMd(alt)}](${local})`;
  });

  // ---- Fase 5: encabezados, listas y citas ------------------------------
  src = src
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
      const text = inlineText(inner).trim();
      return text ? `\n\n${'#'.repeat(Number(lvl))} ${text}\n\n` : '';
    })
    .replace(/<li>([\s\S]*?)(?=<\/?li>|<\/[uo]l>|$)/gi, (_, inner) => {
      const text = inlineText(inner).trim();
      return text ? `\n- ${text}` : '';
    })
    .replace(/<\/?[uo]l\b[^>]*>/gi, '\n\n')
    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
      const body = inlineText(inner)
        .split('\n')
        .map((l) => (l.trim() ? `> ${l.trim()}` : '>'))
        .join('\n');
      return `\n\n${body}\n\n`;
    });

  // ---- Fase 6: limpieza final ------------------------------------------
  // Primero se decodifican entidades y se quitan etiquetas restantes…
  src = decodeEntities(src.replace(/<[^>]+>/g, ''));
  // …y sólo entonces se restituyen los bloques HTML preservados.
  src = src.replace(/\u0000B(\d+)\u0000/g, (_, i) => `\n\n${preserved[Number(i)]}\n\n`);

  return (
    src
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '') + '\n'
  );
}

/** Guarda un bloque preservado y devuelve su marcador. */
const stash = (arr, value) => {
  arr.push(value);
  return `\u0000B${arr.length - 1}\u0000`;
};

/** Texto de un fragmento en línea: decodifica entidades y aplana espacios. */
function inlineText(fragment) {
  return decodeEntities(
    String(fragment)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ');
}

/** Igual que `inlineText` pero envuelto en un marcador de énfasis. */
function inlineWrap(fragment, marker) {
  const t = inlineText(fragment).trim();
  if (!t) return '';
  // Un marcador pegado a un espacio no lo interpreta Markdown.
  const lead = /^\s/.test(inlineText(fragment)) ? ' ' : '';
  return `${lead}${marker}${t}${marker}`;
}

/** Normaliza el HTML preservado (iframe/figura) sin romper sus atributos. */
function tidyHtml(html = '') {
  return String(html)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

const escapeMd = (s = '') => String(s).replace(/([[\]])/g, '\\$1');

/** ¿Es una URL del propio sitio? */
function isLocalAsset(url) {
  return /^https?:\/\/(www\.)?pikilon\.com\//i.test(url);
}

/** Extrae un atributo de una etiqueta HTML. */
function attr(tag, name) {
  const m = String(tag).match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return '';
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
}

/** `foo-512x512.jpg` -> `foo.jpg`, para resolver variantes a su original. */
export function stripSizeSuffix(url = '') {
  return String(url).replace(/-\d+x\d+(\.\w+)$/, '$1');
}

/** Texto plano de un HTML: para extractos y meta descripciones. */
export function htmlToText(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}
