# TVLister 24/7 — v2.5.16 «Lo de XUI.one, medido»

> **v2.5.16** corrige `tvlister-admin hls` (fallaba con `local: can only be used in a function`).
> Si instalaste v2.5.15, actualiza: el comando ahora responde tal cual se describe aquí.

Leí el código de `xuione_decoded` (43 MB, `decoded/` + `opc/`) para sacar **exactamente** con qué
opciones genera su HLS y qué merece la pena traerse. El resultado es un interruptor de tres
posiciones: se puede probar y **volver atrás sin reinstalar nada**.

```
tvlister-admin hls status          # qué línea HLS está usando el panel ahora
tvlister-admin hls xui safe        # original + lo de XUI.one que no puede romper nada
tvlister-admin hls xui full        # el juego completo de XUI.one
tvlister-admin hls xui off         # la línea original, byte a byte
tvlister-admin restart
```

También está en el panel: **Motor FFmpeg → «Afinado HLS (referencia XUI.one)»**.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.16
tvlister-admin restart
```

Al instalar **no se cambia nada**: el modo por defecto sigue siendo `off`, la línea validada.

---

## 1. Qué hace cada modo

| Modo | `-hls_flags` | Opciones añadidas | Entrada |
| --- | --- | --- | --- |
| `off` (por defecto) | `delete_segments+independent_segments+omit_endlist` | — | igual que v2.5.14 |
| `safe` | `…+discont_start` (sin `append_list`) | `-individual_header_trailer 0 -hls_delete_threshold 2` | `-err_detect ignore_err` |
| `full` | `delete_segments+discont_start+omit_endlist` | `-individual_header_trailer 0 -hls_delete_threshold 2 -hls_segment_type mpegts` | `-err_detect ignore_err -re` |

`tvlister-admin hls status` imprime los tokens resueltos, así que **lo que lees es lo que se ejecuta**
(la función que los calcula es la misma que los pasa a FFmpeg):

```
  Modo                : safe  (original + extras de XUI.one)
  Segmento            : 2 s
  Ventana             : 6 segmentos (~12 s)
  -hls_flags          : delete_segments+independent_segments+discont_start+omit_endlist
  Opciones extra      : -individual_header_trailer 0 -hls_delete_threshold 2
  -err_detect         : ignore_err
  -re en la entrada   : no
```

## 2. Por qué `safe` y no `full`

En el código de XUI.one (`includes/xui.php`, salida HLS ~línea 5677 y `-f segment` ~línea 5381):

- `discont_start` — marca el corte cuando el muxer arranca sobre un directorio con segmentos
  viejos. Es justo el caso de un canal que se reinicia. **Se trae.**
- `-hls_delete_threshold 2` — mantiene 2 segmentos ya borrados de la lista para que un cliente
  que llega tarde no pida un `.ts` que ya no existe. **Se trae.**
- `-individual_header_trailer 0` — cada segmento sin PAT/PMT repetido al principio. **Se trae.**
- `-err_detect ignore_err` — un paquete corrupto del origen se descarta y el canal sigue. **Se trae.**
- `append_list` fuera — XUI no lo usa; deja entradas de segmentos ya borrados en la lista. **Se trae.**
- `-re` en la entrada — XUI lo aplica sólo cuando *no* hay `custom_ffmpeg`. Aquí ya está cubierto en
  la cadena de moduladores (`-re` es lo que hace constante la salida UDP, v2.5.13). Añadirlo otra vez
  en el HLS del panel **cuesta latencia de arranque** y no arregla nada: por eso `full` existe pero
  no es el recomendado.

Lo que **no** se trae, y por qué:

- `-f segment` (variante de la línea 5381): es un segmentador manual sobre el que XUI construye su
  propio `.m3u8`. El muxer `hls` nativo de FFmpeg hace lo mismo mejor y sin reescribir listas.
- Su bloque de timestamps (`-copyts -avoid_negative_ts disabled -max_interleave_delta 0`,
  línea ~4893): está pensado para *timeshift*, no para directo. En un canal 24/7 introduce
  discontinuidades de PTS que aquí no se necesitan.
- `split_by_time` (`ignore_keyframes`): corta segmentos sin esperar keyframe. Rápido de arrancar y
  **con artefactos al zapear**. Choca de frente con «prioridad absoluta a que se vea».
- Su servidor de manifiestos en PHP (`www/admin/live.php`, `sleep(1)` por cliente, un proceso por
  conexión): es la razón real de los «no load» de XUI con muchos espectadores. El panel ya sirve
  estático desde RAMDisk.

## 3. Veredicto sobre XUI.one

- **El streaming:** sólido. `-c copy`, segmentador, `omit_endlist`, `delete_segments`, ventana en
  RAMDisk. Es lo que ya hace el panel.
- **El panel:** no. PHP con long-poll por espectador, `delay_minutes` mal puesto deja
  `-hls_list_size 0` → lista infinita que crece en RAMDisk, y el código está ofuscado
  (`labelNNN` + `goto`) sin esquema SQL: no se puede auditar ni parchear.
- Conclusión: **copiar sus opciones está bien; copiar su arquitectura, no.**

## 4. Reproductor del panel

El manifiesto del panel es de 2 s × 6 = 12 s y **no es Low-Latency HLS** (no lleva `EXT-X-PART`).
Tener `lowLatencyMode: true` con una lista así hace que hls.js persiga el borde del directo, se
quede sin segmento siguiente y repita el mismo: imagen congelada con audio.

Ahora ambos reproductores usan una sola configuración (`src/lib/hlsConfig.js`):

- `lowLatencyMode: false`
- `liveSyncDurationCount: 2` → entra por detrás del borde, como el prebuffer de XUI.one
- `maxLiveSyncPlaybackRate: 1.1` → si se atrasa, acelera suave en vez de saltar
- buffer acotado a la ventana (`maxBufferLength`, `maxMaxBufferLength`, `backBufferLength: 30`)
- reintentos explícitos de manifiesto/lista/fragmento **y** 3 reintentos de red antes de dar el
  canal por caído (antes, un corte de 2 s cerraba el reproductor)

## 5. Lo que no se tocó

- La línea de la cadena UDP (`buildFfmpegUdpOutputArgs`) — intacta.
- La ventana HLS (2 s × 6) y las sondas — intactas: son las validadas con 145 canales.
- El modo por defecto del motor sigue siendo `off`: instalar esta versión no cambia el
  comportamiento de ningún canal.

## Verificación

```bash
tvlister-admin hls status
tvlister-admin catv steady
sudo tvlister-admin catv watch --secs 10 --ip 192.168.200.8
```
