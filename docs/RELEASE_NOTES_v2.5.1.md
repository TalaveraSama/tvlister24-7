# TVLister 24/7 — v2.5.1 «Zapping rápido + FFmpeg dentro del panel»

Dos arreglos pedidos desde producción: **el cambio de canal ya no tarda** y **el binario de FFmpeg de XUI.one
queda dentro de la carpeta del panel**, sin depender de `/home/xui`.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.1
tvlister-admin restart
```

Si además quieres dejar el binario de XUI.one copiado dentro del panel:

```bash
tvlister-admin ffmpeg import-xui
tvlister-admin restart
```

---

## 1) Zapping rápido

### Qué pasaba
El motor escribe 6 segmentos de 2 s. El panel entregaba ese mismo manifiesto al reproductor, y los
reproductores (hls.js, ExoPlayer/TiviMate, VLC, Smarters) **precargan ~3 segmentos** antes de mostrar imagen:
6–12 s de espera por canal, con el audio entrando antes que el vídeo. En canales `ondemand` se sumaba el
arranque en frío de FFmpeg.

### Qué se cambió

| Palanca | Efecto | Por defecto |
| --- | --- | --- |
| **Ventana al reproductor** | Sólo se sirven los últimos 2 segmentos + `#EXT-X-START:TIME-OFFSET=-1` | 2 segmentos |
| **Precarga de vecinos** | Al abrir un canal se arranca en segundo plano el anterior y el siguiente | Activado, 1 por lado |
| **Segmento completo** | `+temp_file`: FFmpeg escribe en `.tmp` y renombra al terminar | Activado |
| **Keyframe por segmento** | `-force_key_frames` para que cualquier segmento empiece con IDR | Activado (sólo al re-codificar) |

- El **manifiesto interno no cambia** (sigue con `hls_list_size`): lo que cambia es lo que recibe el reproductor.
- `-force_key_frames` **no se añade en Copy/Copy**: en tu perfil estable el vídeo no se toca.
- La espera del primer manifiesto en frío pasó de 4.2 s a 7 s: antes expiraba, el reproductor recibía un 404 y
  volvía a pedir (**"queda cargando"**); ahora entrega el manifiesto en el primer intento.

### Medición real (canal HLS de prueba servido por el propio panel)

| Ventana entregada | Datos antes de la primera imagen | Medios descargados |
| --- | --- | --- |
| 6 (antes) | 2.53 MB | 10 s |
| 3 | 1.51 MB | 6 s |
| **2 (nuevo)** | **1.00 MB** | **4 s** |

Precarga verificada: canal `ondemand_idle` sin worker → al abrir su vecino, el canal arrancó su propio FFmpeg
en menos de 6 s, así que el siguiente zapeo no paga arranque.

### Ajustes en el panel
**Motor FFmpeg → Zapping**: ventana al reproductor (1–6), precarga de vecinos, vecinos por lado, segmento
completo y keyframe por segmento. Los cuatro con su valor de fábrica y su recuadro de "Cambiado de X a Y".

---

## 2) FFmpeg de XUI.one dentro del panel

Antes el motor sólo podía usar el FFmpeg de XUI.one *en su sitio* (`/home/xui/bin/...`). Si ese directorio no
estaba, no había binario.

- **Nuevo comando:** `tvlister-admin ffmpeg import-xui`
  - Busca `4.4 → 4.3 → 4.0 → rutas antiguas` en `/home/xui`.
  - Copia el binario a **`/opt/tvlister24-7/.runtime/bin/ffmpeg`**.
  - Copia a **`.runtime/lib`** las librerías que `ldd` reporte como faltantes y verifica que ejecute `-version`.
  - Fija la preferencia en `runtime` y deja el binario anterior como `.bak.<fecha>`.
- **El instalador lo hace solo** si detecta XUI.one y el panel todavía no tiene binario.
- El motor añade `.runtime/lib` a `LD_LIBRARY_PATH` cuando usa el binario copiado.
- `tvlister-admin ffmpeg status` muestra la procedencia real del binario en uso.

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| Playlist entregada | 2 segmentos + `EXT-X-START`, manifiesto interno intacto (6) |
| `?window=6` | sigue sirviendo 6 (compatibilidad) |
| Manifiesto vacío / fMP4 | no rompe; conserva `EXT-X-MAP` |
| Copia de argumentos | `temp_file` en ambos perfiles; `-force_key_frames` sólo con libx264 |
| Precarga | vecino `ondemand_idle` arrancado automáticamente |
| `import-xui` | binario copiado, verificado y preferencia en `runtime` |
| Build de producción | Vite sin errores |

---

## Compatibilidad

- Sin migraciones de base de datos.
- Los ajustes antiguos siguen valiendo: todo lo nuevo tiene valor de fábrica y recuadro propio.
- Perfiles Copy/Copy: línea de FFmpeg sin cambios de codificación.
