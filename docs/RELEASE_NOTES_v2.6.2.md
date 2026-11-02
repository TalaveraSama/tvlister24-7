# TVLister 24/7 — v2.6.2 «¿Quién emite las claves? + custodia de claves Widevine»

Tu pregunta, respondida sin adornos:

| Sistema | Quién emite la clave | ¿El panel puede? | Coste |
| --- | --- | --- | --- |
| **AES-128 / SAMPLE-AES / ClearKey** | **TVLister** | **Sí, ya lo hace** | 0 |
| **Widevine / PlayReady** | Google / Microsoft o un partner autorizado | **No** (ningún panel puede) | Proveedor o acuerdo |

Documento completo: **`docs/DRM_QUIEN_EMITE_LAS_CLAVES.md`**.

## Por qué Widevine no lo puede emitir un panel

Una licencia DRM no es una clave: es una **firma**. La `aes_key` es un número, pero el teléfono sólo
descifra si el CDM valida una licencia firmada con la clave privada de Google/Microsoft. Esa clave no
se distribuye: se obtiene con un acuerdo (Widevine: CWIP + cuota, o un partner con el License Server
SDK) y hoy Google ya no emite licencias desde Cloud License. Cualquiera que prometa Widevine
«gratis, emitido por el panel» está vendiendo humo.

## Lo que sí hizo esta versión

1. **Custodia de tus claves Widevine en el panel**: `aes_key`, `iv` y `content_id` por canal (los de
   tu cuenta del proveedor), validados (32 hex) y **nunca devueltos al navegador**: en la web se ven
   como `<guardada>`; sólo la terminal y el empuje a Flussonic los usan en claro.
2. **Bloque exacto para Flussonic**, en el panel y en `tvlister-admin drm snippet`:
   ```
   drm widevine aes_key=… iv=… content_id=… keyserver=https://tu-proveedor/…
   ```
3. **Vista clara en el panel** de quién emite qué: tres tarjetas (AES-128 las emite este panel /
   ClearKey también pero es débil / Widevine-PlayReady las firma un tercero).
4. **Modo Widevine ahora exige keyserver** con un mensaje que lo explica, en vez de aceptar una
   configuración que nunca podría funcionar.
5. **Corregido un fallo de seguridad en el propio módulo**: las rutas `/api/drm/*` no tenían
   middleware y un `router.use()` de más bloqueaba también el login del panel. Ahora cada ruta lleva
   `requireAuth` + `requireAdmin`, el login funciona y el resto del panel sigue igual.

## Comprobado

| Prueba | Resultado |
| --- | --- |
| `/api/drm/*` sin sesión | `401` en las 11 rutas |
| `/api/drm/overview` con sesión | `200` |
| Login del panel tras el cambio | OK (antes lo rompía el `router.use`) |
| Claves CENC en la respuesta web | `0` apariciones (enmascaradas) |
| `tvlister-admin drm snippet` | claves en claro (uso local) |
| `get_drm` (app) | nunca lleva claves, sólo URLs |
| Widevine sin keyserver | `400` con la explicación |
| `aes_key` con longitud incorrecta | `400` |
| AES-128 tras todo esto | sigue emitiendo claves y rotando |

## Recomendación para tu operación

Fase 1 (hoy, gratis): **AES-128 del panel** en todos los canales HLS. Cubre tu APK, TiviMate,
Smarters, TV boxes y WebTV, con rotación cada 10 min y revocación por línea.

Fase 2 (sólo para paquetes premium): contrata un proveedor Widevine, pega sus claves y su keyserver
en *DRM & Claves*, y el panel hace de proxy autorizado sin exponerlo.

El **CATV/UDP no se cifra ni se toca**: el DRM es sólo de la salida HTTP, y el panel avisa si un
canal CATV comparte el stream de Flussonic que vas a cifrar.
