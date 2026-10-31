# TVLister 24/7 — v2.5.3 «Vuelta al motor que funcionaba»

Se revierte por completo el *zapping rápido* de v2.5.1. El panel vuelve a entregar el manifiesto **tal como lo
escribe FFmpeg**, con la misma línea de argumentos que la versión que funcionaba de maravilla.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.3
tvlister-admin restart
```

---

## Por qué se revierte

El cambio de v2.5.1 servía al reproductor una ventana de **2 segmentos** con `#EXT-X-START` para abrir en el
borde del directo. El resultado en producción: **el audio suena y el vídeo se queda pegado**.

Causa: al empezar en el último segmento, si ese segmento no arranca en un keyframe (canales en **Copy**, que no
se re-codifican), el decodificador de vídeo no tiene imagen que mostrar mientras el audio sigue decodificando.
A eso se sumaba que, con una ventana de 4 s y `delete_segments`, un reproductor lento pide un segmento que ya
se borró y se queda esperando.

---

## Qué vuelve a como estaba

| Pieza | Estado en v2.5.3 |
| --- | --- |
| Manifiesto entregado | El de FFmpeg, **completo y tal cual** |
| `#EXT-X-START` | Eliminado |
| Ventana corta (`?window=`) | Eliminada |
| `+temp_file` en `-hls_flags` | Eliminado |
| `-force_key_frames` | Eliminado |
| Precarga de canales vecinos | Eliminada |
| Espera del primer manifiesto | 4.2 s (valor original) |
| Sección **Zapping** en Motor FFmpeg | Eliminada |

Línea de argumentos restaurada (Copy/Copy):

```
-threads 1 -probesize 5000000 -analyzeduration 4000000
-fflags +genpts+igndts+nobuffer+discardcorrupt -flags low_delay
-c:v copy -max_muxing_queue_size 2048 -c:a copy
-f hls -hls_time 2 -hls_list_size 6
-hls_flags delete_segments+independent_segments+omit_endlist
```

---

## Qué se conserva

- **`tvlister-admin ffmpeg import-xui`**: copia el binario de XUI.one a `.runtime/bin` con sus librerías en
  `.runtime/lib`. No interviene en la reproducción.
- **Un CSV por modulador** (v2.5.2) y los **bloques de canales por portadora** (v2.5.0): intactos.
- **Motor FFmpeg con opciones estáticas** (v2.4.1): intacto, sin la sección Zapping.

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| Manifiesto servido vs manifiesto interno | idénticos: `index3…index8` en ambos |
| `EXT-X-START` | ausente |
| Cabeceras de zapping | ausentes |
| Segmentos descargables | 6/6 (2.56 MB) |
| Workers de vecinos | ninguno |
| Argumentos FFmpeg | sin `temp_file` y sin `force_key_frames` |
| Build de producción | Vite sin errores |

---

## Nota para el futuro

Si se quisiera reintentar el zapeo, el orden correcto es **primero** garantizar keyframe en cada segmento
(`-force_key_frames`, sólo cuando TVLister re-codifica) y **después** acortar la ventana. Nunca al revés.
