# TVLister v2.6.55 — copy/copy de verdad en los directos de YouTube (con audio en pista aparte)

Sobre v2.6.54. Respuesta corta a «¿podemos hacer copy/copy de un directo de YouTube?»: **sí, y ahora de verdad**.
El directo se emite copiando el original (`-c:v copy -c:a copy`), sin recodificar y con **0 % de CPU de vídeo**. Había
dos agujeros que esta versión cierra.

## 1. Audio en pista separada (el importante)

YouTube suele dar el directo con **vídeo y audio en pistas distintas** (DASH/HLS). Antes se elegía la primera pista
de vídeo y se copiaba… **sin sonido**. Ahora:

- `pickHls` devuelve un **plan de copia**: `master` (manifiesto maestro con su grupo de audio), `muxed` (pista con
  audio y vídeo), `separate` (vídeo + audio sueltos) o `video` (no hay audio disponible).
- El motor abre **dos entradas** (`-i vídeo -i audio`), las mapea con `-map 0:v:0 -map 1:a:0` y copia las dos. Sigue
  siendo copy/copy: no se recodifica nada.
- La caducidad que manda es la **más próxima de las dos URLs** (ambas van firmadas), así que la guardia renueva antes.
- Con manifiesto maestro o pista mezclada no se añade nada: la línea FFmpeg es la de siempre.

## 2. Saber si se copia o se recodifica

Cada canal lo dice en su tarjeta, con tres chips:

| Chip | Qué significa |
| --- | --- |
| `⧉ COPIA EXACTA` | Vídeo y audio salen tal como llegan. 0 % de CPU de vídeo. |
| `⧉ COPIA · AUDIO AAC` | El vídeo se copia; el audio pasa a AAC porque tienes encendido el **nivelador de audio global**. |
| `↻ RECODIFICA` | El original no es H.264/AAC uniforme (VP9, AV1, mezcla de resoluciones…) y se pasa a H.264 2500k. |

La caja de la señal añade el detalle («Copia exacta (copy/copy): el vídeo y el audio salen tal como llegan, uniendo
sus dos pistas, sin recodificar») y **Comprobar señal** lo avisa antes de guardar: *«⧉ Copy/copy: no se recodifica
nada (0 % de CPU de vídeo)»*, indicando si hay pistas separadas.

## Datos que ahora viajan

- Estado del canal: `audio_url`, `copy_video`, `copy_audio`, `copy_kind`, `height`.
- `GET /api/channels247`: `copyExact`, `copyVideo`, `audioLeveled` por canal.
- `POST /api/youtube/probe`: `copy_kind`, `separated_audio`, `copy_video`, `copy_audio`, `height`, `width`.
- El `ffmpegCommand` que enseña la tarjeta incluye las dos entradas y los `-map`: es exactamente lo que se ejecuta.

## Si quieres copy/copy siempre

Con el **nivelador de audio global apagado** (Ajustes → audio), un directo de YouTube va en `⧉ COPIA EXACTA`. Con el
nivelador encendido el vídeo se sigue copiando y sólo el audio se pasa a AAC 128k (es lo que hace el nivelador).

## Pruebas

- `node scripts/test_youtube_live.mjs` → **95 OK**, con un directo simulado de vídeo y audio separados: se detecta como
  `separate`, elige la mejor pista (1080p), el motor arranca con **dos `-i`**, `-map 0:v:0 -map 1:a:0`,
  `-c:v copy -c:a copy` y **sin `libx264`**; el listado marca `copyExact:true` y pasa a `false` al encender el
  nivelador (con el vídeo todavía en copia).
- `node scripts/test_youtube_live_ui.mjs` → **57 OK** con los tres chips y el aviso de pistas unidas.
- Siguen en verde: `test_uninstall.sh` (49), `test_uninstall_ssh.sh` (40), CATV/Flussonic, VOD y balancer.
  `npm run build` OK.

## Actualizar

```bash
sudo tvlister-admin update
```
