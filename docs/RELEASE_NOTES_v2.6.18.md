# TVLister 24/7 — v2.6.18

**Jellyfin: si dice «0 archivos accesibles», ahora el panel busca dónde están de verdad.** Caso
típico: Jellyfin en Docker entrega rutas `/Media/…` y en el servidor ese contenido está en
`/home/xui/media`. Antes la importación se quedaba en «509 no accesibles» y no entraba nada.

## Qué se añadió

### Detección de la carpeta real
- Botón **«Buscar la carpeta real»** en la vista previa y ruta `POST /api/jellyfin/detect-paths`.
- Primero prueba a **sustituir el primer tramo** de la ruta de Jellyfin por las carpetas reales del
  servidor (`/media`, `/mnt`, `/srv`, `/opt`, `/home`, `/var/lib`, las carpetas de sincronización VOD
  del panel y la que indiques en *«Carpeta real de los vídeos»*). Es instantáneo (milisegundos).
- Si eso no acierta, **indexa los archivos de vídeo por nombre** (con presupuesto de tiempo y
  profundidad para no colgar el panel) y busca cada título.
- Devuelve la equivalencia con la cobertura (`5/5 archivos`) y un botón **«Aplicar y guardar»**.
- Casilla **«Detectar la carpeta real sola»** (marcada por defecto): al pulsar **Importar**, el panel
  detecta, guarda la equivalencia e importa en la misma pasada.
- **Índice por nombre de archivo** (`jellyfin_file_index`) como respaldo: resuelve títulos cuando el
  mismo prefijo de Jellyfin tiene el contenido repartido en dos discos.

### Diagnóstico claro en la vista previa
- Distingue **«no existe»** de **«sin permiso»** (`403`/`EACCES`). Con permisos, avisa y no crea
  enlaces rotos: `sudo chown -R tvlister:tvlister CARPETA`.
- Muestra los **prefijos sin ubicar** (`/Media · 509 sin ubicar`) para saber qué equivalencia falta.
- El resultado de la importación incluye `detectedPaths`, `unreachableReasons` y un `hint`.

### Bibliotecas que no duplican el catálogo
- Las bibliotecas de tipo **lista de reproducción, música, fotos o vídeos caseros se omiten**: son
  las mismas películas con otro identificador y duplicaban el VOD (tu «Playlists» sumaba 509 títulos
  repetidos). Ahora sólo se importan `movies`/`boxsets` y `tvshows`.

### Nombres de archivo
- Si el título ya trae el año (`… 2025`, `… (2024)`), **no se repite** al crear el enlace.

## Comprobado ejecutando el panel

| Caso | Resultado |
| --- | --- |
| Jellyfin Docker `/Media/…` con archivos en otra carpeta, sin mapa | vista previa: 5/5 no accesibles, prefijo `/Media` |
| «Buscar la carpeta real» | `/Media → /tmp/jf3/media/peliculas`, 5/5 resueltos |
| Aplicar y guardar | vista previa: **6 accesibles, 0 no accesibles** |
| Importar (BD limpia, auto-detección) | 5 películas, 1 serie, 1 episodio, **6 enlaces**, 0 sin archivo |
| Carpeta indicada a mano | detección en **32 ms**, 5/5 |
| Biblioteca «Playlists» marcada | omitida: 0 duplicados (antes 509 repetidos) |
| Archivo con `chmod 000` | vista previa «sin permiso», importación lo salta y avisa del `chown` |
| Título con año en el nombre | enlace `13 dias en el lago de la muerte 2025.mkv` (sin `(2024)` duplicado) |

## Sin cambios
VOD ya importado, enlaces existentes, reproducción con Range, salida UDP/CATV y registro de aparatos.

## Guía
[`docs/JELLYFIN_VOD.md`](JELLYFIN_VOD.md)

## Instalación / actualización
```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.18/install.sh \
  | sudo bash -s -- --tag v2.6.18 --port 8095
```
