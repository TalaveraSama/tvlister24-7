# Indicaciones para el desarrollador de la app — seguridad del player y del panel

**Para:** desarrollo de `playeralphavision` (base actual `v1.2.49-channel-sync-lifecycle-preview`)
**Objetivo:** `v1.2.50` con seguridad cerrada. Compatible hacia atrás: si la app no hace nada de
esto, sigue funcionando igual; lo que se pierde es el control por aparato y el bloqueo inmediato.
**Panel:** TVLister 24/7 `v2.6.5` o superior.

> Regla de oro: **la app nunca es la fuente de verdad**. Todo lo que decide si se reproduce o no
> (línea activa, vencimiento, paquetes, conexiones, aparatos) lo decide el panel. La app sólo
> obedece los códigos de error y no intenta «arreglarlos» por su cuenta.

---

## 1. Lo que ya cambió en el panel (y afecta a la app)

| # | Antes | Ahora (v2.6.5) | Qué tiene que hacer la app |
| --- | --- | --- | --- |
| 1 | `/live/...` y `player_api.php` aceptaban intentos de contraseña sin límite | 20 fallos por IP en 10 min ⇒ `429` durante 10 min | Leer `Retry-After` y **no** reintentar en bucle |
| 2 | No había forma de atar una línea a un aparato | `action=register_device` + `X-Device-Token` | Registrar el aparato una vez y mandar la cabecera |
| 3 | Desvincular = cambiar la contraseña a todos | `action=unlink_device` y panel con «Desvincular» | Ofrecer «Desvincular este aparato» en ajustes |
| 4 | La app podía pedir licencias DRM | **retirado**: `action=get_drm` ya no existe | Quitar la llamada; el video va sin cifrar |
| 5 | Vista previa del panel aceptaba cualquier token | ahora exige admin | No aplica a la app (no usar `/api/admin/*`) |
| 6 | CORS del panel reflejaba cualquier origen | sólo mismo host / lista blanca | No aplica (la app es nativa, no manda `Origin`) |

Los endpoints Xtream (`/player_api.php`, `/get.php`, `/xmltv.php`, `/live/`, `/movie/`, `/series/`)
siguen con el mismo contrato. **No hay que reescribir el reproductor.**

---

## 2. Datos que la app debe guardar y cómo

| Dato | ¿Se guarda? | Dónde | TTL |
| --- | --- | --- | --- |
| `username` | Sí | `EncryptedSharedPreferences` | mientras haya sesión |
| `password` | Sí (Xtream la exige en cada llamada) | `EncryptedSharedPreferences` | mientras haya sesión |
| `device_token` | Sí | `EncryptedSharedPreferences` | 30 días |
| `device_id` | Sí (estable) | `EncryptedSharedPreferences` + copia en `SharedPreferences` para sobrevivir a la reinstalación del keystore | permanente |
| Claves DRM / `key_url` | **No** | — | ya no existen: el video no va cifrado |

Reglas:

1. **Nunca** `SharedPreferences` en claro, ni `Log.d`, ni `println`, ni nombres de fichero con el
   usuario dentro.
2. **Nunca** imprimir la URL de reproducción completa: puede llevar el token de la línea.
3. Si el usuario cierra sesión, borrar `device_token` y las credenciales, pero **conservar
   `device_id`** para que al volver no se coma una segunda plaza de aparato.
4. `android:allowBackup="false"` (o `dataExtractionRules` excluyendo el fichero cifrado), para que
   las credenciales no viajen en un backup a otro teléfono.

Snippet mínimo (AndroidX Security):

```kotlin
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

private fun securePrefs(context: Context) =
    EncryptedSharedPreferences.create(
        context,
        "session_secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
```

---

## 3. Identificador de aparato (`device_id`)

Formato obligatorio (lo valida el panel): **8 a 128 caracteres** de `A-Z a-z 0-9 . _ : -`.
Si no cumple, el panel responde `400 device_invalid`.

Recomendado (estable, no cambia al reiniciar ni al actualizar la app):

```kotlin
fun deviceId(context: Context): String {
    val prefs = securePrefs(context)
    prefs.getString("device_id", null)?.let { return it }
    val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    val raw = "PlayerAlphavision:$androidId"           // estable por instalación de Android
    val hashed = MessageDigest.getInstance("SHA-256")
        .digest(raw.toByteArray()).joinToString("") { "%02x".format(it) }
        .take(40)
    val id = "PA-$hashed"                              // 3 + 40 = 43 caracteres válidos
    prefs.edit().putString("device_id", id).apply()
    return id
}
```

- **No** usar `Settings.Secure.ANDROID_ID` crudo (puede considerarse identificador personal) ni el
  ID de publicidad, ni IMEI/MAC (en Android 10+ no están disponibles).
- **No** usar un ID aleatorio que se regenere en cada arranque: cada arranque gastaría una plaza de
  aparato y el cliente se quedaría bloqueado.
- El panel guarda: `device_id`, nombre del modelo, plataforma, versión de la app, IP y fechas.
  **Nada más** (ni contactos, ni ubicación, ni cuentas).

---

## 4. Registro del aparato

Se hace **una vez por instalación** (y otra vez si el panel lo revoca y el cliente lo vuelve a
vincular). Es idempotente: repetirlo con el mismo `device_id` renueva el token.

```
POST/GET  {base}/player_api.php
  username=...&password=...
  &action=register_device
  &device_id=PA-<hash>                  (obligatorio)
  &device_name=Pixel 7                  (opcional, se muestra en el panel)
  &platform=Android 14                  (opcional)
  &app_version=1.2.50                   (opcional, útil para soporte)
```

Respuesta correcta (`200`):

```json
{
  "auth": 1,
  "registered": true,
  "device": { "device_id": "PA-...", "device_name": "Pixel 7", "platform": "Android 14",
              "app_version": "1.2.50", "status": "active", "ip": "190.0.0.1",
              "first_seen": "2026-11-02 02:14:09", "last_seen": "2026-11-02 02:14:09" },
  "device_token": "eyJzY29wZSI6ImRldmljZSIs...",
  "token_ttl_seconds": 2592000,
  "device_limit": 1,
  "device_lock": true,
  "active_cons": "1",
  "max_connections": "2"
}
```

Errores posibles (cuerpo JSON con `auth: 1` y `registered: false`):

| HTTP | `error` | Significado | Qué debe hacer la app |
| --- | --- | --- | --- |
| 400 | `device_invalid` | El `device_id` no cumple el formato | Corregir el ID (error de programación, no reintentar) |
| 403 | `device_limit` | La línea ya tiene sus aparatos (`device_limit`) | Mostrar «Tu cuenta ya está en uso en otro aparato» + botón de soporte |
| 403 | `device_revoked` | El panel dio de baja **este** aparato | Bloquear reproducción y pedir al cliente que contacte con su proveedor |

`device_lock = true` significa que esa línea **exige** la cabecera `X-Device-Token` para reproducir.
`device_lock = false` (por defecto) significa que la app debe registrar el aparato pero la
reproducción sigue funcionando sin cabecera.

---

## 5. Cabecera en cada petición de reproducción

Con `device_lock = true`, **todo** lo que pida la app de `/live`, `/movie` y `/series` —manifiesto
**y segmentos**— debe llevar la cabecera:

```
X-Device-Token: <device_token>
```

Equivalentes aceptados: `Authorization: Device <device_token>` y, para clientes que no pueden poner
cabeceras, `?device_token=<token>` (sólo en la petición del manifiesto; los segmentos son relativos,
así que **si el reproductor no puede mandar cabeceras, esa línea no debe activar `device_lock`**).

ExoPlayer (así se manda en manifiesto y segmentos a la vez):

```kotlin
fun playerWithDeviceToken(context: Context, url: String, deviceToken: String): ExoPlayer {
    val headers = mapOf(
        "X-Device-Token" to deviceToken,
        "User-Agent" to "PlayerAlphavision/${BuildConfig.VERSION_NAME} " +
                        "(Android ${Build.VERSION.RELEASE}; ${Build.MODEL})"
    )
    val http = DefaultHttpDataSource.Factory()
        .setDefaultRequestProperties(headers)
        .setConnectTimeoutMs(8_000)
        .setReadTimeoutMs(12_000)
    val hls = HlsMediaSource.Factory(DefaultDataSource.Factory(context, http))
    return ExoPlayer.Builder(context)
        .setMediaSourceFactory(hls)
        .build()
        .apply { setMediaItem(MediaItem.fromUri(url)); prepare(); playWhenReady = true }
}
```

Respuestas de error si el token falta o no vale:

| HTTP | `error` | Qué debe hacer la app |
| --- | --- | --- |
| 403 | `device_required` | No hay token guardado → llamar a `register_device` y reintentar **una** vez |
| 403 | `device_invalid` | Token corrupto → borrar token y `register_device` una vez |
| 403 | `device_revoked` | Parar reproducción, limpiar token, mostrar aviso de soporte |

---

## 6. Latido (`heartbeat`) — 90 s mientras haya reproducción

Sirve para dos cosas: que el panel sepa que el aparato sigue vivo y que la app se entere **en el
acto** de una baja o de un vencimiento, sin esperar a que falle el siguiente canal.

```
GET {base}/player_api.php?username=..&password=..&action=heartbeat
Header: X-Device-Token: <token>
```

Respuesta `200`:

```json
{ "auth": 1, "status": "active", "exp_date": "1798761600", "server_time": 1793585649,
  "device": { "device_id": "PA-...", "status": "active", "last_seen": "..." },
  "active_cons": "1", "max_connections": "2", "device_lock": true }
```

Reglas de la app:

- Latir cada **90 s** con la reproducción activa y **una vez al volver del segundo plano**.
- Si `status != "active"` → cerrar sesión y mostrar «Cuenta suspendida».
- Si `exp_date` ya pasó (comparar con `server_time`, no con el reloj del teléfono) → «Suscripción
  vencida». No usar el reloj local: un teléfono con la hora mal no debe abrir contenido vencido.
- `403 device_revoked` → parar ya, limpiar token, mensaje de contacto.
- `429` → respetar `Retry-After` y volver a latir al doble de intervalo. **Nunca** reintentar en
  bucle cerrado.
- El latido **no** cuenta como conexión de reproducción: no lo uses para «reservar» pantalla.

---

## 7. Desvincular desde la app

En Ajustes → «Desvincular este aparato»:

```
GET {base}/player_api.php?username=..&password=..&action=unlink_device&device_id=<device_id>
Header: X-Device-Token: <token>
```

Respuesta: `{ "auth": 1, "unlinked": true, "device_id": "PA-..." }`. Después: borrar token,
volver al login. Este aparato **puede volver a registrarse** sin intervención del proveedor; si en
cambio lo da de baja el panel, ese aparato queda vetado y hay que pedir que lo «permitan de nuevo».

---

## 8. Reproducción: URLs y qué no tocar

| Contenido | URL (sin cambios respecto a hoy) |
| --- | --- |
| Canal | `{base}/live/{user}/{pass}/{stream_id}.m3u8` (o `.ts`) |
| Película | `{base}/movie/{user}/{pass}/{vod_id}.mp4` |
| Episodio | `{base}/series/{user}/{pass}/{episode_id}.mp4` |
| Catch-up | el que devuelva `get_short_epg` / `tv_archive` en `player_api.php` |

- No construir URLs con dominios adivinados ni con IPs fijas: **siempre** el `server_info.url` +
  `server_info.port` que devuelve `player_api.php` (o el host que el usuario escribió).
- No reutilizar una URL firmada de la WebTV (`/webtv_play/...`): es de un solo navegador, caduca en
  6 h y va atada a esa sesión web. La app usa `/live/`, que no caduca.
- `503 Canal sin fuente configurada` = el panel no tiene origen para ese canal ahora mismo. No es un
  error de la app: mostrar «Canal temporalmente no disponible», no reintentar 50 veces.

---

## 9. Códigos de error que la app tiene que distinguir

| HTTP / cuerpo | Significado | Acción correcta |
| --- | --- | --- |
| `auth: 0`, «Usuario o contraseña inválidos» | Credenciales malas | Mostrar error, **no** reintentar automáticamente |
| `auth: 0` con `error: "rate_limited"` + `Retry-After` | Demasiados fallos desde esa IP | Esperar lo que diga `Retry-After`; deshabilitar el botón mientras |
| `401` `/live/` | Credenciales malas | Igual que arriba |
| `403` «Línea suspendida o bloqueada» | Panel suspendió la línea | Cerrar sesión y avisar |
| `403` «Suscripción expirada» | Vencida | Cerrar sesión y avisar |
| `403` «IP no autorizada» | Línea con IP fija y el cliente cambió de red | Avisar: «esta cuenta sólo funciona en la red contratada» |
| `403` `device_required` / `device_invalid` / `device_revoked` | Ver §5 | Ver §5 |
| `429` «Límite máximo de conexiones simultáneas» | `max_connections` | Cerrar el player anterior; nunca abrir dos a la vez |
| `503` «Canal sin fuente» | Sin origen en el panel | Mensaje neutro, sin reintentos rápidos |

---

## 10. Límites y multi-pantalla

- El panel cuenta **conexiones activas** por línea (`max_connections`) y **aparatos** por línea
  (`device_limit`, de 1 a 20). Son dos límites distintos: el primero es «cuántos canales a la vez»,
  el segundo es «en cuántos teléfonos».
- La app debe cerrar el reproductor al salir de la pantalla (`onStop` → `player.release()`), y
  **liberar** la sesión. Si no, el panel ve conexiones fantasma y el cliente se bloquea solo.
- Una sola instancia de `ExoPlayer` por pantalla; nada de `preload` de varios canales a la vez.
- Al cambiar de canal, liberar antes de preparar el nuevo (evita el `429` de conexiones).

---

## 11. DRM: retirado (ya no hay canales cifrados)

> **v2.6.15 — el DRM se ha eliminado del producto.** No hay AES-128, ni ClearKey, ni licencias
> Widevine/PlayReady, ni `action=get_drm`: esa acción ya no existe: `/drm/*` y `action=get_drm` responden **410 Gone**
> con `error: "drm_retired"`. Si tu
> app la llama, recibe error: quita esa llamada.
>
> La protección actual es el **registro de aparatos por MAC**: no cambia nada en el reproductor. La
> app sigue pidiendo `/live/{user}/{pass}/{id}.m3u8` como siempre; si el aparato pasa del cupo de
> la línea, el panel responde `403` con un texto explicativo. Detalle completo en
> [`REGISTRO_APARATOS_MAC.md`](REGISTRO_APARATOS_MAC.md).

## 12. Almacenamiento y red: lo que la app debe cumplir

```xml
<!-- AndroidManifest.xml -->
<application android:allowBackup="false"
             android:usesCleartextTraffic="false"
             android:networkSecurityConfig="@xml/network_security_config" ...>
```

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system"/></trust-anchors>
  </base-config>

  <!-- Pinning SOLO del dominio del panel. Dos pines: el actual y el de respaldo.
       `expiration` obligatorio y <= 12 meses; renovar el respaldo antes. -->
  <domain-config>
    <domain includeSubdomains="false">tv.tu-dominio.com</domain>
    <pin-set expiration="2027-06-30">
      <pin digest="SHA-256">PIN_ACTUAL_BASE64</pin>
      <pin digest="SHA-256">PIN_RESPALDO_BASE64</pin>
    </pin-set>
  </domain-config>
</network-security-config>
```

Calcular los pines contra el certificado real del panel:

```bash
openssl s_client -servername tv.tu-dominio.com -connect tv.tu-dominio.com:443 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | openssl enc -base64
```

- Pinning con **dos** pines y `expiration`: un pin único es una bomba de relojería (cuando cambia el
  certificado, la app deja de conectar para todos y no hay forma de arreglarlo sin actualizar).
- Nunca `TrustManager` que acepte todo, ni `HostnameVerifier` que devuelva `true`, ni
  `android:debuggable` en release.
- Login **sin WebView**: la app habla con `player_api.php`, no carga el panel.

---

## 13. Lo que la app no debe hacer (auditoría rápida)

- [ ] No hay usuario/contraseña ni token en `Log.*`, Crashlytics, analítica ni nombres de fichero.
- [ ] No hay dominio del panel escrito a mano (todo viene del login del usuario).
- [ ] No se llama a `/api/*` del panel (eso es la API de administración; la app es cliente).
- [ ] No se descarga ni se usa `/webtv_play/...`; la app usa `/live/`, `/movie/`, `/series/`.
- [ ] No hay `TrustManager` permisivo, ni `cleartextTrafficPermitted="true"`.
- [ ] No se comparten tokens entre instalaciones ni se copian de un teléfono a otro.
- [ ] R8/ProGuard activo en release; nada de nombres de clases con «Premium», «Bypass» o similares.
- [ ] Sin claves, sin `kid`, sin credenciales de Flussonic dentro del APK.

Recomendado (opcional, no bloquea): `WindowManager.LayoutParams.FLAG_SECURE` en la pantalla de
reproducción y **Play Integrity API** para descartar APKs repackeados, enviando el veredicto a tu
propio backend si algún día quieres bloquear.

---

## 14. Pruebas de aceptación (la app debe pasar esto antes de entregar)

Sustituye `{base}`, `{user}`, `{pass}` por los de una línea de pruebas.

| # | Prueba | Resultado esperado |
| --- | --- | --- |
| 1 | `register_device` con `device_id` válido | `200`, `registered:true`, `device_token` presente |
| 2 | Repetir el registro con el mismo `device_id` | `200` y token nuevo (el viejo deja de valer) |
| 3 | Registrar un segundo `device_id` con `device_limit: 1` | `403 device_limit` |
| 4 | `heartbeat` con el token | `200`, `active_cons`, `exp_date`, `device_lock` |
| 5 | `heartbeat` sin cabecera | `400 device_token_required` |
| 6 | `heartbeat` con token manipulado | `401 device_invalid` |
| 7 | Panel desvincula el aparato → `heartbeat` | `403 device_revoked` |
| 8 | Línea con `device_lock` activo, `/live` sin cabecera | `403 device_required` |
| 9 | Línea con `device_lock` activo, `/live` con cabecera | reproduce (o `503` si el canal no tiene origen) |
| 10 | `unlink_device` y volver a `register_device` | vuelve a vincularse sin tocar el panel |
| 11 | 21 contraseñas malas seguidas | la 21 devuelve `429` + `Retry-After` |
| 12 | Cerrar y abrir la app | no vuelve a registrar (mismo `device_id`) y no duplica plazas |
| 13 | Reproducir 2 canales con `max_connections: 1` | el segundo da `429` (límite de conexiones) |
| 14 | Matar la app mientras reproduce | la conexión desaparece del panel en < 2 min |
| 15 | Cambiar la hora del teléfono +1 año | la app sigue usando `server_time`/`exp_date` del panel |

Comandos de referencia (desde una terminal, contra el panel real):

```bash
BASE="https://tv.tu-dominio.com"

# registro
curl -s "$BASE/player_api.php?username=$U&password=$P&action=register_device\
&device_id=PA-test0001&device_name=Prueba&platform=Android&app_version=1.2.50"

# latido
curl -s "$BASE/player_api.php?username=$U&password=$P&action=heartbeat" \
     -H "X-Device-Token: $TOKEN"

# reproducción con bloqueo activo
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/live/$U/$P/1.m3u8" -H "X-Device-Token: $TOKEN"

# fuerza bruta (debe acabar en 429)
for i in $(seq 1 22); do
  printf '%s ' "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/get.php?username=$U&password=mala&type=m3u_plus")"
done; echo
```

---

## 15. Panel: qué queda de tu lado (administración)

Nada de esto lo debe hacer la app; es la parte del operador:

1. *Usuarios y Dispositivos* → botón del teléfono en cada línea: aparatos vinculados, activar
   «Exigir aparato vinculado», fijar cuántos, desvincular uno (veto) o todos (reset).
2. **No** activar «Exigir aparato vinculado» en líneas que se usen en TV/VLC/Smart TV que no puedan
   mandar `X-Device-Token`: quedarían sin reproducir. La lista M3U y `get.php` **no** se ven
   afectados por el bloqueo, pero la reproducción sí.
3. Al desvincular, el panel corta las sesiones abiertas de esa línea.
4. Los límites de intentos son por IP: si muchos clientes salen por la misma IP pública (CGNAT o un
   proveedor grande), 20 fallos de uno pueden frenar 10 min a los demás de esa IP. En ese escenario,
   subir el umbral es cambiar `CRED_FAIL_MAX` en `server/auth.js`.

---

## 16. Orden de trabajo sugerido para `v1.2.50`

1. `device_id` estable + `register_device` al primer arranque tras login (guardando el token).
2. `X-Device-Token` en el `DataSource` de ExoPlayer (manifiesto **y** segmentos).
3. Manejo de `403 device_*`, `429` con `Retry-After` y `503` con mensajes distintos.
4. `heartbeat` cada 90 s y al volver de segundo plano; usar `server_time`/`exp_date` del panel.
5. «Desvincular este aparato» en Ajustes.
6. HTTPS obligatorio + pinning con dos pines y `expiration`.
7. Limpieza de logs/analítica y revisión de la checklist de §13.
8. Pasar la tabla de §14 y adjuntar la salida al entregar.

### Prompt para pegarle al desarrollador

> Necesito que `playeralphavision` v1.2.50 implemente el contrato de seguridad del panel TVLister
> descrito en `docs/SEGURIDAD_PLAYER_APP_INDICACIONES.md`. En resumen: (1) `device_id` estable y
> `action=register_device` una vez por instalación, guardando `device_token` en
> `EncryptedSharedPreferences`; (2) cabecera `X-Device-Token` en **todas** las peticiones de
> `/live`, `/movie` y `/series`, incluidos los segmentos, configurada en el
> `DefaultHttpDataSource.Factory` de ExoPlayer; (3) `action=heartbeat` cada 90 s y al volver del
> segundo plano, obedeciendo `403 device_revoked`, `403 device_revoked/device_limit`,
> `429 Retry-After` y usando `server_time`/`exp_date` del panel en vez del reloj local; (4)
> `action=unlink_device` en Ajustes; (5) HTTPS obligatorio con certificate pinning de dos pines y
> `expiration`, sin `TrustManager` permisivo; (6) ningún log, analítica ni backup con credenciales o
> tokens. No cambies las URLs de reproducción ni implementes DRM propio: `/live` sigue igual y el
> panel no cifra el video. Antes de entregar, pasa la tabla de pruebas de §14 y mándame la salida.

---

## Apéndice A — Contrato resumido (para copiar en el proyecto)

```
POST/GET /player_api.php?username&password&action=register_device
         &device_id&device_name&platform&app_version
  200 { auth:1, registered:true, device_token, token_ttl_seconds, device_limit, device_lock,
        active_cons, max_connections, device{...} }
  400 device_invalid | 403 device_limit | 403 device_revoked

GET /player_api.php?username&password&action=heartbeat
    Header: X-Device-Token
  200 { auth:1, status, exp_date, server_time, device, active_cons, max_connections, device_lock }
  400 device_token_required | 401 device_invalid | 403 device_revoked

GET /player_api.php?username&password&action=unlink_device&device_id[|Header X-Device-Token]
  200 { auth:1, unlinked, device_id }

GET /live/{user}/{pass}/{id}.m3u8   Header: X-Device-Token (si device_lock)
GET /movie/{user}/{pass}/{id}.mp4   Header: X-Device-Token (si device_lock)
GET /series/{user}/{pass}/{id}.mp4  Header: X-Device-Token (si device_lock)
  403 device_required | device_invalid | device_revoked
  403 device_limit     (la línea ya tiene su cupo de aparatos registrados)
  403 device_blocked   (ese aparato está bloqueado en el panel)
  429 límite de conexiones (cuerpo de texto)

Errores globales: 429 + Retry-After (rate limit) · 401 credenciales · 403 línea
suspendida/expirada/IP no autorizada · 503 canal sin fuente
```
