# TVLister 24/7 — v2.6.17

**El cupo de aparatos cuenta equipos, no peticiones.** Con una línea de 5 conexiones ya se pueden
usar 5 aparatos distintos; antes, un solo televisor gastaba varios huecos y la línea se llenaba con
uno o dos equipos.

## Qué pasaba

Cada petición del cliente se tomaba como un aparato nuevo cuando la app no manda MAC. Pero una app
no pide todo con el mismo `User-Agent`:

| Petición | User-Agent que llega |
| --- | --- |
| Lista, `player_api.php` | el de la app (`XCIPTV/3.2.2…`) o `okhttp/4.9.0` |
| Manifiesto / segmento HLS | `ExoPlayerLib/2.18.1`, `Lavf/58.76.100`, `stagefright/1.2`… |
| Cambio de canal | otro motor distinto (`libVLC`, `AppleCoreMedia`, `mpv`…) |

Con la huella calculada sobre el `User-Agent` completo, **un televisor generaba 2–4 «aparatos»**.
Una línea de 5 conexiones quedaba llena con dos equipos y, en modo BLOQUEAR, el tercero ya no
entraba. Reproducido en el laboratorio: 3 peticiones de un mismo equipo → 3 filas activas.

## Qué cambia

- **El reproductor no es un aparato.** Los `User-Agent` de motores de vídeo (`ExoPlayer`/Media3,
  `Lavf`/FFmpeg, `AppleCoreMedia`, `libVLC`, `stagefright`, `mpv`, `hls.js`…) y de librerías HTTP
  (`okhttp`, `Dalvik`, `curl`…) **no registran aparato**. Un equipo = una fila.
- **La huella ya no cambia con la versión de la app**: se calculan sin números de versión ni tokens
  aleatorios, así que actualizar la app no crea un aparato nuevo.
- **Depuración de duplicados**: `POST /api/lines/:id/devices/dedupe`, botón **«Depurar duplicados»**
  en el modal de aparatos y `tvlister-admin devices dedupe [usuario] [--dry-run]`. Junta las filas
  del mismo equipo conservando la más antigua; nunca toca una fila bloqueada a mano ni una con MAC
  distinta.
- **Al pasar a modo BLOQUEAR** el panel depura solo antes de empezar a cortar (responde
  `deduped: N`), para que el cupo no se quede lleno con filas viejas.
- **Un aparato «pendiente» vuelve a activo** cuando hay sitio (antes se quedaba pendiente para
  siempre y el cliente seguía viéndose fuera del cupo).

## Comprobación (ejecutada)

Línea de 5 conexiones, modo BLOQUEAR, tráfico realista:

| Caso | Resultado |
| --- | --- |
| MAG con MAC (`Cookie: mac=…`) + 3 User-Agent distintos | **1** aparato |
| XCIPTV 3.2.2 y 3.2.3 (actualización) + reproductor + Lavf | **1** aparato |
| 5 equipos distintos (MAG, XCIPTV, TiviMate, Smarters, OTT Navigator) | **5** aparatos, todos dentro del cupo |
| 6.º equipo | `{"auth":0,"message":"Esta línea admite 5 aparato(s) y ya hay 5 registrados…"}` |
| 8 filas viejas de 2 casas (2 TVs) | depuradas a **4** (una por equipo/app) |
| 3 filas viejas de un mismo equipo | depuradas a **1** (`deduped: 2` al pasar a BLOQUEAR) |
| Modo SÓLO REGISTRAR con cupo lleno | registra `pending`, **no corta** |
| Subir el cupo y pasar a BLOQUEAR | el `pending` pasa a `active` |

## Sin cambios

No se toca la salida UDP/CATV, ni Flussonic, ni el VOD de Jellyfin, ni el contrato de las apps
Xtream/M3U/MAG. El límite de conexiones simultáneas (`max_connections`) sigue siendo independiente
del cupo de aparatos.

## Guía
[`docs/REGISTRO_APARATOS_MAC.md`](REGISTRO_APARATOS_MAC.md)

## Instalación / actualización
```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.17/install.sh \
  | sudo bash -s -- --tag v2.6.17 --port 8095
```
