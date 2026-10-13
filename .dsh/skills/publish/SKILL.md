---
name: publish
description: Publicar, editar y desplegar contenido de pikilon.com. Úsala cuando el usuario quiera escribir un artículo nuevo, corregir uno existente, importar imágenes, regenerar la web estática o subir cambios a GitHub Pages.
whenToUse: El usuario pide publicar o editar algo en su web/CV, añadir una imagen, regenerar el sitio, o desplegar en pikilon.com.
---

# Publicar en pikilon.com

Este repositorio **es** la web. El contenido vive en SQLite (`db/pikilon.db`),
se escribe como Markdown en `site/`, y `scripts/build.mjs` genera el HTML
estático en `public/`. No hay WordPress ni base de datos remota.

## Flujo normal

Cuando el usuario pida publicar algo:

1. **Crear el archivo** (si es contenido nuevo):
   ```
   node scripts/site.mjs new "Título del artículo" --category=code --tags=css,html
   ```
   Esto escribe `site/<categoría>/<slug>.md` con la cabecera ya preparada.

2. **Escribir el contenido** en ese archivo, en Markdown. La cabecera admite:
   - `title` (obligatorio), `slug`, `date` (`YYYY-MM-DD`), `status`
     (`published` | `draft` | `archived`), `category`, `tags: [a, b]`,
     `summary`, `featured` (ruta dentro de `assets/`).

3. **Publicar**: `node scripts/site.mjs publish`
   Sincroniza `site/` → base de datos, audita y regenera `public/`.
   Si la auditoría falla, **no** se genera nada: hay que arreglar el error
   antes.

4. **Desplegar** (sólo si el usuario lo pide): `node scripts/site.mjs deploy`
   Sube `public/` al repositorio de GitHub Pages.

## Reglas que no se deben romper

- **El `slug` es la URL.** Cambiarlo rompe enlaces y posicionamiento. Si hay
  que cambiarlo de verdad, `publish` lo exige con `--force` explícito; avisa
  al usuario antes.
- **Nunca edites `db/pikilon.db` a mano** si puedes editar el Markdown: el
  siguiente `sync` sobreescribiría el cambio. `site/` manda.
- **Nunca borres `public/assets/` ni `assets/`**: son los recursos migrados
  del WordPress original y no se pueden volver a descargar.
- **Al desplegar, no toques las carpetas de otros proyectos.** El dominio
  `pikilon.github.io` lo comparten `die-hard-dice`, `red-line`, etcétera. La
  lista de protegidos está en `scripts/deploy.mjs` (`PROTECTED`).
- Si un artículo nuevo necesita una imagen, cópiala a `assets/` y
  referénciala como `/assets/<ruta>`. Añadir el registro a la tabla `media`
  sólo hace falta si quieres usarla como imagen destacada.

## Comandos disponibles

| Comando | Para qué |
|---|---|
| `node scripts/site.mjs new "Título"` | Crear un artículo nuevo |
| `node scripts/site.mjs list` | Ver qué hay publicado |
| `node scripts/site.mjs export` | Volcar la BD a Markdown en `site/` |
| `node scripts/site.mjs sync` | Importar `site/` a la base de datos |
| `node scripts/site.mjs build` | Generar `public/` |
| `node scripts/site.mjs check` | Auditar integridad (BD + HTML) |
| `node scripts/site.mjs publish` | Sincronizar + auditar + generar |
| `node scripts/site.mjs deploy` | Subir a GitHub Pages |
| `node scripts/import.mjs` | Reimportar el archivo de WordPress |
| `node scripts/mirror-wp.mjs` | Re-descargar el WordPress original |

## Revisar el resultado antes de desplegar

El sitio se puede servir en local para comprobarlo:

```
python3 -m http.server 8080 --directory public
```

Y siempre hay que pasar la auditoría:

```
node scripts/site.mjs check
```

Comprueba que ni una sola imagen, enlace, fecha o término esté roto. Si
informa de `recurso roto`, casi siempre es una ruta mal escrita en el
Markdown.

## Contexto de la migración

Los artículos actuales vienen de un WordPress alojado en Hostinger. El
archivo original (HTML renderizado, JSON de la API REST y los 94 archivos de
medios) está en `archive/` y no debe borrarse: es la única copia del
contenido tal y como estaba. `scripts/import.mjs` lo traduce, y
`scripts/mysql-import.mjs` sabe leer además un dump `.sql` de MySQL si el
usuario deja uno en la raíz del repositorio.
