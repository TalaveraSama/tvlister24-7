# TVLister 24/7 — v2.6.14 «Tercer dominio para las apps que ya están en producción»

Hay aplicaciones de terceros (las que hablan la API de Xtream Codes / XUI.one) que **ya están en
producción** pidiendo lista y video a `livex-stream.alphadigitalnic.xyz`. Hasta ahora el panel
respondía a todo el mundo con el dominio de video nuevo, así que esas apps habrían empezado a recibir
enlaces de un dominio que no conocen.

## 1. El dominio de compatibilidad

Nuevo ajuste `compat_domain` (tercer dominio). Cuando una petición entra por ese dominio, **todo lo
que se le contesta vuelve por ese mismo dominio**:

| Entra por | `get.php` / `player_api.php` responden con |
| --- | --- |
| `livex-stream…` | `https://livex-stream.alphadigitalnic.xyz/live/…` · `server_info.url` = ese dominio |
| `live-stream…` / `tvadmin…` | `https://live-stream.alphadigitalnic.xyz/live/…` (sin cambios) |

Es una **vista**, no un panel aparte: misma BD, mismas líneas, mismos canales y mismos límites. Solo
cambia el host de los enlaces.

## 2. Lo que se tocó

- **`server/publicBase.js`**: `getStreamBaseUrl(req)` respeta el dominio por el que entra la
  petición; `isCompatRequest()`, `getCompatDomain()`. El esquema (http/https) se decide con
  `X-Forwarded-Proto`/`req.secure` y, si llega en claro pero ese nombre tiene certificado instalado,
  se anuncia en **https** (una lista abierta por https no debe traer enlaces http).
- **`server/domains.js`**: `compatDomain` en `getDomains`/`setDomains` (rechaza que sea el del panel),
  rol `compat` en `checkHost` (debe ir en **nube gris**) y una sonda real de Xtream:
  `GET /player_api.php` con usuario de prueba → debe responder `user_info`.
- **`server/tlsManager.js`**: el dominio de compatibilidad entra en la lista de nombres del 443 (SNI).
- **`server/index.js`**: `POST /api/domains` acepta `compatDomain`.
- **CLI**: `tvlister-admin dominios <panel> <video> [compat]`; la comprobación lo muestra como
  `COMPATIBILIDAD (apps Xtream de terceros, nube gris)` y añade `Xtream: /player_api.php responde`.
  `tvlister-admin cloudflare` añade ese nombre al `server_name` del bloque de streams.
- **Panel**: tercer campo en *Ingesta → Multi-Puertos → Dominios públicos* y tercera tarjeta en la
  comprobación.

## 3. Comprobado ejecutando (panel real + 443 con SNI de los tres nombres)

| Prueba | Resultado |
| --- | --- |
| `get.php` por `livex-stream` | `#EXTM3U` con `https://livex-stream.alphadigitalnic.xyz/live/…` |
| `player_api.php` por `livex-stream` | `server_info.url = livex-stream…`, `port 443`, `https` |
| Los mismos endpoints por `tvadmin` | enlaces a `live-stream…` (sin cambios) |
| `/live/PRUEBA/clave123/9001.m3u8` por `livex-stream` | HTTP 302 al origen (correcto) |
| `action=get_drm` por cada dominio | `key_url` en el dominio por el que se entró |
| `GET /drm/key/…` por `livex-stream` | HTTP 200 · **16 bytes** |
| `checkDomains()` con los tres | `ok: true`, cert de cada nombre, `xtream: sí` en compat |
| `setDomains` con compat = panel | ❌ rechazado ("esas apps acabarían pasando por Cloudflare") |
| `setDomains` con dominio inválido | ❌ rechazado |
| Lista SNI del 443 | los tres nombres |
| `vite build`, `node --check`, `bash -n` | correctos |

## Instalación

```bash
sudo tvlister-admin update
sudo tvlister-admin dominios tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz livex-stream.alphadigitalnic.xyz
sudo tvlister-admin acme tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz livex-stream.alphadigitalnic.xyz correo@dominio.com
sudo tvlister-admin dominios
```

Si el 443 lo sirve el nginx de XUI.one, vuelve a generar los bloques para que `livex-stream` quede
en el `server_name`:

```bash
sudo tvlister-admin cloudflare tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```
