# TVLister v2.6.62 — listas de YouTube que se quedaban en 0 vídeos: ahora se preparan en el disco

Sobre v2.6.61. La tarjeta del canal lo decía todo:

> **Lista de YouTube · 0 vídeos · 0 min**
> ⚠ Ningún vídeo de la lista se puede emitir en bucle (todos son directos, privados o no ofrecen MP4).

Con las cookies funcionando (sesión válida hasta 2027), el problema no era la sesión: **la lista no ofrece ni un
MP4 progresivo**. YouTube sirve hoy casi todo en DASH/HLS con el vídeo y el audio en pistas separadas, y sin un
archivo que se pueda encolar el canal se queda a cero. Ya tiene salida.

## 1. Se dice qué pasa con cada vídeo de la lista

Antes: «todos son directos, privados o no ofrecen MP4». Ahora se cuenta **cuántos y por qué**, por vídeo:

> Los 30 vídeos de la lista no ofrecen un MP4 progresivo (sólo DASH/HLS). Se pueden descargar una vez (los
> primeros 30) y emitir desde el disco…
> **En esta lista:** 22 no ofrece MP4 progresivo (sólo DASH/HLS) · 6 es un directo · 2 es privado

Los motivos salen de lo que responde YouTube (v2.6.60), no de una suposición.

## 2. Botón «Preparar lista en el disco»

- Descarga los vídeos de la lista **uno a uno** (H.264 + AAC, ≤1080p, ya mezclados) a `.runtime/videos/`.
- **Eliges cuántos** (1–30, por defecto 10): así no te llena el disco sin querer. Cada capítulo de 22 min
  ocupa ~250–400 MB.
- Va **en segundo plano** con el paso a la vista: *«3/10 · Los Simpson 3x04»*, *«descargando 62 % (210 MiB)»*.
  Los que ya estaban descargados **se saltan** (se puede volver a pulsar y sigue donde lo dejó).
- Al terminar, el canal se reengancha solo: **lista completa desde el disco, en orden y en bucle**, con
  `⛁ DESDE EL DISCO`. Sin caducidades, sin renovar URLs y sin volver a YouTube.
- Si un archivo se borra, el canal sigue con el resto y la pantalla vuelve a ofrecer preparar lo que falte
  (chip `⛁ N SIN DESCARGAR`).

## 3. Se reutiliza lo ya descargado

La lectura de una lista mira primero el disco: los vídeos que ya están descargados entran directamente en la
emisión, sin consultar a YouTube. Una lista mixta (unos en el disco y otros con MP4) funciona sin tocar nada.

## API

- `POST /api/youtube/prepare-playlist` `{ url, limit }` → `202` con el trabajo en marcha.
- `GET /api/youtube/prepare-playlist/status` → `{ running, step, done, total, current, failures, result }`.
- `POST /api/youtube/probe` → `can_prepare_playlist`, `pending_count`, `skip_summary`, `local`.
- `GET /api/channels247` → `liveSource.local`, `liveSource.can_prepare_playlist`, `liveSource.pending_count`.

## Pruebas

- `test_youtube_live.mjs`: **207 OK**. Nuevas: lista con 4 vídeos sólo DASH → se ofrece preparar con el resumen
  de motivos; preparar responde `202` y descarga los 4 en segundo plano; el mismo enlace pasa a emitirse con
  `local: true` y **sin caducidad**; el canal queda `ready` con sus 4 vídeos; si falta un archivo sigue con 3.
- `test_youtube_live_ui.mjs`: **134 OK**, con el aviso, el selector de vídeos, el botón, el paso *«1/10 · …»*, el
  mensaje final y la lista resuelta.

## Actualizar

```bash
sudo tvlister-admin update
```

Y en el canal: **Editar → Comprobar señal → Preparar lista en el disco** (empieza con 10; súbelo si quieres más).
