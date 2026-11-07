# TVLister 24/7 — v2.5.24 «streams-check: seguir la cadena HLS de verdad»

Tu salida del 1 de noviembre funcionaba, y aun así dejaba ver un fallo de la herramienta:

```
  [INFO]  Primer segmento: http://…/hls_proxy/ruben/ruben2026/430?u=…
          200/939 B application/vnd.apple.mpegurl; charset=utf-8
  [OK]    El segmento llega completo: el canal se puede reproducir.
```

939 B y tipo **mpegurl**: eso no es un trozo de vídeo, es **otra playlist**. La comprobación
se paraba al primer nivel y daba por bueno cualquier cosa. Si un día la cadena se rompe en el
nivel siguiente, habría seguido diciendo `[OK]`.

```bash
tvlister-admin release v2.5.24
tvlister-admin streams-check
```

## 1. Qué cambia

`streams-check` ahora **sigue la cadena** hasta encontrar vídeo de verdad, con un máximo de
4 niveles:

- playlist **maestra** (`#EXT-X-STREAM-INF`) → sigue la primera variante;
- playlist de **medios** → toma el primer segmento;
- si lo que llega **vuelve a ser una playlist**, lo dice y sigue bajando un nivel;
- cuando llega el trozo real, informa tamaño y tipo, y exige más de 2 KB para dar el `[OK]`.

Salida nueva con una fuente que encadena playlists:

```
  [OK]    Playlist HLS de medios (1 segmento(s) en el momento de la prueba)
  [INFO]  Nivel 1: ese enlace es OTRA playlist (352 B), no vídeo.
          => http://…/hls_proxy/ruben/ruben2026/1?u=…
  [OK]    Nivel 2: playlist HLS de medios (2 segmento(s)).
  [INFO]  Trozo de vídeo real:
          http://…/hls_proxy/ruben/ruben2026/1?u=…
          200 · 376000 B · text/vnd.trolltech.linguist
  [OK]    El segmento de vídeo llega completo: el canal se puede reproducir.
```

Y cuando el canal está muerto, no hay duda de dónde está el problema:

```
  [FALLA] Respondió 503: Señal RTMP/SRT/RTSP sin transmisión activa…
          El problema está en la FUENTE del canal…
```

## 2. Por qué importa en tu caso real

Tu canal 430 (`69.30.212.194:2086/…/mono.m3u8`) sirve **HLS de un solo perfil** con un salto
extra de playlist. Con la versión anterior, si ese segundo salto devolviera un 403 o una
playlist vacía, el comando habría dicho «todo OK» y habrías seguido buscando el fallo en el
cliente. Ahora ese caso sale como `[FALLA]` con la URL exacta que falla.

## 3. Cómo se probó

Panel real levantado, con fuentes locales que reproducen tu estructura:

| Fuente del canal | Resultado |
| --- | --- |
| Playlist **maestra** (2 variantes) → variante → `.ts` | sigue la variante y llega al `.ts` de 376.000 B |
| Playlist de medios cuyo primer elemento es **otra playlist** | detecta el salto («OTRA playlist»), baja al nivel 2 y llega al `.ts` |
| Fuente caída (puerto cerrado) | `[FALLA] 503` con el motivo de la fuente |
| Línea incorrecta | error del panel, sin seguir |
| Panel apagado | `[FALLA]` en el primer paso |

## 4. Lo que ya funcionaba y sigue igual

- `get.php` con la línea real, contando canales (en tu servidor: **148**).
- Aviso si el dominio de video no resuelve o apunta a otra IP.
- Detección de `cf-ray` (dominio de video en naranja).
- TLS del origen con su fecha de caducidad.

En tu servidor los enlaces salen por el **dominio del panel**, que es lo que estaba
funcionando antes de tocar Cloudflare. El reparto con subdominio propio queda pendiente de que
exista el registro DNS y el server block; cuando lo quieras, `cloudflare --check` te dirá si ya
está listo.
