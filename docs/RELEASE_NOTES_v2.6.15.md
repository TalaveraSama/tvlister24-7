# TVLister 24/7 — v2.6.15 «DRM fuera: registro de aparatos por MAC»

Se retira el DRM del producto y se sustituye por una protección que **no toca la app**: el panel
apunta la MAC de cada aparato que se conecta y corta al que pasa del cupo de la línea.

## Lo que se va

- `server/drm.js` completo (CAS propio, AES-128, ClearKey y proxy de licencias Widevine/PlayReady).
- Página **DRM & Claves** del panel y su entrada de menú.
- Rutas `/drm/cas`, `/drm/key`, `/drm/clearkey`, `/drm/license` y su excepción en la puerta de
  access codes.
- `action=get_drm` en `player_api.php` y las `#KODIPROP` de la lista M3U.
- Tablas `drm_streams`, `drm_key_log` y columnas `cenc_*`.
- Comando `tvlister-admin drm` (la opción 29 del menú pasa a ser **Registro de aparatos**).
- Documentos `DRM_QUIEN_EMITE_LAS_CLAVES.md`, `INTEGRACION_DRM_APP.md` y `drm_api_contract.json`, y la
  tarjeta *DRM* de la ficha de un dispositivo en la app.

Las rutas retiradas ya no devuelven la página del panel: `/drm/*` y `/api/drm/*` responden
**410 Gone** con `{"error":"drm_retired"}` y `action=get_drm` devuelve lo mismo, para que las apps
que aún lo llamen se enteren en vez de esperar una clave que no va a llegar.

**No se cifra nada**: ni AES-128, ni Widevine, ni PlayReady. Los canales se sirven como siempre.

## Lo que entra: registro de aparatos por MAC

`server/deviceRegistry.js` (nuevo) enganchado en `authenticateLine()`, así que vale para **todo** lo
que use credenciales de línea: lista M3U, `get.php`, `player_api.php`, `/live`, `/movie`, `/series`,
timeshift, MAG/Stalker, Enigma2 y el portal WebTV.

- **Tres modos** (ajuste `device_registry_mode`): `off`, `monitor` (**por defecto**: sólo registra y
  avisa) y `enforce` (corta con `403`). El cambio se aplica al instante, sin reiniciar.
- **Identificación**: MAC desde cabeceras (`X-MAC-Address`, `X-Device-MAC`, `X-MAC`, `MAC`,
  `X-Stalker-MAC`…), `Cookie: mac=`, `X-User-Agent: … MAC=…`, `Authorization: MAC …` o `?mac=`. Si la
  app no manda MAC, se usa una huella estable `fp:<hash>` de serial + modelo + sistema + reproductor.
- **Tipo de equipo completo**: `stb` (MAG/Stalker), `enigma2`, `smart-tv`, `streaming-box`,
  `android-box`, `movil`, `app`, `navegador`, `dispositivo`; más marca (`Infomir`, `Samsung`, `LG`,
  `Amazon`, `NVIDIA`, `Xiaomi`, `Apple`…), modelo, sistema operativo, reproductor y `User-Agent`.
- **Cupo por línea**: `lines.device_limit` si es > 0; si no, `max_connections`. El que sobra queda
  `pending` en modo monitor y se rechaza en modo bloquear.
- **Auto-registro** hasta el cupo, alta manual de una MAC, bloqueo, liberación, borrado de fila y
  limpieza de la línea entera.
- **Caché de 60 s** por línea+aparato (no se escribe por cada segmento HLS) con invalidación
  inmediata entre procesos mediante `device_registry_version`.

## Panel

En **Usuarios y Dispositivos**, tarjeta nueva **Registro de aparatos** con el modo, los activos, el
reparto por tipo, las líneas por encima del cupo y un aviso si queda DRM antiguo en Flussonic. En
cada línea, el botón de aparato muestra MAC, tipo, marca/modelo, sistema, reproductor, IP, veces
visto y `User-Agent`, con botones Bloquear / Permitir / Borrar / Limpiar todos y alta manual por MAC.

## Terminal

```bash
tvlister-admin devices                       # resumen
tvlister-admin devices mode monitor          # off | monitor | enforce
tvlister-admin devices line cliente1
tvlister-admin devices block cliente1 AA:BB:CC:11:22:33
tvlister-admin devices allow cliente1 AA:BB:CC:11:22:33
tvlister-admin devices reset cliente1
tvlister-admin devices undrm [--apply]       # quita el DRM que quedó en Flussonic
```

## Base de datos

- Columnas nuevas en `line_devices`: `mac`, `device_type`, `brand`, `model`, `os`, `player`,
  `user_agent`, `auto_registered`, `blocked`, `seen_count` (+ índice `line_devices(line_id, mac)`).
- `lines.device_limit` nace en **0** = usar `max_connections`. Las líneas antiguas que lo tenían en 1
  sin tener el bloqueo de la app activo se normalizan a 0 una sola vez.
- Al migrar se guarda en el ajuste `drm_legacy_streams` qué canales tenían DRM empujado a Flussonic
  y **se borran** `drm_streams` y `drm_key_log`. Si ese HLS se quedó cifrado, se ve en negro: se
  arregla con `tvlister-admin devices undrm --apply` (quita sólo el bloque `drm`; conserva inputs,
  transcoder, dvr, protocols y options).

## API nueva

`GET|POST /api/devices/registry`, `GET|POST /api/lines/:id/devices`,
`POST /api/lines/:id/devices/limit`, `POST /api/lines/:id/devices/:deviceId/{block,allow}`,
`DELETE /api/lines/:id/devices/:deviceId`, `POST /api/lines/:id/devices/reset` y
`POST /api/devices/undrm`.

## Compatibilidad

- La lista M3U, `/live/:user/:pass/…` y `player_api.php` **no cambian** de formato.
- El bloqueo opcional de la app propia (`device_lock` + `register_device`/`heartbeat`) sigue igual;
  ahora cuenta sólo sus filas (`auto_registered = 0`) para no mezclarse con el registro por MAC. Si
  una línea lo tenía activo, el panel de aparatos lo detecta y deja desactivarlo con un clic
  (`POST /api/lines/:id/device-lock`), porque si no los clientes que no usen la app reciben `403`.
- El UDP/CATV y la línea de argumentos de FFmpeg no se han tocado.

## Pruebas hechas

- Modo monitor: 4 aparatos en una línea de 3 → los 4 entran, el 4.º queda `pending`.
- Cambio a `enforce` sin reiniciar: el `pending` recibe `403`, los 3 activos siguen entrando y el
  5.º nuevo recibe `403`.
- Bloqueo por CLI y por API: `403` inmediato; liberación: vuelve a entrar.
- Alta manual de MAC y conexión real: la fila aprende tipo, marca y reproductor.
- Cliente sin MAC (sólo `User-Agent`): entra por huella y no duplica filas al reconectar.
- `get.php`, `player_api.php`, `xmltv.php`, `/live` y `output=ts` siguen respondiendo igual.
