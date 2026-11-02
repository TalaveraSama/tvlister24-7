# TVLister 24/7 — v2.6.0 «DRM: TVLister es tu servidor de claves (CAS)»

Sobre el repo que enviaste (`sandri-kun/IPTV-DRM-Stream-Player`): **no se puede incrustar**. Es una
app **Android cerrada** (licencia MIT sólo del README y las playlists de ejemplo, que es lo único
que hay en el repo); el APK no es open source, así que no hay librería que meter en el panel. Lo
que sí trae es el formato que hay que servirle: una lista M3U con `#KODIPROP` de licencia, o la
API Xtream. **Eso es exactamente lo que ahora produce TVLister.**

Y como dices, las llaves las pone Flussonic. El punto que faltaba era que Flussonic **no cifra
solo**: en `drm aes128` pide la clave a un servidor de claves (CAS) y publica en el HLS la URL que
ese CAS le devuelva. Ese CAS es ahora **TVLister**, así que las claves pasan por nuestras líneas,
nuestros tokens y nuestro log.

## Cómo queda

```
        ┌────────────── pide clave (16 bytes) ──────────────┐
        │                    /drm/cas/<token>               │
   Flussonic ─────────────────────────────────────────►  TVLister
        │  ◄──── X-Key-Url: /drm/key/<token> ───────────    │
        │                                                   │
   reproducción HLS cifrada (AES-128)                       │
        │                                                   │
   cliente (TiviMate, Smarters, la app DRM, WebTV…)         │
        └──── pide la clave ──► /drm/key/<token> ──────────►┘
                                   (token de línea + log)
```

1. **CAS** — `GET /drm/cas/<token>?file=<stream>&number=<n>`: sólo la llama tu Flussonic (se puede
   restringir por IP). Devuelve la clave de 16 bytes y la cabecera `X-Key-Url`.
2. **Entrega de clave** — `GET /drm/key/<token>?n=<n>`: la clave se deriva con **HKDF-SHA256** de
   una clave maestra por canal y el número de rotación de Flussonic, así que **rota cada 10 minutos
   sin guardar nada**. Se sirve por el mismo dominio de los streams y queda registrada (canal, IP,
   línea, resultado).
3. **Rotación de tokens** — cambiar `<token>` invalida todas las URLs antiguas al instante.
4. **Proxy de licencias Widevine/PlayReady** — `/drm/license/<token>?t=<token_de_línea>`: el
   cliente pide la licencia aquí, TVLister inyecta tus cabeceras secretas y habla con tu servidor
   de licencias. Tu keyserver nunca queda expuesto.
5. **`#KODIPROP` en la lista** — para canales Widevine/PlayReady, `get.php` emite las líneas que
   entienden Kodi, OTT Navigator, TiviMate y la app DRM, con la licencia apuntando a nuestro proxy
   y firmada **para esa línea**.

## En el panel

Nueva sección **DRM & Claves** (menú lateral, badge `CAS`):

- interruptor global de DRM, IPs permitidas al CAS y servidor de licencias por defecto;
- contadores de las últimas 24 h (claves CAS, claves a clientes, licencias);
- lista de canales protegidos, con **aviso si un canal CATV usa el mismo stream de Flussonic**;
- por canal: modo, clave fija opcional, activar, guardar, **Probar clave** (comprueba 16 bytes y
  que rota), **Rotar tokens**, borrar;
- el bloque de Flussonic listo para copiar y **vista previa por API** antes de aplicar nada
  (y un botón para quitarlo).

## En la terminal

```bash
tvlister-admin drm                       # estado, canales, URLs y actividad
tvlister-admin drm enable 1 aes128       # por ID o por nombre del canal
tvlister-admin drm enable "Canal Uno" widevine
tvlister-admin drm snippet 1             # bloque para flussonic.conf
tvlister-admin drm test 1                # 16 bytes y rotación
tvlister-admin drm tokens 1              # invalida las URLs viejas
tvlister-admin drm log 20
tvlister-admin drm on | off              # interruptor global
```

## Lo que NO se toca (a propósito)

- **Nada del camino UDP/CATV.** El DRM sólo afecta a la salida HTTP (HLS/DASH) de Flussonic. Si un
  canal CATV usa ese stream de Flussonic para generar UDP, el panel te lo marca en rojo antes de que
  actives nada.
- **Nada de la línea de argumentos de FFmpeg.** No se reempaqueta ni se recodifica: la clave la pone
  Flussonic y TVLister sólo la sirve.
- **El preview del panel** reproduce AES-128 sin cambios (hls.js sigue la `EXT-X-KEY`). Para
  Widevine/PlayReady en navegador hace falta EME con Shaka; para eso están la app DRM, TiviMate u
  OTT Navigator.

## Configurar en tu servidor

1. `tvlister-admin drm enable <canal> aes128`
2. Copia el bloque en `/etc/flussonic/flussonic.conf`, dentro del stream:

   ```
   stream canal1 {
     # ... tu input y protocolos actuales ...
     drm aes128 keyserver=https://tvadmin.alphadigitalnic.xyz/drm/cas/<token>
   }
   ```

   Ojo: el CAS lo llama **Flussonic**, así que esa URL tiene que ser alcanzable desde el servidor de
   Flussonic (mismo host o IP pública/LAN, no `127.0.0.1` si va en otra máquina).
3. Recarga Flussonic y pon un canal en el panel: la lista debe traer `EXT-X-KEY` y la reproducción
   debe funcionar igual que antes, pero con clave.
4. `tvlister-admin drm log` debe empezar a mostrar `cas` (Flussonic) y `key` (clientes).

## Pruebas hechas

| Prueba | Resultado |
| --- | --- |
| CAS con token válido | 16 bytes + `X-Key-Url` correcta |
| Clave del CAS == clave del jugador (mismo número) | idénticas |
| Número de clave 1 vs 2 | distintas (rota) |
| `?fmt=clearkey` / `/drm/clearkey/` | JSON ClearKey válido (`kty`, `kid`, `k`) |
| Token inventado | 404 |
| Token de línea manipulado en la licencia | 401 |
| Proxy de licencia (POST a un servidor de prueba) | reenvía cuerpo y cabeceras secretas |
| `OPTIONS` (CORS del reproductor) | 204 |
| Lista M3U, modo widevine | `#KODIPROP` con licencia firmada por línea |
| Lista M3U, modo aes128 | sin `KODIPROP` (el jugador sigue la `EXT-X-KEY`) |
| `drm test`, `drm snippet`, `drm log`, `drm enable/disable` | OK |
| Log de entregas | canal, número, IP, línea y resultado |
