# TVLister 24/7 — v2.6.4 «Seguridad del reproductor (portal WebTV y vista previa)»

Auditando el reproductor del panel encontré cuatro fugas reales. Las cuatro están cerradas.

## 1. El navegador recibía la URL del proveedor (la peor)

`/api/webtv/catalog` mandaba `source_url` de cada canal, película y episodio: **la URL real del
proveedor, con sus credenciales**. Cualquiera con una línea válida abría las herramientas del
navegador y se llevaba tu origen para restreamearlo.

Ahora el catálogo entrega **enlaces firmados del propio panel**:

```
/webtv_play/<token>     canals y 24/7
/webtv_vod/<token>      películas
/webtv_series/<token>   episodios
```

El token va firmado con HMAC, atado a **esa línea**, a **ese canal** y con **6 h de caducidad**. Al
usarlo se revalida línea activa/expirada, bouquet y límite de conexiones, y se registra la conexión
igual que por `/live/`. Un enlace copiado y pegado en otro sitio deja de funcionar en 6 horas.

## 2. El login del portal devolvía la contraseña

`POST /api/webtv/login` respondía con `password` de la línea en el JSON. Sobra (la escribió el
usuario) y dejaba la contraseña en el historial del navegador y en cualquier log de red. Eliminada.

Además ese endpoint **no tenía límite de intentos**: se podía probar contraseñas en bucle contra las
líneas desde el portal público. Ahora usa el mismo freno que el login del panel (12 intentos por IP).

## 3. El panel y el portal se podían incrustar en otra web

Sin `X-Frame-Options`, cualquiera podía poner un `<iframe>` a tu portal y ofrecer "su" reproductor con
tu contenido. Ahora:

| Cabecera | Valor | Para qué |
| --- | --- | --- |
| `X-Frame-Options` | `SAMEORIGIN` | nadie incrusta el panel ni el portal |
| `Referrer-Policy` | `same-origin` | las URLs con token no se filtran por el Referer |
| `X-Content-Type-Options` | `nosniff` | nada de interpretar respuestas como otro tipo |
| `Permissions-Policy` | sin cámara/micrófono/geo | menos superficie |
| `Cache-Control` | `no-store` en `/drm/*`, `/live/*`, `/hls_proxy/*`, `/webtv_*`… | un enlace caducado no revive desde la caché |

## 4. La vista previa aceptaba cualquier token

`checkAdminPreviewJwt` daba por bueno **cualquier** token firmado, incluido uno de **código de
acceso** (que no es un usuario ni es admin). Ahora exige `role === 'admin'`.

## 5. Extra: la clave del DRM ya no da dos vueltas

Al reescribir un manifiesto, si el `#EXT-X-KEY` apunta a `/drm/...` de este mismo panel se deja igual:
ya está protegido por su token. Antes se reenviaba por el proxy y cada clave hacía un salto
panel→panel innecesario.

## 6. Lo puedes ver en el panel

*DRM & Claves* → tarjeta **Seguridad del reproductor**: nueve comprobaciones en vivo (URL oculta,
enlaces firmados, anti-incrustación, sin caché, límite de intentos, contraseña oculta, vista previa
sólo admin, DRM activo, base pública correcta) y el contador de **canales sin DRM**.

## Comprobado

| Prueba | Resultado |
| --- | --- |
| Catálogo WebTV contiene `source_url` | **no** (sólo `play_url`) |
| Enlace firmado válido | resuelve el canal (503 si el canal está detenido, no 401) |
| Token manipulado | `401` |
| Token de otro scope | `401` |
| `login` devuelve `password` | **no** |
| 12 intentos fallidos en el portal | `429` y el login correcto también queda frenado |
| Cabeceras | `SAMEORIGIN`, `same-origin`, `nosniff` presentes |
| `Cache-Control` en `/drm/key` | `no-store` |
| `/api/admin/preview/stream` sin token de admin | `401` |
| Clave del CAS vs clave del reproductor | idénticas (AES-128 intacto) |
| `/api/drm/player-security` sin sesión | `401` |

## Lo que sigue en tu tejado

- **Base pública**: si `public_stream_base` y `panel_domain` están vacíos, el panel avisa en rojo
  porque los enlaces pueden salir con `127.0.0.1`. Se arregla con `tvlister-admin streams-port 80 <dominio>`.
- Para el APK, el contrato de reproducción no cambia: sigue usando `/player_api.php` y ahora también
  puede usar `action=get_drm` para los canales con licencia.
