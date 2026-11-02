# TVLister 24/7 — v2.6.1 «Contrato DRM para tu app (Alpha Vision)»

Tu APK (`playeralphavision v1.2.49-channel-sync-lifecycle-preview`) no hay que reescribirlo: hay que
**conectarle dos cosas** que el panel ya sabe dar. Esta versión añade la que faltaba.

*(El repositorio de la app es privado y no es accesible desde aquí, así que no asumo su
arquitectura: el documento de integración empieza detectándola.)*

## 1. Lo nuevo: `action=get_drm`

```
GET {panel}/player_api.php?username=X&password=Y&action=get_drm
```

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
      "license_url": "https://stream.tudominio.com/drm/license/AbC123?t=...",
      "clearkey_url": "https://stream.tudominio.com/drm/clearkey/AbC123?t=...",
      "key_url": "https://stream.tudominio.com/drm/key/AbC123?t=...",
      "requires_eme": true
    }
  ]
}
```

- Sólo los canales que la línea tiene permitidos, con el mismo `stream_id` que `get_live_streams`
  (los 24/7 van como `10000 + id`).
- **Sin claves y sin las cabeceras secretas del servidor de licencias**: esas las inyecta el proxy
  del panel. El APK nunca ve un secreto.
- `t` va firmado por línea y caduca a los 7 días; al caducar, la app repite `get_drm`.
- `drm_enabled:false` o lista vacía ⇒ la app funciona exactamente como hoy.

## 2. El documento para el otro agente

`docs/INTEGRACION_DRM_APP.md` — hecho para pegarlo tal cual (**eliminado en v2.6.15**, el DRM se retiró; ver `docs/REGISTRO_APARATOS_MAC.md`):

| Sección | Contenido |
| --- | --- |
| 0-1 | resumen y **cómo detectar la pila** (Media3/ExoPlayer y versión, Flutter, libVLC, WebView) |
| 2 | contrato completo con respuestas reales y tabla de errores 401/403/404/503 |
| 3 | **Media3**: código de `DefaultDrmSessionManager` + `HttpMediaDrmCallback`, multi-sesión, un manager por canal |
| 4 | lista M3U: parseo de `#KODIPROP` (y el bug clásico de no resetearlo por canal) |
| 5 | Flutter / libVLC / Shaka en WebView |
| 6 | refresco de tokens (sin bucles) |
| 7 | lo prohibido: cachear claves, loguear la URL, tocar el manifiesto |
| 8 | **9 pruebas de aceptación** con lo que debe verse también en el panel |
| 9 | **prompt listo para pegar** en el otro agente |
| 10 | lo que el panel no hace (licencias Widevine propias, offline) |

Y `docs/drm_api_contract.json` para que el agente no tenga que interpretar prosa (también eliminado en v2.6.15).

## 3. Lo que la app tiene que hacer, en corto

1. **AES-128: nada de código.** Solo verificar que su `DataSource`/parser no borra las líneas
   `#EXT-X-KEY` ni las query strings de las URLs de clave.
2. **Widevine**: leer `get_drm`, guardar `stream_id → license_url`, y para los canales con
   `requires_eme: true` montar `HttpMediaDrmCallback(license_url)` con `setMultiSession(true)`.
3. **Tokens**: refrescar al abrir y cada 12 h; en `401`, refrescar y reintentar **una** vez.
4. **Playlist**: parsear `#KODIPROP license_type` / `license_key` aplicándolo al `#EXTINF` siguiente.

## 4. Pruebas hechas en el panel

| Prueba | Resultado |
| --- | --- |
| `get_drm` con canal en Widevine | `license_url` + `requires_eme:true` |
| `get_drm` con canal en AES-128 | `license_url` vacío, `key_url` presente |
| DRM global apagado | `{"drm_enabled":false,"streams":[]}` |
| Token de línea manipulado | `401` (y queda en el log) |
| Log del panel tras la prueba | entregas `license` y `key` con IP y canal |

## 5. Sobre el repo que enviaste antes

`sandri-kun/IPTV-DRM-Stream-Player` sigue **sin poder incrustarse** (app Android cerrada; en el repo
solo hay README y playlists de ejemplo). Pero su formato —`#KODIPROP` con
`inputstream.adaptive.license_type` / `license_key`— es exactamente el que emite TVLister y el que
sirve a Kodi, OTT Navigator y TiviMate. Por eso la integración se hace **por contrato de API**, no
copiando su código.
