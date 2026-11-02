# Integración de DRM en la app Alpha Vision — instrucciones para el agente de IA

> **Para quién es este documento:** para el agente que tiene documentada la app
> `TalaveraSama/playeralphavision` (APK `v1.2.49-channel-sync-lifecycle-preview`).
> Léelo entero antes de tocar código. Todo lo que aparece aquí está implementado y probado en el
> panel **TVLister 24/7 v2.6.1+**; los ejemplos de respuesta son salidas reales.
>
> *Nota del lado del panel:* el repositorio de la app es privado y no es accesible desde fuera, así
> que este documento **no asume** su arquitectura. La sección 1 explica cómo averiguarla en 2
> minutos y luego ve directo al caso que corresponda (Media3/ExoPlayer, Flutter, libVLC).

---

## 0. Resumen en una frase

El panel **ya no entrega claves en claro**: si un canal está cifrado, el reproductor recibe del panel
**dónde pedir la clave/licencia** y debe usarla. En HLS **AES-128** no hay que programar nada (el
motor del reproductor ya lo hace); en **Widevine** y **ClearKey** hay que conectar el `MediaDrmCallback`
a la URL que da el panel.

```
#EXTM3U
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha          ← solo canales Widevine
#KODIPROP:inputstream.adaptive.license_key=<license_url con token>
#EXTINF:-1 ...,Canal Uno
https://stream.tudominio.com/live/usuario/clave/1.m3u8
```

Y por la API que ya usa la app:

```
GET https://panel/player_api.php?username=X&password=Y&action=get_drm
```

---

## 1. Paso 0 obligatorio: identificar la pila de reproducción

Ejecuta esto **antes** de escribir nada y anota el resultado en el PR:

| Comprobación | Comando / archivo | Qué significa |
| --- | --- | --- |
| ¿Kotlin/Java nativo? | `app/build.gradle(.kts)` → `dependencies` | buscar `media3-exoplayer`, `exoplayer`, `androidx.media3` |
| ¿Qué versión? | `androidx.media3:media3-exoplayer:X.Y.Z` o `com.google.android.exoplayer:exoplayer:X.Y.Z` | **Media3 ≥ 1.0** o **ExoPlayer 2.x**: los nombres de API cambian (sección 3) |
| ¿Flutter? | `pubspec.yaml` → `media_kit`, `video_player`, `better_player` | sección 5 |
| ¿libVLC? | `org.videolan.libvlc` | sección 5 |
| ¿Ya habla Xtream? | buscar `player_api.php` en el código | si sí, el paso natural es `action=get_drm` (sección 2) |
| ¿Usa M3U? | buscar `#EXTINF` / parser de playlist | hay que añadir soporte de `#KODIPROP` (sección 4) |
| ¿Tiene reproducción offline / descarga? | buscar `Download` / `CacheDataSource` | **no** cachear claves (sección 7) |

**Criterio de éxito del paso 0:** un párrafo en el PR que diga *"la app usa X versión Y, reproduce con
Z, y ya consume la API Xtream por `player_api.php`"*.

---

## 2. El contrato del panel (lo que ya existe y responde)

Dominio del panel: el que use la app hoy. Base de vídeo: `https://stream.tudominio.com`
(o el mismo dominio del panel si no hay subdominio separado).

### 2.1 `action=get_drm` — la forma recomendada para la app

```
GET {panel}/player_api.php?username=USUARIO&password=CLAVE&action=get_drm
```

Respuesta real (canal en Widevine):

```json
{
  "drm_enabled": true,
  "line": "ruben",
  "token_ttl_seconds": 604800,
  "streams": [
    {
      "stream_id": 1,
      "source_stream_id": 1,
      "kind": "live",
      "drm_type": "widevine",
      "scheme": "widevine",
      "license_type": "com.widevine.alpha",
      "license_url": "https://stream.tudominio.com/drm/license/AbC123?t=eyJzY29wZSI6...",
      "clearkey_url": "https://stream.tudominio.com/drm/clearkey/AbC123?t=...",
      "key_url": "https://stream.tudominio.com/drm/key/AbC123?t=...",
      "requires_eme": true
    }
  ]
}
```

Mismo canal en AES-128 (HLS clásico):

```json
{
  "drm_enabled": true,
  "line": "ruben",
  "token_ttl_seconds": 604800,
  "streams": [
    {
      "stream_id": 1, "source_stream_id": 1, "kind": "live",
      "drm_type": "aes128", "scheme": "aes128",
      "license_type": "", "license_url": "",
      "clearkey_url": "https://stream.tudominio.com/drm/clearkey/AbC123?t=...",
      "key_url": "https://stream.tudominio.com/drm/key/AbC123?t=...",
      "requires_eme": false
    }
  ]
}
```

Reglas de uso:

- `drm_enabled: false` o `streams: []` ⇒ **la app funciona como hoy**, sin DRM. No hay que hacer nada.
- `stream_id` es el mismo número que devuelve `get_live_streams` (los 24/7 virtuales vienen como
  `10000 + id` y `kind: "channel247"`).
- **No hay claves en esta respuesta.** Solo URLs. Y las cabeceras secretas del servidor de licencias
  **tampoco** se envían: las inyecta el panel. La app solo tiene que hacer POST a `license_url`.
- `t` es un token firmado **por línea** y caduca a los **7 días** (`token_ttl_seconds`). Si responde
  `401`, hay que volver a llamar a `get_drm` para obtener uno nuevo (sección 6).

### 2.2 Rutas de clave (para uso interno del motor, no las llames tú salvo ClearKey)

| Ruta | Quién | Qué devuelve |
| --- | --- | --- |
| `GET /drm/key/{token}?n={número}` | el motor HLS (AES-128) | **16 bytes** de clave (binario) |
| `GET /drm/clearkey/{token}?n={número}` | la app (modo ClearKey) | JSON `{"keys":[{"kty":"oct","kid":"<32 hex>","k":"<base64url>"}],"type":"temporary"}` |
| `POST /drm/license/{token}?t={token_línea}` | la app (Widevine) | respuesta del servidor de licencias, byte a byte |
| `GET /drm/cas/{token_cas}` | **Flussonic**, nunca la app | clave del cifrador (no la llames) |

Códigos de error, iguales en todas:

| Código | Significado | Qué debe hacer la app |
| --- | --- | --- |
| `401` | token de línea caduco/manipulado | refrescar con `get_drm` **una vez**; si vuelve a fallar → "sesión vencida" |
| `403` | línea suspendida / IP no permitida | mensaje "línea no válida"; **no** reintentar en bucle |
| `404` | canal sin DRM o token de canal rotado | recargar playlist; si persiste, soporte |
| `503` | el panel apagó el DRM global | mensaje genérico; no reintentar más de 1 vez |

---

## 3. Caso A — Media3 / ExoPlayer (lo más probable en una app Android IPTV)

### 3.1 AES-128: **cero código** (pero hay que verificar tres cosas)

ExoPlayer/Media3 descifra AES-128 solo, leyendo `#EXT-X-KEY` del manifiesto. Lo único que puede
romperlo es la propia app:

1. **No interceptar ni reescribir el manifiesto** quitando `#EXT-X-KEY`. Si hay un
   `ResolvingDataSource`/`DataSource` propio que limpia líneas, hay que dejarlas pasar.
2. **No truncar query strings** en URLs firmadas. Las claves viajan como
   `/drm/key/{token}?n=3`; si el `DataSource` reconstruye la URL sin query, todo falla con `403`.
3. **No bloquear por `Content-Type`**: la clave se sirve como `application/octet-stream` (16 bytes).

Verificación en el dispositivo (5 min):

```bash
adb logcat | grep -iE "Aes128|EXT-X-KEY|Unable to load key|DrmSession"
```

Debe aparecer tráfico a `/drm/key/...` y **no** debe aparecer `Unable to load key ... 403`.

### 3.2 Widevine: conectar el `DrmSessionManager`

Patrón recomendado (Media3 ≥ 1.0; en ExoPlayer 2.x ver nota al final):

```kotlin
// 1) Fuente de datos normal de la app
val dataSourceFactory = DefaultHttpDataSource.Factory()
    .setUserAgent("AlphaVision/1.2.49")
    .setAllowCrossProtocolRedirects(true)

// 2) Callback que va a la URL que dio el panel (¡con su ?t=... intacto!)
fun drmCallback(licenseUrl: String): MediaDrmCallback =
    HttpMediaDrmCallback(licenseUrl, dataSourceFactory)   // hace POST del challenge

// 3) Manager Widevine (multi-key: los canales con rotación usan varias KID)
val drmManager = DefaultDrmSessionManager.Builder()
    .setUuidAndExoMediaDrmProvider(C.WIDEVINE_UUID, FrameworkMediaDrm.DEFAULT_PROVIDER)
    .setMultiSession(true)          // si un canal rota clave, no se cae
    .setPlayClearSamplesWithoutKeys(true)  // no bloquear el arranque mientras llega la licencia
    .build(drmCallback(licenseUrl))

// 4) Factory + item
val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
    .setDrmSessionManagerProvider { drmManager }

val item = MediaItem.Builder()
    .setUri(streamUrl)                       // .../live/usuario/clave/1.m3u8
    .setMimeType(MimeTypes.APPLICATION_M3U8)
    .setDrmConfiguration(
        MediaItem.DrmConfiguration.Builder(C.WIDEVINE_UUID)
            .setLicenseUri(licenseUrl)       // "license_url" del JSON
            .setMultiSession(true)
            .build()
    )
    .build()

val player = ExoPlayer.Builder(context)
    .setMediaSourceFactory(mediaSourceFactory)
    .build()
player.setMediaItem(item)
player.prepare()
```

Notas que suelen costar horas:

- **Una URL de licencia por canal.** No hay una global: cada canal cifrado tiene su token. Guarda el
  mapa `stream_id → license_url` que devolvió `get_drm` y úsalo al abrir el canal.
- Si el player es **reutilizado entre canales** (lo normal en IPTV), crea un `DrmSessionManager` por
  canal o usa un `DrmSessionManagerProvider` que lo resuelva por `MediaItem`:
  `provider = { item -> managers[item.mediaId] }` (guarda `stream_id` en `mediaId`).
- **Cabeceras**: hoy no hacen falta (el panel inyecta las del proveedor). Si algún día el panel pide
  una, se añade con `HttpMediaDrmCallback#setKeyRequestProperty("X-...", "...")` y **no** hay que
  meterla en el APK.
- **ExoPlayer 2.x**: `DefaultDrmSessionManager(uuid, mediaDrmProvider, callback, null, null)` y
  `DefaultMediaSourceFactory(context).setDrmSessionManagerProvider(provider)`. Mismos conceptos.
- **Canal no cifrado con `DrmConfiguration` puesta**: fallará. Solo añadir `DrmConfiguration` si
  `requires_eme == true` para ese `stream_id`.

### 3.3 ClearKey (opcional; solo si se quiere para pruebas)

`HttpMediaDrmCallback` hace POST, y el endpoint ClearKey del panel es **GET con JSON**. Dos opciones:

```kotlin
// Opción 1 (recomendada): pedir el JSON y pasarlo como licencia local
val json = okHttp.get(clearkeyUrl).body!!.string()   // {"keys":[{"kty":"oct","kid":"..","k":".."}]}
val callback = LocalMediaDrmCallback(json.toByteArray())

// Opción 2 (sin dependencias): MediaDrmCallback propio de 15 líneas
class GetKeyCallback(private val url: String) : MediaDrmCallback {
    override fun executeKeyRequest(uuid: UUID, request: ExoMediaDrm.KeyRequest): ByteArray =
        okHttp.get(url).body!!.bytes()
    override fun executeProvisionRequest(uuid: UUID, request: ExoMediaDrm.ProvisionRequest): ByteArray =
        throw UnsupportedOperationException()
}
```

Después, igual que Widevine pero con `C.CLEARKEY_UUID` y `requires_eme` del canal.

---

## 4. Caso B — lista M3U (si la app se alimenta de playlist)

El parser **tiene que leer `#KODIPROP`**, que aparece **antes** del `#EXTINF` de ese canal:

```
#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha
#KODIPROP:inputstream.adaptive.license_key=https://stream.tudominio.com/drm/license/AbC123?t=...
#EXTINF:-1 tvg-chno="1" tvg-name="Canal Uno" group-title="Canales en Vivo",Canal Uno
https://stream.tudominio.com/live/usuario/clave/1.m3u8
```

Reglas del parser:

- Las directivas se aplican al `#EXTINF` **siguiente**, y se **resetean** después de usarlas (si no,
  todos los canales heredan la licencia del primero: este bug es clásico).
- `license_key` puede traer `|Header=Valor|` añadidos por otros paneles: corta por `|` y quédate con
  la URL. TVLister no los usa.
- Si no hay `#KODIPROP`, el canal se reproduce normal (AES-128 lo gestiona el motor).
- No filtres las líneas que empiezan por `#` al construir el mapa de canales: hoy las ignoras y con
  eso pierdes el DRM.

---

## 5. Caso C — Flutter / libVLC

- **libVLC**: soporta AES-128 y Widevine por `:drm` y `:widevine-license-uri`? Sólo en algunas builds.
  Camino seguro: reproducir **AES-128** (transparente) y dejar Widevine para Media3/WebView EME. Si
  hay que hacerlo con VLC: `mediaPlayer.media.addOption(":http-referrer=...")` no basta para DRM;
  documenta la limitación en el PR en vez de inventar.
- **media_kit / video_player**: ambos acaban en ExoPlayer en Android; pasar
  `httpHeaders`/`drmConfig` según el plugin. Si el plugin no expone DRM, la opción es Media3 nativo
  con un `TextureView`/`SurfaceView` embebido.
- **WebView + Shaka Player** (si la app ya usa WebView): `player.configure({ drm: { servers: {
  'com.widevine.alpha': licenseUrl } } })`. Shaka acepta la URL con `?t=` tal cual.

En cualquiera de estos casos: **si el canal es AES-128 se puede lanzar ya sin cambios**, y Widevine
se planifica como fase 2.

---

## 6. Refresco de tokens (obligatorio)

- `get_drm` devuelve un token firmado por línea con **7 días** de vida.
- Al abrir la app (y como mucho cada 12 h) refresca el mapa `stream_id → {license_url, clearkey_url}`.
- Si una petición de clave/licencia responde **401**:
  1. llamar a `get_drm` una vez,
  2. reintentar la reproducción **una** vez,
  3. si vuelve a fallar, mostrar "Sesión vencida, vuelve a iniciar sesión" y no insistir.
- **Nunca** reintentar en bucle: el panel registra cada intento y se llena el log.

---

## 7. Reglas de seguridad para la app (no negociables)

1. **No** guardar claves ni licencias en disco/preferencias/logs. En memoria y a volar.
2. **No** escribir `license_url` completa en logs de producción (lleva el token de la línea).
   Si hace falta depurar: `license_url.take(40) + "…"`.
3. **No** desactivar la verificación de clave del manifiesto ni "saltar" `EXT-X-KEY`.
4. **No** incrustar cabeceras ni secretos del servidor de licencias en el APK: los pone el panel.
5. Usar siempre **HTTPS** para panel y streams (el video por el subdominio de streams, nunca por el
   proxy naranja de Cloudflare).
6. Si la app tiene **descargas offline**: no descargar canales con `requires_eme: true` (Widevine
   persistente requiere licencia offline, que este panel no emite todavía). Documentarlo en la UI.

---

## 8. Pruebas de aceptación (lo que el agente debe demostrar)

Servidor de pruebas con DRM ya activo en un canal. Pide acceso al panel para verificar el otro lado.

| # | Prueba | Cómo se comprueba | Debe dar |
| --- | --- | --- | --- |
| 1 | `get_drm` sin DRM | `curl` a la acción con una línea normal | `{"drm_enabled":false,"streams":[]}` y la app reproduce igual que antes |
| 2 | `get_drm` con DRM | idem en un canal protegido | JSON con `license_url` y `token_ttl_seconds` |
| 3 | AES-128 | abrir el canal cifrado | reproduce **sin cambios** en el código; `adb logcat` sin `Unable to load key` |
| 4 | Widevine | abrir el canal Widevine | reproduce; en el panel aparece una entrega `license` con la IP del dispositivo |
| 5 | Token caducado | pedir con `?t=basura` | `401` → la app refresca y reproduce |
| 6 | Línea suspendida | suspender la línea en el panel | `403`, mensaje claro, sin bucle |
| 7 | Playlist con `#KODIPROP` | cargar la M3U | el canal 1 toma la licencia y el canal 2 (sin `#KODIPROP`) no |
| 8 | Zapping | cambiar entre 5 canales, 3 cifrados | sin fugas de memoria, sin `pantalla negra`, sin reiniciar el player |
| 9 | Rotación de clave | 20 min reproduciendo | no se corta (Flussonic rota cada 10 min) |

Comprobaciones del lado del panel (pídelas a quien administra):

```bash
tvlister-admin drm log 40        # debe mostrar 'license' y 'key' con la IP del dispositivo
tvlister-admin drm test 1        # clave de 16 bytes y rotación correcta
```

**Definición de terminado:** las 9 pruebas en verde, sin claves ni tokens en los logs, y un canal
AES-128 reproduciendo con el mismo código de antes (sin regresiones).

---

## 9. Prompt listo para pegar en el agente que tiene la app

```
Contexto: el panel TVLister 24/7 ya implementa DRM (v2.6.1+). La app Alpha Vision
(playeralphavision v1.2.49-channel-sync-lifecycle-preview) tiene que consumirlo.

Tarea 1 (descubrimiento, sin cambios de código): identifica la pila de reproducción
(Media3/ExoPlayer y versión, Flutter+media_kit, libVLC o WebView) y si ya consume
/player_api.php. Resúmelo en el PR antes de tocar nada.

Tarea 2 (AES-128, primero): garantiza que la app reproduce HLS AES-128 sin cambios.
Revisa que ningún DataSource/parser propio elimine las líneas #EXT-X-KEY ni las query
strings de las URLs de clave (/drm/key/<token>?n=<n>). Prueba con el canal cifrado
en AES-128: debe reproducir igual que antes.

Tarea 3 (Widevine): consume GET /player_api.php?...&action=get_drm, guarda el mapa
stream_id -> license_url, y para los canales con requires_eme=true monta
DefaultDrmSessionManager con HttpMediaDrmCallback(license_url), multiSession y
playClearSamplesWithoutKeys. Un DrmSessionManager por canal; los canales sin DRM
no llevan DrmConfiguration.

Tarea 4 (tokens): refresca get_drm al abrir la app y cada 12 h. Si una petición de
clave/licencia responde 401, refresca una vez, reintenta una vez, y si falla muestra
"Sesión vencida". Nada de reintentos en bucle. Trata 403 como línea inválida.

Tarea 5 (playlist M3U): si la app también carga M3U, implementa el parseo de
#KODIPROP (license_type / license_key) aplicado al #EXTINF siguiente y reseteado
después de cada canal. Corta license_key por "|" y quédate con la URL.

Prohibido: cachear claves o licencias en disco, loguear la URL de licencia completa,
incrustar cabeceras secretas, modificar el manifiesto para quitar EXT-X-KEY,
descargar offline canales Widevine, o desactivar la verificación de clave.

Aceptación: las 9 pruebas de docs/INTEGRACION_DRM_APP.md (sección 8) en verde y
ningún secreto en logs. Entrega: PR con el resumen de la pila detectada, diff,
capturas de logcat sin "Unable to load key" y nota de qué canales quedan en AES-128
y cuáles en Widevine.
```

---

## 10. Lo que NO hace el panel (para que el agente no lo pida)

- **No** emite licencias Widevine propias: hace de **proxy** hacia el servidor de licencias del
  operador (o hacia tu cuenta de un proveedor tipo Axinom/EZDRM/BuyDRM). Sin keyserver Widevine no
  hay Widevine, ni en la app ni en ningún reproductor.
- **No** firma licencias offline (descargas persistente) todavía.
- **No** entrega claves por un endpoint administrativo distinto de los de arriba, y no las escribe en
  el log (solo canal, número, IP y resultado).
- **PlayReady no aplica en Android**: usa Widevine. (El panel sí puede configurarlo para clientes
  Windows/Xbox.)
