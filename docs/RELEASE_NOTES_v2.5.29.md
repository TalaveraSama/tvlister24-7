# TVLister 24/7 — v2.5.29 «Los enlaces salen por el dominio que tú elijas (y se puede desde el panel)»

## Lo que te pasa

Descargas la lista desde `http://tvadmin.alphadigitalnic.xyz` y dentro de la lista todos los
enlaces salen por **ese** dominio, no por el dedicado a los streams.

**No es un fallo: es el comportamiento por defecto.** TVLister construye los enlaces con el
mismo host y puerto con el que el cliente pide la lista. Si el dominio de video no está fijado
en los ajustes, hereda el del panel.

Históricamente eso se fijaba con un ajuste (`public_stream_base`) que sólo se podía tocar por
terminal o con `cloudflare <panel> <streams>`. Si no se ejecutaba, la lista salía con el dominio
del panel. Eso es lo que estabas viendo.

## Lo que cambia ahora

**1. Se puede fijar desde el propio panel**, sin terminal:

`Servidores y Seguridad → Ajustes Globales → Dominio de los streams / video`

Hay un campo, tres atajos (Automático / Puerto 80 / Puerto 443) y un botón Limpiar. Guardas y
se aplica al instante: la siguiente vez que alguien descargue la lista, los enlaces ya salen por
ese dominio. Si lo dejas vacío, vuelve a seguir el dominio del panel (automático).

**2. Ya no se queda a medias.** Antes sólo cambiaban las URLs de la lista M3U (`get.php`).
Ahora cambian **todas** las salidas de video, que era justo lo que hacía que un reproductor
siguiera yendo al dominio del panel:

| Salida | Antes | Ahora |
| --- | --- | --- |
| Lista M3U (`get.php`, `output=ts/m3u8/mnf`) | dominio de streams | igual |
| `enigma2.php` | dominio de streams | igual |
| `player_api.php` → `server_info.url` / `port` | **dominio del panel** | dominio de streams |
| Portal Stalker (`load.php`, `cmd`) | **dominio del panel** | dominio de streams |
| Segmentos del catch-up (`/archive_seg/…`) | **dominio del panel** | dominio de streams |
| `/live/`, `/hls_proxy/`, `/mnf/`, VOD | dominio de streams | igual |

`server_info` importa mucho: los reproductores que hablan la API Xtream (TiviMate, IPTV Smarters,
OTT Navigator…) usan ese campo para montar las URLs de reproducción. Si decía
`tvadmin.alphadigitalnic.xyz:443`, el player iba al panel aunque la lista dijera otra cosa.

**3. `cloudflare` ya no pone `https://` a ciegas.** Antes, al crear el server block de streams
fijaba `https://<dominio_de_streams>` aunque no hubiera certificado (sólo generaba HTTP:80).
Resultado: todos los enlaces muertos. Ahora el esquema se elige según lo que realmente se haya
generado: con certificado → `https`, sin él → `http`.

**4. `streams-port` comprueba el mundo real.** Al fijar el dominio comprueba en el acto:

```
   [AVISO] live-stream.alphadigitalnic.xyz resuelve a 173.208.183.66, no a este servidor (203.0.113.20).
           Los clientes no llegarán al video hasta arreglar el registro A/DNS.
   [AVISO] Ningún server block atiende live-stream.alphadigitalnic.xyz todavía.
           Créalo con:  tvlister-admin cloudflare tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```

Y si el nombre resuelve a un rango de Cloudflare, avisa de que el registro está en **naranja** y
que para video tiene que estar en **gris**.

**5. La puerta del código de acceso ya no rompe el catch-up.** `/archive_seg/`, `/xui_images/` y
`/vod_local_poster` no estaban exentos: con un código de acceso activo, los segmentos del
timeshift y las carátulas del reproductor devolvían la página del código en vez del contenido.
Corregido.

## Cómo lo dejas funcionando en tu servidor (3 pasos)

1. Actualiza:

   ```bash
   tvlister-admin update
   ```

2. En Cloudflare, crea el registro del subdominio de video en **GRIS (DNS only)**:

   ```
   live-stream.alphadigitalnic.xyz    A    <IP del servidor>    DNS only
   ```

3. Fija el dominio. Desde el panel (lo nuevo) o por terminal:

   ```bash
   tvlister-admin streams-port 80 live-stream.alphadigitalnic.xyz
   ```

   Si todavía no existe el server block que atiende ese nombre:

   ```bash
   tvlister-admin cloudflare tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
   ```

Y comprueba:

```bash
tvlister-admin streams-check
```

```
  [OK]    Base pública de streaming: http://live-stream.alphadigitalnic.xyz
          Puerto de salida de los streams: 80 (http)
  Los enlaces de video salen por: http://live-stream.alphadigitalnic.xyz
  Primer enlace: http://live-stream.alphadigitalnic.xyz/live/usuario/clave/1.m3u8
```

Vuelve a descargar la lista desde el panel: los enlaces deben empezar por el dominio de streams.

## Pruebas

Servidor de prueba con la misma base de datos y el mismo nginx simulado, entrando **siempre por el
dominio del panel** (`Host: tvadmin.alphadigitalnic.xyz`):

| Prueba | Sin fijar | Fijado a `live-stream…` |
| --- | --- | --- |
| `get.php` (M3U) | `http://tvadmin…/live/…/1.ts` | `http://live-stream…/live/…/1.ts` |
| `player_api.php` → `server_info` | `tvadmin…` / 443 | `live-stream…` / 80 |
| Stalker `load.php` → `cmd` | `http://tvadmin…/live/…` | `http://live-stream…/live/…` |
| `xmltv.php` (EPG de la lista) | `http://tvadmin…` | `http://live-stream…` |
| Fijar desde la API (la UI) | — | `{"ok":true}` y aplicado al instante |
| Vaciar / `auto` | — | vuelve a `http://tvadmin…` |
| `public_stream_base: "no es un dominio"` | — | `400` con el ejemplo correcto |
| `live-stream…:80` | — | se normaliza a `http://live-stream…` |
| `cloudflare` sin certificado | `https://` (roto) | `http://` (coherente con el server block) |
