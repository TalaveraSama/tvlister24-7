# TVLister 24/7 — v2.6.5 «Aparatos por línea y seguridad de la app»

Hasta ahora una línea con `max_connections = 1` se podía repartir entre cinco personas: el panel
veía IPs distintas reproduciendo y no había forma de saber en cuántos aparatos vivía la cuenta.
Esta versión añade el registro de aparatos, cierra la fuerza bruta que quedaba abierta en la lista
M3U y deja escrito el contrato que tiene que cumplir la app.

## 1. Aparatos por línea (anti-compartición)

Tabla nueva `line_devices` y API para el reproductor:

| Acción | Qué hace |
| --- | --- |
| `action=register_device` | Vincula el aparato y devuelve `device_token` (30 días) |
| `action=heartbeat` | Estado de la línea, conexiones y `exp_date` (para que la app no use el reloj del teléfono) |
| `action=unlink_device` | El cliente desvincula su propio aparato |

Con `device_lock` activo, `/live`, `/movie` y `/series` exigen la cabecera `X-Device-Token`.
**Apagado por defecto**: sin activarlo, la lista M3U, `get.php`, `xmltv.php` y las apps siguen
exactamente igual.

En el panel, *Usuarios y Dispositivos* → botón del teléfono en cada línea: aparatos vinculados,
activar el bloqueo, cuántos se permiten, desvincular uno (veto) o todos (reset), y «permitir de
nuevo». Desvincular corta las sesiones abiertas de esa línea al instante.

## 2. Fuerza bruta por la puerta de atrás (la lista M3U)

El límite de intentos de v2.6.4 sólo cubría el login del panel y el del portal. Contra
`/get.php`, `/xmltv.php`, `/live` y `/movie` se podían probar contraseñas **sin límite**. Ahora hay
una puerta por IP dentro de `authenticateLine`: 20 fallos en 10 minutos ⇒ `429` durante 10 minutos,
con `Retry-After`. Una app que acierta limpia el contador, así que la reproducción normal no se
nota.

Además, el límite que se añadió en `player_api.php` se comprobaba **sólo al fallar**, así que el que
acertaba a la duodécima seguía entrando. Corregido: se mira antes de autenticar.

## 3. `/webtv_play` no caducaba a las 6 h

`signToken()` pisaba el `exp` que le pasaban: todos los tokens duraban 7 días, incluidos los enlaces
de reproducción de la WebTV que se anunciaban como de 6 h. Ahora respeta el TTL pedido. Verificado:
`ttl real: 6.0 h`.

## 4. CORS del panel

Se reflejaba **cualquier** origen con credenciales en toda la API. Ahora los endpoints de
reproductor (Xtream, M3U, DRM) siguen abiertos —los usan TVs y apps nativas— y la API de
administración sólo acepta el mismo host del panel (o lo que se declare en `CORS_ALLOWED_ORIGINS`).

## 5. Documento para el desarrollador de la app

`docs/SEGURIDAD_PLAYER_APP_INDICACIONES.md`: qué guardar y dónde (Keystore, no `SharedPreferences`
en claro), cómo construir un `device_id` estable, las tres llamadas nuevas con sus respuestas y
códigos de error, la cabecera en **manifiesto y segmentos** con el snippet de ExoPlayer, latido de
90 s, qué hacer con `403 device_*` / `429 Retry-After` / `503`, DRM sin tocar nada, pinning de dos
pines, checklist de auditoría, 15 pruebas de aceptación y un prompt listo para pegarle.

## Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| `register_device` | `200`, `device_token`, `token_ttl_seconds: 2592000` |
| 2º aparato con `device_limit: 1` | `403 device_limit` |
| `heartbeat` con token | `200` con `exp_date`, `active_cons`, `device_lock` |
| `device_lock` activo, `/live` sin cabecera | `403 device_required` |
| `device_lock` activo, `/live` con cabecera | pasa el control (404 del canal de prueba) |
| `get.php` (lista M3U) con bloqueo activo | `200`, sin cambios |
| Panel desvincula → `heartbeat` | `403 device_revoked` |
| Desvincular desde la app y volver a registrar | vuelve a vincularse |
| 21 contraseñas malas por `get.php` | `429` y luego 429 también con la buena |
| Token de la WebTV | caduca a las 6 h (antes 7 días) |
| `/api/lines/:id/devices` sin sesión | `401` |

## Instalación

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.5/install.sh | bash
tvlister-admin update
```

Después, en el panel: *Usuarios y Dispositivos* → teléfono en la línea. Ojo: **no** actives
«Exigir aparato vinculado» en líneas que se vean en Smart TV o VLC, que no pueden mandar la cabecera.
