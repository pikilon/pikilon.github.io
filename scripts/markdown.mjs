/**
 * markdown.mjs — Renderizador de Markdown, sin dependencias.
 *
 * Implementa el subconjunto que este sitio necesita: encabezados, párrafos,
 * listas, citas, bloques y código en línea, énfasis, enlaces, imágenes y
 * tablas. Sobre HTML: los bloques que empiezan por `<` (por ejemplo los
 * <figure> con iframes de CodePen que deja la conversión) se emiten tal cual,
 * porque son contenido de confianza: viene del propio archivo del sitio.
 *
 * Estrategia: se parte el texto en bloques, se renderiza cada uno y se
 * aplica el marcado en línea sobre el texto, no sobre el HTML, para no
 * romper las etiquetas.
 */

/* ------------------------------------------------------------------- bloques */

/**
 * Convierte Markdown en HTML.
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md = '') {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Línea en blanco
    if (!line.trim()) {
      i++;
      continue;
    }

    // Bloque de HTML crudo: se copia hasta cerrar la etiqueta de nivel superior.
    // Sólo para etiquetas de BLOQUE (figuras, iframes, tablas…). Las listas y
    // los párrafos NO entran aquí: los procesa el parser de Markdown, que sabe
    // agrupar varios <li> en una sola lista en vez de una lista por elemento.
    if (/^\s*<\/?(?:figure|iframe|table|div|pre|video|audio|svg|details|section|aside|dl|blockquote)\b/i.test(line)) {
      const [html, next] = readHtmlBlock(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // Encabezado
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Regla horizontal
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Cita
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>\n${renderMarkdown(buf.join('\n')).trim()}\n</blockquote>`);
      continue;
    }

    // Bloque de código con vallas ```
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // cierra la valla
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Lista (con viñetas o numerada). Incluye el caso de los <li> que deja la
    // conversión desde HTML: sus <ul>/<ol> de apertura y cierre se ignoran
    // porque el propio parser construye el envoltorio correcto.
    //
    // Se admiten líneas en blanco *entre* elementos: WordPress genera un
    // párrafo por viñeta, y sin esto cada elemento sería una lista distinta.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line) || /^\s*<li\b/i.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];

        if (/^\s*<\/?[uo]l\b[^>]*>\s*$/i.test(cur)) {
          i++; // etiqueta de envoltorio sobrante
          continue;
        }
        if (!cur.trim()) {
          // Línea en blanco: sólo se salta si el siguiente elemento sigue la lista.
          const next = lines[i + 1];
          if (next !== undefined && (/^\s*([-*+]|\d+\.)\s+/.test(next) || /^\s*<li\b/i.test(next))) {
            i++;
            continue;
          }
          break;
        }
        const isItem = /^\s*([-*+]|\d+\.)\s+/.test(cur) || /^\s*<li\b/i.test(cur);
        if (!isItem) break;

        let text = cur.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/^\s*<li\b[^>]*>/i, '');
        i++;
        // Líneas de continuación de un elemento (sangradas).
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          text += ` ${lines[i].trim()}`;
          i++;
        }
        items.push(text.replace(/<\/li>\s*$/i, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.map((t) => `  <li>${inline(t)}</li>`).join('\n')}\n</${tag}>`);
      continue;
    }

    // Tabla
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const [table, next] = readTable(lines, i);
      out.push(table);
      i = next;
      continue;
    }

    // Párrafo: líneas consecutivas hasta una línea en blanco.
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*<li\b/i.test(lines[i]) &&
      !/^\s*\|/.test(lines[i]) &&
      !/^\s*<\/?[uo]l\b/i.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join('\n'))}</p>`);
  }

  return out.join('\n') + '\n';
}

/**
 * Copia un bloque HTML completo.
 * Se apoya en el recuento de etiquetas para saber dónde termina, así un
 * <figure> con un <iframe> dentro se trata como una sola unidad.
 */
function readHtmlBlock(lines, start) {
  const buf = [];
  let depth = 0;
  let i = start;

  for (; i < lines.length; i++) {
    const line = lines[i];
    // Fin del bloque: línea vacía estando ya cerrado todo.
    if (!line.trim() && depth <= 0 && buf.length) break;

    buf.push(line);
    for (const m of line.matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*?(\/?)>/gi)) {
      const [, closing, _tag, selfClose] = m;
      if (selfClose || /^(br|img|hr|input|meta|link|source)$/i.test(_tag)) continue;
      depth += closing ? -1 : 1;
    }
    if (depth <= 0) {
      i++;
      break;
    }
  }
  return [buf.join('\n').trim(), i];
}

/** Lee una tabla de Markdown y devuelve su HTML. */
function readTable(lines, start) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());

  const head = cells(lines[start]);
  const align = cells(lines[start + 1]).map((c) => {
    if (/^:-+:$/.test(c)) return 'center';
    if (/^:-+/.test(c)) return 'left';
    if (/-+:$/.test(c)) return 'right';
    return '';
  });

  let i = start + 2;
  const body = [];
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    body.push(cells(lines[i]));
    i++;
  }

  const attr = (n) => (align[n] ? ` style="text-align:${align[n]}"` : '');
  const html = `<table>
<thead><tr>${head.map((c, n) => `<th${attr(n)}>${inline(c)}</th>`).join('')}</tr></thead>
<tbody>
${body.map((r) => `<tr>${r.map((c, n) => `<td${attr(n)}>${inline(c)}</td>`).join('')}</tr>`).join('\n')}
</tbody>
</table>`;
  return [html, i];
}

/* -------------------------------------------------------------- en línea */

/**
 * Aplica el marcado en línea: código, imágenes, enlaces y énfasis.
 * Se protegen primero los fragmentos ya resueltos con marcadores para que
 * el énfasis no se cuele dentro de una URL ni de un atributo.
 *
 * @param {string} text
 * @returns {string}
 */
export function inline(text = '') {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let s = String(text);

  // El HTML en línea que venga del original se conserva (em, strong, a, code,
  // span, br). WordPress generaba contenido mixto, así que hay que respetarlo.
  s = s.replace(/<\/?(?:em|strong|b|i|code|span|br|sub|sup|small|mark|abbr|kbd|s|del|ins)\b[^>]*>/gi, (m) => keep(m));
  // Igual con las etiquetas que sobrevivan de imágenes o enlaces sueltos.
  s = s.replace(/<(?:img|a)\b[^>]*>/gi, (m) => keep(m));

  // Escapa lo que quede, que es texto de verdad.
  s = escapeHtml(s);

  // Código en línea (antes que el énfasis, para que `**` no se interprete).
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

  // Imágenes: ![alt](src "title")
  s = s.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, (_, alt, src, title) =>
    keep(`<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''} loading="lazy" decoding="async">`),
  );

  // Enlaces: [texto](url "title")
  s = s.replace(/\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, (_, label, href, title) => {
    const external = /^https?:\/\//i.test(href) && !/^https?:\/\/(www\.)?pikilon\.com/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''}${attrs}>${label}</a>`;
  });

  // Énfasis. El orden importa: primero ** y luego *.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

  // Saltos de línea sueltos dentro de un párrafo -> <br>
  s = s.replace(/\n/g, '<br>\n');

  // Restituye los fragmentos protegidos.
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)]);
}

/* ------------------------------------------------------------- escapado */

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
