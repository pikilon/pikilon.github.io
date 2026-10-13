#!/usr/bin/env node
/**
 * test.mjs — Pruebas del sitio. No hay framework: Node trae un ejecutor.
 *
 * Cubre las piezas donde un fallo silencioso se convertiría en contenido roto
 * o, peor, en un proceso colgado:
 *
 *   - el parser de Markdown (listas, énfasis, código, tablas, HTML crudo);
 *   - el conversor de HTML de WordPress a Markdown;
 *   - el analizador de la cabecera de los archivos de contenido;
 *   - los slugs de las URLs.
 *
 * Uso:
 *   node scripts/test.mjs            # todas las pruebas
 *   node scripts/test.mjs --verbose  # muestra cada comprobación
 *
 * Sale con código 1 si algo falla, así que se puede encadenar en `publish`.
 */

import { renderMarkdown, inline, escapeHtml } from './markdown.mjs';
import { htmlToMarkdown, expandShortcodes, htmlToText, stripSizeSuffix } from './html-to-md.mjs';
import { parseFrontmatter, slugify as slugifyPublish } from './publish.mjs';
import { slugify, toIsoUtc, iconFor } from './utils.mjs';

const VERBOSE = process.argv.includes('--verbose');
let passed = 0;
const failures = [];

/** Comprueba una condición y agrupa el resultado. */
function check(name, condition, detail) {
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ok   ${name}`);
  } else {
    failures.push(detail ? `${name}\n        ${detail}` : name);
    console.log(`  FALLA ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const group = (title) => console.log(`\n${title}`);

/* ------------------------------------------------------------- markdown */

group('Markdown');

check('encabezados de los seis niveles',
  [1, 2, 3, 4, 5, 6].every((n) => renderMarkdown(`${'#'.repeat(n)} T`).includes(`<h${n}>T</h${n}>`)));

check('negrita, cursiva y código en línea',
  renderMarkdown('a **b** _c_ `d`').includes('<strong>b</strong>') &&
  renderMarkdown('a **b** _c_ `d`').includes('<em>c</em>') &&
  renderMarkdown('a **b** _c_ `d`').includes('<code>d</code>'));

check('los enlaces externos llevan rel de seguridad',
  renderMarkdown('[x](https://otro.com)').includes('rel="noopener noreferrer"'));

check('los enlaces internos no lo llevan',
  !renderMarkdown('[x](/writing/)').includes('rel="noopener'));

check('el HTML se escapa en el texto',
  renderMarkdown('a < b & c').includes('a &lt; b &amp; c'));

check('el código en bloques se escapa pero no se interpreta',
  renderMarkdown('```js\nconst a = 1 < 2;\n```').includes('1 &lt; 2'));

check('el bloque de código declara su lenguaje',
  renderMarkdown('```php\necho 1;\n```').includes('class="language-php"'));

// Listas: la parte que más se rompió durante la migración.
const ulYOl = renderMarkdown('- uno\n- dos\n\n1. primera\n2. segunda\n');
check('una lista con viñetas y otra numerada no se mezclan',
  (ulYOl.match(/<ul>/g) || []).length === 1 && (ulYOl.match(/<ol>/g) || []).length === 1,
  ulYOl);

check('las líneas en blanco entre elementos no parten la lista',
  (renderMarkdown('- a\n\n- b\n\n- c\n').match(/<ul>/g) || []).length === 1);

const html4 = renderMarkdown('<ul>\n<li>a</li>\n</ul>\n\n<ul>\n<li>b</li>\n</ul>\n');
check('los <ul> sueltos del conversor se funden en una lista',
  (html4.match(/<ul>/g) || []).length === 1 && (html4.match(/<li>/g) || []).length === 2,
  html4);

check('un <ul> suelto sin <li> no cuelga el parser',
  renderMarkdown('<ul>\n</ul>\n').trim() === '');

check('lista, párrafo y lista siguen siendo tres bloques',
  (renderMarkdown('- a\n- b\n\nTexto.\n\n<ul>\n<li>c</li>\n</ul>\n').match(/<ul>/g) || []).length === 2);

check('las tablas se renderizan con alineación',
  /<th style="text-align:right">/.test(renderMarkdown('| A | B |\n|---|--:|\n| 1 | 2 |')));

check('las citas se convierten en blockquote',
  renderMarkdown('> una cita').includes('<blockquote>'));

check('las figuras con iframe se conservan como HTML',
  renderMarkdown('<figure class="embed"><iframe src="x"></iframe></figure>').includes('<iframe'));

check('las imágenes llevan carga diferida',
  renderMarkdown('![a](/x.png)').includes('loading="lazy"'));

check('un párrafo nunca envuelve a otro',
  !renderMarkdown('uno\n\ndos').includes('<p><p>'));

/* --------------------------------------------------- HTML de WordPress */

group('Conversión desde HTML de WordPress');

check('las entidades se decodifican',
  htmlToMarkdown('<p>caf&#233; y &#8220;comillas&#8221;</p>').includes('café y “comillas”'));

check('los párrafos vacíos desaparecen',
  htmlToMarkdown('<p>a</p><p>&nbsp;</p><p>b</p>').trim() === 'a\n\nb');

check('las comillas tipográficas de los cortocircuitos se entienden',
  expandShortcodes('[codepen_embed slug_hash=&#8221;abc&#8243; user=&#8221;pikilon&#8221;]T[/codepen_embed]')
    .includes('codepen.io/pikilon/pen/abc'));

check('el nombre del cortocircuito no se cuela en el título',
  !expandShortcodes('[codepen_embed slug_hash="a" user="u"]See the Pen <a href=\'x\'>Título</a> by U[/codepen_embed]')
    .includes('&amp;lt;'));

check('los gists se enlazan',
  expandShortcodes('[gist id="abc123"]').includes('gist.github.com/abc123'));

check('[email] se convierte en mailto',
  expandShortcodes('[email]a@b.com[/email]').includes('mailto:a@b.com'));

check('las imágenes de la biblioteca se resuelven por id',
  expandShortcodes('[lazy_responsive_img ids="7"]', new Map([[7, '/assets/x.png']])).includes('/assets/x.png'));

check('un cortocircuito desconocido no se toca',
  expandShortcodes('[create a new project]').includes('[create a new project]'));

check('las variantes de tamaño se reducen al original',
  stripSizeSuffix('foto-512x512.jpg') === 'foto.jpg' &&
  stripSizeSuffix('foto.jpg') === 'foto.jpg');

check('el texto plano pierde las etiquetas',
  htmlToText('<p>Hola <strong>mundo</strong></p>') === 'Hola mundo');

/* ------------------------------------------------------ cabecera y slugs */

group('Cabecera y URLs');

const fm = parseFrontmatter('---\ntitle: Hola\nslug: hola-mundo\ntags: [a, b]\nstatus: draft\n---\n\nCuerpo.');
check('la cabecera se separa del cuerpo', fm.data.title === 'Hola' && fm.body === 'Cuerpo.');
check('las listas en línea se parsean', Array.isArray(fm.data.tags) && fm.data.tags.length === 2);
check('el estado se lee', fm.data.status === 'draft');

check('las comillas de la cabecera se quitan',
  parseFrontmatter('---\ntitle: "Con comillas"\n---\nx').data.title === 'Con comillas');

check('un archivo sin cabecera no rompe',
  parseFrontmatter('Sólo texto').data.title === undefined);

check('los slugs pierden acentos y signos',
  slugify('Rem + em, ¿una historia?') === 'rem-em-una-historia',
  slugify('Rem + em, ¿una historia?'));

check('los slugs no dejan guiones sueltos',
  slugify('  --Hola--  ') === 'hola');

check('las fechas se normalizan a ISO UTC',
  toIsoUtc('2020-03') === '2020-03-01T12:00:00Z' && toIsoUtc('2020-03-15') === '2020-03-15T12:00:00Z');

check('una fecha inválida devuelve null', toIsoUtc('no es fecha') === null);

check('los iconos se deducen del dominio',
  iconFor('https://github.com/x') === 'github' &&
  iconFor('mailto:a@b.com') === 'email' &&
  iconFor('https://desconocido.tld') === 'web');

/* -------------------------------------------------------------------- */

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`${failures.length} prueba(s) fallidas de ${passed + failures.length}:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} pruebas correctas.`);
