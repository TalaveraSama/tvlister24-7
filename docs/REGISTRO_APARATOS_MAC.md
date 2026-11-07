# Registro de aparatos por MAC (protección sin cifrado)

Desde la **v2.6.15** TVLister ya no cifra el video. El DRM (AES-128 propio, ClearKey y el proxy de
licencias Widevine/PlayReady) **se retiró del producto** porque exigía que cada app implementara
EME, y las apps en producción (Xtream/XUI, M3U, MAG/Stalker, Enigma2) no se pueden tocar.

La protección es otra: **el panel apunta en qué aparatos vive cada línea** y corta al que sobra.

```
cliente conecta  ──►  ¿la MAC ya está registrada?  ──►  sí ──►  entra
                          │
                          └──► no ──► ¿queda cupo en la línea? ──► sí ──► se auto-registra y entra
                                                              └──► no ──► 403 (sólo en modo bloquear)
```

No se toca ni el UDP/CATV, ni los argumentos de FFmpeg, ni la lista M3U, ni el `player_api.php`:
las apps siguen funcionando tal cual.

---

## 1. Los tres modos

| Modo | Qué hace | Cuándo usarlo |
| --- | --- | --- |
| `off` | No registra nada. Comportamiento anterior. | Si no quieres la función |
| `monitor` (**por defecto**) | Registra y marca `pending` al que pasa del cupo, pero **no corta a nadie** | Primeras semanas: ver qué aparatos entran antes de apretar |
| `enforce` | Registra y corta con `403` al que pasa del cupo | Cuando el registro ya está completo |

El modo es **global** y se cambia en el panel (tarjeta *Registro de aparatos*) o por terminal:

```bash
tvlister-admin devices mode monitor    # sólo registrar (recomendado al principio)
tvlister-admin devices mode enforce    # bloquear
tvlister-admin devices mode off
```

El cambio se aplica **al instante**, sin reiniciar el servicio (el panel y el CLI comparten la
versión del registro en la tabla `settings`).

---

## 2. Cómo se identifica un aparato

1. **MAC** si el cliente la manda. Se miran todas las cabeceras y formatos que usan las apps:

   | Fuente | Ejemplo |
   | --- | --- |
   | Cabeceras | `X-MAC-Address`, `X-Device-MAC`, `X-MAC`, `X-Client-MAC`, `Mac`, `X-Stalker-MAC` |
   | Cookies (MAG/Stalker) | `Cookie: mac=00:1A:79:12:34:56` |
   | `X-User-Agent` de Stalker | `Model: MAG254; Serial: 1234567890; MAC=00:1A:79:12:34:56` |
   | `Authorization` | `Authorization: MAC 00:1A:79:12:34:56` |
   | URL / cuerpo | `?mac=…`, `mac=…` |

2. **Huella** si no hay MAC: `fp:<24 hex>` calculada con serial + modelo + `X-User-Agent` +
   `User-Agent`, **sin números de versión**: actualizar la app o cambiar de build no crea un
   aparato nuevo. El panel lo marca como `AUTO` y se puede borrar la fila si hiciera falta.

   **El reproductor interno no es un aparato.** Cuando la app reproduce, no usa su propio
   `User-Agent` sino el del motor de vídeo (`ExoPlayer`/Media3, `Lavf`/FFmpeg, `AppleCoreMedia`,
   `libVLC`, `stagefright`, `mpv`, `hls.js`…) o el de una librería HTTP (`okhttp`, `Dalvik`,
   `curl`…). Esas peticiones **no registran aparato**: un televisor es un aparato, no tres.
   Sin esto, un solo equipo gastaba varios huecos del cupo (API + manifiesto + segmentos) y la
   línea se llenaba con dos televisores aunque tuviera 5 conexiones.

Las MACs de relleno (`00:00:00:…`, `FF:FF:FF:…`) se descartan: no identifican a nadie.

### Si el cupo ya está lleno con filas antiguas

Antes de la v2.6.17 el registro podía apuntar el mismo equipo varias veces. Se juntan con:

- el botón **«Depurar duplicados»** del modal de aparatos de la línea, o
- `tvlister-admin devices dedupe [usuario] [--dry-run]`, o
- simplemente **cambiando el modo a BLOQUEAR** (el panel depura solo antes de empezar a cortar).

Se conserva la fila más antigua y nunca se toca una fila bloqueada a mano ni una con MAC distinta.

---

## 3. Qué se guarda de cada aparato

En `line_devices` (la misma tabla del bloqueo de la app propia, que sigue funcionando):

| Columna | Contenido |
| --- | --- |
| `mac` | MAC normalizada (vacía si se identificó por huella) |
| `device_id` | MAC o `fp:…` |
| `device_type` | `stb`, `enigma2`, `smart-tv`, `streaming-box`, `android-box`, `movil`, `app`, `navegador`, `dispositivo` |
| `brand`, `model` | `Infomir MAG254`, `Samsung`, `Amazon AFTMM`, `NVIDIA SHIELD`, … |
| `os` | `Android TV`, `Android`, `iOS`, `tvOS`, `webOS`, `Tizen`, `Windows`, … |
| `player` | `TiviMate`, `IPTV Smarters`, `XCIPTV`, `OTT Navigator`, `Kodi`, `VLC`, `MAG/Stalker`, `Enigma2`, … |
| `user_agent` | La cadena completa (para diagnosis) |
| `auto_registered` | 1 = entró solo; 0 = alta manual |
| `blocked` | 1 = bloqueado desde el panel |
| `seen_count` | Veces que se ha visto (se incrementa por conexión, no por segmento) |
| `first_ip`, `last_ip`, `first_seen`, `last_seen` | Red y fechas |

Estados: `active` (cuenta para el cupo), `pending` (pasó del cupo, visible pero sin cupo) y
`revoked` (liberado o vetado).

---

## 4. Cupo por línea

El cupo es, por orden:

1. `lines.device_limit`, si es mayor que 0 (se fija en el panel; máximo 20).
2. `lines.max_connections` en cualquier otro caso.

Es decir: una línea de 3 conexiones admite **3 aparatos** sin configurar nada más. Si quieres que
la línea tenga 5 conexiones simultáneas pero sólo 2 aparatos fijos, pones `device_limit = 2`.

El límite de conexiones simultáneas (`max_connections` / tabla `active_connections`) es
**independiente** y sigue funcionando como siempre: una cosa es «cuántos canales a la vez» y otra
«en cuántos aparatos».

Comprobación rápida de que el cupo cuenta equipos y no peticiones (línea de 5 conexiones):

```bash
# 5 equipos distintos → 5 filas activas; el 6.º recibe auth:0
tvlister-admin devices line CLIENTE
#   Cupo      5 aparato(s) (máx. conexiones)
#   Registrados 5 activos / 5 filas
```

---

## 5. Panel

En **Usuarios y Dispositivos**:

* Arriba, la tarjeta **Registro de aparatos**: modo (con sus tres botones), cuántos hay activos,
  cuántos se registraron solos, el reparto por tipo, las líneas por encima del cupo y un aviso en
  rojo si queda algún canal con DRM antiguo en Flussonic.
* En cada línea, el botón de aparato abre el detalle: MAC, tipo, marca/modelo, sistema,
  reproductor, IP, última vez visto, veces visto y el `User-Agent` completo. Arriba del listado
  están el **cupo** de la línea, los tres botones de modo y **«Depurar duplicados»**.
* Acciones: **Bloquear** (corta la sesión y no vuelve a entrar), **Permitir**, **Borrar** (limpia
  la fila, se vuelve a registrar al conectar) y **Limpiar todos** (olvida la línea entera).
* **Alta manual**: reservar una MAC antes de que el cliente encienda el equipo. Al conectar, esa
  fila aprende tipo, marca, modelo, sistema y reproductor.

## 6. Terminal

```bash
tvlister-admin devices dedupe            # junta duplicados de todas las líneas
tvlister-admin devices dedupe CLIENTE    # sólo una línea
tvlister-admin devices dedupe --dry-run  # enseña cuántos quitaría, sin borrar
```


```bash
tvlister-admin devices                       # resumen: modo, aparatos, por tipo, líneas sobre cupo
tvlister-admin devices mode monitor          # off | monitor | enforce
tvlister-admin devices line cliente1         # aparatos de una línea (acepta MAC abreviada)
tvlister-admin devices block cliente1 AA:BB:CC:11:22:33
tvlister-admin devices allow cliente1 AA:BB:CC:11:22:33
tvlister-admin devices reset cliente1        # olvida sus aparatos
tvlister-admin devices undrm                 # qué canales siguen con DRM en Flussonic
tvlister-admin devices undrm --apply         # quita ese bloque de Flussonic
```

La MAC se puede escribir de cualquier forma (`aa-bb-cc-11-22-33`,
`aabb.cc11.2233`, `AABBCC112233`): se normaliza.

---

## 7. API del panel

Todas requieren sesión (`Authorization: Bearer …`); las que cambian el modo, además rol `admin`.

| Método y ruta | Cuerpo | Respuesta |
| --- | --- | --- |
| `GET /api/devices/registry` | — | `{ mode, devices, active, auto, byType[], linesOverLimit[], drm_legacy[] }` |
| `POST /api/devices/registry` | `{ "mode": "enforce" }` | `{ ok, mode }` · `400` si el modo no existe |
| `GET /api/lines/:id/devices` | — | `{ line: { device_limit, device_limit_effective, max_connections, allowed }, mode, devices[] }` |
| `POST /api/lines/:id/devices` | `{ "mac": "AA:BB:CC:DD:EE:FF", "name": "TV salón" }` | `{ ok, device }` · `400` MAC inválida |
| `POST /api/lines/:id/devices/limit` | `{ "limit": 2 }` (0 = usar `max_connections`) | `{ ok, device_limit, device_limit_effective }` |
| `POST /api/lines/:id/devices/:deviceId/block` | — | `{ ok, blocked: true }` (corta la sesión) |
| `POST /api/lines/:id/devices/:deviceId/allow` | — | `{ ok }` |
| `DELETE /api/lines/:id/devices/:deviceId` | — | `{ ok, removed }` |
| `POST /api/lines/:id/devices/reset` | — | `{ ok, revoked }` |
| `POST /api/lines/:id/devices/dedupe` | `{ "dryRun": true }` (opcional) | `{ ok, removed, devices[] }` |
| `POST /api/devices/undrm` | `{ "action": "preview" }` o `"apply"` | `{ ok, action, total, cleaned, results[] }` |

`:deviceId` es la MAC o el `device_id` (`fp:…`) tal como vienen en el listado.

---

## 8. Qué ve el cliente cuando se queda fuera

`authenticateLine()` devuelve `403` con un texto claro, y ese mismo texto sale en la lista M3U y en
`player_api.php`:

| Caso | Código | Texto |
| --- | --- | --- |
| Pasa del cupo | 403 | `Esta línea admite N aparato(s) y ya hay M registrados. Libera un aparato desde el panel o pide un plan con más conexiones.` |
| Bloqueado desde el panel | 403 | `Este aparato está bloqueado en el panel. Contacta con tu proveedor.` |
| Vetado (desvinculado) | 403 | `Este aparato fue desvinculado. Contacta con tu proveedor para volver a activarlo.` |

Los reproductores que esperan JSON (`player_api.php`) reciben `{"user_info":{"auth":0,"message":"…"}}`,
que es lo que ya entienden las apps Xtream; la lista M3U recibe el texto plano.

---

## 9. Cosas que conviene saber

* **La MAC es lo que manda la app.** Si el usuario falsifica la cabecera, el panel no puede
  detectarlo: esta función evita compartir la cuenta *normalmente*, no es una barrera
  criptográfica. Para eso haría falta cifrado, y el cifrado se retiró a propósito.
* Dos televisores del mismo modelo que **no** mandan MAC comparten huella; si eso pasa, dale de
  alta su MAC a mano o pídele al cliente que use una app que la envíe.
* El registro se hace **una vez por conexión**, no por segmento HLS: la caché de 60 s evita
  escribir en la base de datos en cada `.ts`.
* Al cambiar de modo, bloquear o liberar, la caché se invalida al instante en todos los procesos.
* Si un cliente cambia de router su IP, el aparato sigue siendo el mismo (no se usa la IP para
  identificar).

---

## 10. Limpieza del DRM antiguo en Flussonic

Si algún canal tenía el bloque `drm` empujado a Flussonic, ese HLS seguiría cifrado con un servidor
de claves que ya no existe (pantalla en negro). Al migrar la base de datos se guarda la lista en el
ajuste `drm_legacy_streams`, y se quita con:

```bash
tvlister-admin devices undrm            # vista previa: qué canales y qué se enviaría
tvlister-admin devices undrm --apply    # lo quita de verdad
```

Sólo se elimina la clave `drm` del stream: se conservan `inputs`, `transcoder`, `dvr`, `protocols` y
`options` tal como estaban. El panel muestra un aviso en rojo en la tarjeta del registro mientras
quede alguno pendiente.
