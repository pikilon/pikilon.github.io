# pikilon.com

Sitio personal de **Francisco G. Sarazá** (pikilon). Antes era un WordPress en
Hostinger; ahora es una web estática que se genera desde este mismo
repositorio, sin dependencias externas y sin base de datos remota.

Aquí se publica el CV y lo que voy aprendiendo sobre desarrollo web.

## Cómo funciona

```
archive/     copia íntegra del WordPress original (HTML, JSON y 94 medios)
   |  node scripts/import.mjs
   v
db/pikilon.db   base de datos SQLite simplificada (entradas, medios y CV)
   |  node scripts/site.mjs export
   v
site/        contenido en Markdown; ESTA es la fuente de verdad
   |  node scripts/site.mjs publish
   v
public/      sitio estático generado (HTML + assets) -> GitHub Pages
```

La regla es sencilla: **el contenido se escribe en `site/`, todo lo demás se
genera.** La base de datos es un paso intermedio reproducible, y `archive/`
es la copia de seguridad de lo que había antes.

Hay dos tipos de contenido, cada uno con su comando:

| Qué | Dónde se edita | Comando |
|---|---|---|
| Artículos y páginas | `site/<categoría>/*.md` | `site.mjs publish` |
| El CV (portada) | `site/cv/curriculum.md` | `cv.mjs sync` + `site.mjs build` |

## El CV

El CV **no es un párrafo de texto**: la experiencia, la formación, las
tecnologías y los proyectos son datos estructurados, para poder reordenarlos,
filtrarlos y reutilizarlos (por ejemplo, para generar un PDF más adelante).

Viven en `site/cv/curriculum.md`, un archivo que mezcla prosa escrita a mano
con secciones que se regeneran desde la base de datos:

```markdown
# Francisco G. Sarazá

Aquí va tu presentación: este texto se conserva tal cual.

<!-- cv:contact -->          <- a partir de aquí manda la base de datos
<!-- cv:skills -->
<!-- cv:experience -->
<!-- cv:education -->
<!-- cv:projects -->
```

Ciclo de trabajo:

```bash
node scripts/cv.mjs export    # base de datos -> archivo (para editarlo)
# editar site/cv/curriculum.md
node scripts/cv.mjs sync      # archivo -> base de datos
node scripts/cv.mjs list      # comprobar lo que hay registrado
node scripts/site.mjs build   # regenerar la portada
```

Las secciones sin datos **no se muestran**, así puedes ir rellenando el CV
poco a poco sin que queden huecos vacíos en la web.

Formato de cada bloque:

```markdown
### Puesto — Empresa          # el guion largo separa puesto y empresa

- inicio: 2020-03            # YYYY-MM (obligatorio)
- fin: 2023-06               # se omite si sigues ahí
- ubicacion: Ciudad
- web: https://…
- stack: TypeScript, Vue

Un párrafo de contexto sobre el puesto.

- Un logro concreto y medible
- Otro logro
```

Para formación y proyectos el formato es el mismo, cambiando `titulo —`
institución y `repo:` / `demo:` respectivamente.

## Publicar un artículo

```bash
# 1. Crear el archivo con la cabecera lista
node scripts/site.mjs new "Mi artículo" --category=code --tags=css,html

# 2. Escribir el Markdown en site/code/mi-articulo.md
# 3. Sincronizar, auditar y generar
node scripts/site.mjs publish

# 4. Subir a GitHub Pages (cuando quieras)
node scripts/site.mjs deploy
```

Para revisar el resultado antes de subirlo:

```bash
python3 -m http.server 8080 --directory public
```

### Cabecera de un artículo

```yaml
---
title: Rem + em, a love story
slug: rem-em-love-story        # define la URL; no lo cambies sin motivo
date: 2017-06-28
status: published              # published | draft | archived
category: code
tags: [html, css, bem]
summary: Una línea de resumen.
featured: wp-content/uploads/2017/06/REM.jpg
---
```

Los borradores (`status: draft`) no se publican y no generan página.

## Comandos

| Comando | Qué hace |
|---|---|
| `node scripts/site.mjs new "Título"` | Crea un artículo nuevo en `site/` |
| `node scripts/site.mjs list` | Lista las entradas con su estado |
| `node scripts/site.mjs export` | Vuelca la base de datos a Markdown |
| `node scripts/site.mjs sync [--prune]` | Importa `site/` a la base de datos |
| `node scripts/site.mjs build [--drafts]` | Genera `public/` |
| `node scripts/site.mjs check` | Audita integridad (base de datos y HTML) |
| `node scripts/site.mjs publish` | `sync` + `check` + `build` |
| `node scripts/site.mjs deploy [--dry-run]` | Publica en GitHub Pages |
| `node scripts/cv.mjs export` | Vuelca el CV a `site/cv/curriculum.md` |
| `node scripts/cv.mjs sync` | Importa el CV a la base de datos |
| `node scripts/cv.mjs list` | Resumen del CV registrado |
| `node scripts/import.mjs` | Reimporta el archivo de WordPress |
| `node scripts/mirror-wp.mjs` | Vuelve a descargar el WordPress original |

`--prune` retira de la base de datos las entradas cuyo archivo ya no existe
en `site/`. Es lo que hay que usar para **despublicar** algo: borra el `.md` y
ejecuta `node scripts/site.mjs sync --prune`.

## Auditoría

`node scripts/site.mjs check` comprueba, entre otras cosas, que:

- no falte ningún archivo de medios ni ninguna variante de imagen;
- cada imagen referenciada en el Markdown exista en disco;
- no queden shortcodes ni entidades HTML sin resolver;
- las fechas sean ISO-8601 UTC;
- no haya enlaces ni recursos rotos en el HTML generado;
- no se repitan slugs;
- el CV tenga fechas coherentes (que un puesto no termine antes de empezar),
  titulaciones con institución y enlaces con esquema válido.

Si algo falla, `publish` **no** genera el sitio: primero hay que arreglarlo.

## De dónde viene el contenido

El WordPress original estaba en Hostinger y ya no existe. Todo lo que había
se conserva en `archive/`:

| Carpeta | Contenido |
|---|---|
| `archive/rest/` | Contenido estructurado volcado desde la API REST (9 artículos, 1 página, 21 medios, categorías y etiquetas) |
| `archive/media/` | Los 94 archivos de medios originales, con todas sus miniaturas |
| `archive/html/` | HTML renderizado de las 25 URLs, como referencia visual |
| `archive/manifest.json` | Inventario con el `sha256` de cada archivo descargado |

Este archivo **no se debe borrar**: es la única copia del contenido original.

## Despliegue

El sitio se publica en `pikilon/pikilon.github.io`. Detalles importantes:

- Ese dominio lo **comparten** otros proyectos del usuario (`die-hard-dice`,
  `red-line`…), que viven en sus propios repositorios y se sirven como
  subcarpetas. `scripts/deploy.mjs` sólo reemplaza lo que genera este sitio,
  usando un manifiesto de la publicación anterior, y nunca toca las carpetas
  protegidas.
- `public/` **no** se versiona: se regenera con `build` y se copia al
  repositorio con `deploy`.
- Para servir el dominio propio hace falta un archivo `CNAME` con
  `pikilon.com` y apuntar el DNS desde hPanel a GitHub Pages. No se ha hecho
  todavía: mientras tanto, el sitio responde en
  `https://pikilon.github.io/` y el WordPress antiguo sigue en el dominio.

### Pasar pikilon.com a GitHub Pages (pendiente)

El WordPress de Hostinger **sigue funcionando**: no se ha tocado nada del
hosting. Mientras no se cambie el DNS, el dominio sigue sirviendo el WordPress
antiguo y no hay ninguna prisa. Cuando se quiera hacer el cambio:

1. **Añadir el dominio en GitHub**: `Settings → Pages → Custom domain` con
   `pikilon.com`. Eso crea el archivo `CNAME` en el repositorio.
2. **En hPanel (Hostinger), borrar los registros DNS actuales** del dominio y
   poner los de GitHub Pages:

   | Tipo | Nombre | Valor |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | CNAME | `www` | `pikilon.github.io` |

3. **Esperar a que se propague** (de minutos a unas horas) y activar
   `Enforce HTTPS` en la misma pantalla de Pages.

> **Antes de hacerlo, tener en cuenta dos cosas.** Primero, el WordPress
> antiguo dejará de ser accesible en el dominio: conviene descargar antes el
> respaldo de la base de datos desde hPanel (`Bases de datos → phpMyAdmin →
> Exportar`). Deja el `.sql` en la raíz del repositorio y ejecuta
> `node scripts/import.mjs` para incorporarlo. Segundo, `die-hard-dice` y
> `red-line` comparten hoy el dominio `pikilon.github.io`; al apuntar
> `pikilon.com` a GitHub Pages seguirán accesibles en
> `https://pikilon.github.io/die-hard-dice/` y `/red-line/`, pero conviene
> añadirles un enlace desde el CV.

## Verificar el sitio desplegado

`check.mjs` valida el HTML en disco. Para comprobar lo que sirve el servidor:

```bash
node scripts/verify-live.mjs                          # pikilon.github.io
node scripts/verify-live.mjs https://pikilon.com      # el dominio propio
```

Comprueba cada URL del sitemap, una muestra de los recursos, las
redirecciones heredadas de WordPress, la página 404 y que los proyectos
hermanos del dominio compartido sigan respondiendo.

## Estructura del repositorio

```
archive/        copia del WordPress original (no borrar)
assets/         recursos del sitio (imágenes migradas + favicon)
db/             schema.sql y la base de datos generada
site/           contenido en Markdown (fuente de verdad)
scripts/        herramientas de importación, generación y despliegue
public/         sitio generado (no versionado)
.dsh/skills/    skill de publicación para el agente
```

## Requisitos

Sólo **Node.js 22 o superior** (usa el módulo `node:sqlite` integrado). No hay
`package.json`, ni dependencias, ni paso de compilación.
