# TVLister 24/7 — v2.5.14 «La cadena a la vista»

Confirmado el recorrido que describiste y medido de punta a punta:

```
Flussonic (m3u8)  →  TVLister 24/7  →  FFmpeg (-c copy, -re)  →  UDP 239.1.1.x:10xx  →  modulador IP→analógico
```

Y ahora el panel **te enseña esa cadena por canal** sin tener que adivinarla.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.14
tvlister-admin restart
```

---

## 1. La cadena, visible

```bash
tvlister-admin catv steady        # menú 22
```

```
  CANAL  MOTOR         DOSIFICADO    DECLARADO    MUXRATE  NOMBRE
  CH2    ffmpeg        si (-re)      2.90 Mbps          -  CANAL 2 NACIONAL
        HLS (m3u8 del origen)  ->  ffmpeg (-c copy, -re)  ->  udp 239.9.9.1:7111
  CH3    ffmpeg        si (-re)      2.50 Mbps          -  Telemundo
        HLS local (RAMDisk del panel)  ->  ffmpeg (-c copy, -re)  ->  udp 239.9.9.2:1003
  CH4    direct_dgram  NO            2.50 Mbps          -  MNF Nicaragua
        MNF  ->  direct_dgram (sin dosificar)  ->  udp 239.9.9.3:1004
```

### Las dos entradas posibles del panel (y por qué importa)

| Entrada | Cuándo ocurre | Qué lee FFmpeg |
| --- | --- | --- |
| **HLS del origen** | el canal tiene URL propia o el stream no se sirve por el motor 24/7 | el `index.m3u8` de Flussonic |
| **HLS local (RAMDisk del panel)** | el stream ya se sirve a los clientes y el motor escribe en `/dev/shm/tvlister_hls/stream_<id>/` | el manifiesto que escribe el propio panel |

Las dos acaban igual: **FFmpeg con `-c copy` y `-re`**. La diferencia sólo importa para diagnosticar (si el panel
escribe el HLS, el problema puede estar en el motor; si lee el m3u8 del origen, está en Flussonic).

---

## 2. Medición de la cadena completa (worker real, no laboratorio)

Origen: **HLS en vivo con ventana deslizante** (segmentos de 2 s que aparecen de golpe, como los sirve Flussonic).

| Entrada | Media | Pico | Ráfagas | Tramos en 0 | Por segundo | Forma |
| --- | --- | --- | --- | --- | --- | --- |
| `m3u8` del origen | 2,95 Mbps | 3,65 | 1,24× | **0** | `3.0 2.9 2.8 3.2 2.7 2.8 3.1 2.9` | `constante` |
| HLS local del panel | 2,93 Mbps | 3,65 | 1,25× | **0** | `2.8 2.8 3.2 2.8 2.9 3.1 2.9 2.9` | `constante` |

En los dos casos la SDT lleva el nombre del canal (`CANAL 2 NACIONAL`), no `Service01`.

> Antes de v2.5.11 ese mismo origen salía a **58 Mbps de pico** y con tramos en 0. El cambio que lo arregló fue
> `-re` en la ruta de salida al modulador (v2.5.11) y que las fuentes HTTP/TS dejen de usar el motor directo
> (v2.5.13).

---

## 3. Qué mirar cuando un canal no sale constante

| Lo que dice `catv steady` / `catv watch` | Dónde está el problema |
| --- | --- |
| `sin dosificar` en la cadena | ese canal va por el motor directo (MNF o `TVLISTER_CATV_DIRECT=1`) |
| `a trozos` en `catv watch` | la entrada llega a saltos y `-re` no está actuando en ese canal |
| `cortes: N% del tiempo en 0` | el origen no entrega más rápido de lo que el flujo consume (Flussonic, CDN o enlace) |
| `NO LLEGA NADA` | el grupo no entra por esa NIC: `--ip <IP correcta>` |

---

## Detalles técnicos

- `catvOutputPlan()` añade `source_kind`, `input` y `service_name`: usa `resolveSlotUpstream()` real, así que la
  cadena que se muestra es la que va a ejecutarse (no una estimación).
- La cadena se imprime por canal en `catv steady`; el CBR aplicado se refleja en la misma línea
  (`ffmpeg (-c copy, -re, CBR)`).

---

## Prueba realizada

| Caso | Resultado |
| --- | --- |
| `catv steady` con `custom_source_url` = m3u8 | `HLS (m3u8 del origen) -> ffmpeg (-c copy, -re)` |
| `catv steady` sin URL propia, con HLS del panel fresco | `HLS local (RAMDisk del panel) -> ffmpeg (-c copy, -re)` |
| Worker real con el m3u8 en vivo | media 2,95 · ráfagas 1,24× · 0 tramos en 0 · `constante` |
| Worker real con el HLS local del panel | media 2,93 · ráfagas 1,25× · 0 tramos en 0 · `constante` |
