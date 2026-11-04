# TVLister 24/7 v2.6.32 — la salida UDP queda estabilizada (como Astra)

**Lo reportado:** «estoy en UDP enviando a las IP analógicas y hay ráfagas de 33 megas cuando el canal
apenas es de 2 megas; el UDP tiene que estar estabilizado, así como trabaja Astra».

## Qué pasaba

El motor reenviaba el MPEG-TS al socket **tal como llegaba**. Un segmento HLS de 2 s entra en ~30 ms y una
ráfaga MNF de 1 MB entra de golpe: esos 500 KB salían al instante y el modulador —que mide su entrada por
ventanas— veía un pico de decenas de Mbps aunque la media fuese 2 Mbps.

`-re` en FFmpeg dosifica la **lectura** del origen, no la **escritura** al socket, y la salida UDP llevaba
`buffer_size=1048576`: 1 MB son 4 segundos de un canal de 2 Mbps, que el kernel vaciaba a la velocidad del
enlace. Ese es el pico de ~33 Mbps.

## Qué se hizo

| Pieza | Detalle |
| --- | --- |
| `server/catvUdpPacer.js` (nuevo) | Reloj propio del socket: cubo de fichas al ritmo del canal. **Nunca** se emite por encima del objetivo. |
| Relleno CBR | Si el origen entrega menos, se completa con paquetes nulos MPEG-TS (PID 0x1FFF) ⇒ línea plana |
| Objetivo automático | Bitrate real del canal (ventana de 20 s) **+10 %**, con histéresis para no bailar |
| Objetivo fijo | `muxrate_kbps` del canal manda (`catv steady --cbr`) |
| Contrapresión | Si la cola crece se frena FFmpeg/HTTP (`drain()`): no se pierde ni un paquete |
| RTP | Cabecera RTP/MPEG-TS propia (PT 33, reloj de 90 kHz, secuencia) cuando el equipo lo pide |
| Origen cortado | La portadora sigue con relleno (el modulador no ve hueco) y el panel marca «sin datos» |
| Vigilante | 45 s sin un solo paquete real ⇒ se reinicia el motor del canal |

FFmpeg ahora escribe el SPTS en `stdout` (`-f mpegts pipe:1`, el progreso pasa a `pipe:2`) y el pacer es el
único dueño del socket. El motor directo (MNF / HTTP TS) alimenta el mismo pacer, así que **todos** los
caminos de salida pasan por el estabilizador.

## Lo que se ve en el panel

- En *UDP / CATV*, cada portadora activa muestra `ACTIVO 2.0M` y debajo **`pico 2.1M · estable`**
  (en ámbar si todavía hay ráfagas).
- La API del plan expone `pacer_kbps`, `peak_kbps`, `queue_ms`, `null_pct`, `idle_ms` y `steady`.
- **Comprobar** añade la verificación *Salida estabilizada* (pico de 250 ms ≤ 1,3 × la media).

```bash
tvlister-admin catv steady          # columna DOSIFICADO: si (pacer) · motor y objetivo de cada canal
tvlister-admin catv watch --secs 10 # medición real del grupo: debe salir «forma: constante»
```

Para fijar el ritmo a mano (CBR exacto) y volver al automático:

```bash
sudo tvlister-admin catv steady --apply --cbr --headroom 15
sudo tvlister-admin catv steady --apply --clear
```

## Pruebas

`node scripts/test_catv_udp_pacer.mjs` — **18 comprobaciones OK**, con el motor real, un FFmpeg simulado que
entrega a trozos y un receptor UDP que mide ventanas de 250 ms (lo mismo que mide el modulador):

| Caso | Resultado |
| --- | --- |
| FFmpeg simulado + pacer | **2,46 Mbps planos**, pico/media **1,03**, ninguna ventana en 0 |
| Motor directo (HTTP TS) + pacer | **2,45 Mbps planos**, pico/media **1,03** |
| El mismo canal **sin** pacer | media 2,05 Mbps pero **picos de 16 Mbps** (pico/media **7,8**) ⇒ la prueba reproduce el problema del cliente |
| Relleno con nulos | 7 paquetes TS válidos por datagrama, PID 0x1FFF |
| RTP | versión 2, PT 33, secuencia correlativa, datagrama 12 + 1316 |
| Contrapresión | 1 MB en cola sin perder un datagrama |
| Objetivo automático | se queda en 2,25 Mbps para un canal de 2 Mbps (+10 %) |
| Origen cortado | 86 % relleno, portadora viva, «sin datos» a los 4,5 s. **El objetivo se congela**: durante un corte el modulador sigue viendo el mismo ritmo (medido: 2400 kbps antes y durante el corte) |
| Bucle de eventos cargado (8 ms bloqueado cada 30 ms) | **2250 kbps de 2250** (antes se quedaba corto y la cola crecía sin fin) |

Sin regresiones: `test_vod_genres`, `test_balancer_lb`, `test_node_affinity`, `test_vod_paging` OK y
`npm run build` OK.

## Instalar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.32/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.32
```

En un panel ya instalado: `tvlister-admin update` y luego **reiniciar los canales CATV** para que los
trabajadores arranquen con el estabilizador (`tvlister-admin restart`).

Si por cualquier motivo quisieras el comportamiento anterior:
`TVLISTER_CATV_PACER=off` en `/etc/tvlister24-7.env` y reinicio.
