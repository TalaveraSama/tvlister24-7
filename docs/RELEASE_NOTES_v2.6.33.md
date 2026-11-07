# TVLister 24/7 v2.6.33 — los canales salen por Flussonic (y el UDP nativo vuelve a como estaba)

**Lo pedido:** «ahora se pega, no está fluido; necesito controlar Flussonic, ya Flussonic recibe los canales,
sería enviarlos desde Flussonic mejor, después estabilizamos el UDP nativo».

## 1. Se acabaron los tirones: el estabilizador pasa a ser opcional

El pacer de la v2.6.32 entregaba el MPEG-TS a ritmo fijo. Con vídeo **VBR** (un I-frame grande llega de golpe)
esos paquetes esperaban en la cola del pacer y el modulador veía micro-tirones: la media era correcta, la
fluidez no. Estabilizar de verdad exige **re-multiplexar** (CBR con PCR coherente), no trocear el socket.

| Antes (v2.6.32) | Ahora (v2.6.33) |
| --- | --- |
| El pacer estaba activo y era obligatorio | **Apagado por defecto**: la salida es exactamente la de la v2.6.31 |
| FFmpeg escribía el TS en un pipe y el pacer lo reenviaba | FFmpeg escribe directo a `udp://…`, como siempre |
| Un origen desalineado se troceaba corrido | Si se enciende (`TVLISTER_CATV_PACER=on`), ahora **resincroniza a 0x47** |

La estabilización del UDP nativo queda para más adelante, y se hará sobre el **muxer** (CBR/PCR), no sobre el
socket.

## 2. Control de Flussonic desde el panel

Flussonic ya recibe los canales; ahora el panel le pide que sea **él** quien empuje el MPEG-TS al modulador.

| Acción | Qué hace |
| --- | --- |
| **Detectar canal → stream** | Lee los streams de Flussonic y empareja cada canal: nombre escrito a mano → nombre exacto → nombre contenido → parecido por palabras (≥ 0,6). Nunca asigna el mismo stream a dos canales y los que no casan salen con **sugerencias** («quizá: …») |
| **Enviar todos por Flussonic** | Mapea lo que falte, **apaga el motor local**, pone la salida por la API (`PATCH /streamer/api/v3/streams/{nombre}`, sin reescribir el stream entero) y **verifica** que quedó puesta |
| **Volver todo a TVLister** | **Quita primero** la salida en Flussonic y después arranca el motor local: nunca dos emisores al mismo grupo |
| Tabla por canal | stream, destino UDP, estado (**Emitiendo / Stream caído / Sin salida / Stream no existe**) y los Mbps que reporta Flussonic |
| **Verificar** | Relee Flussonic cada 15 s; si un stream se cae o pierde la salida, se ve al instante |
| Envío por rango | Desde CH / Hasta CH, para mover sólo una parte del dial |

**Sin reiniciar:** un reconciliador compara cada 4 s el motor que corre con el que dice la base de datos; si
cambió (panel, API o terminal) recrea el worker de ese canal.

**API:** `GET /api/wk2500/flussonic-control` · `POST /api/wk2500/flussonic-control/auto-map` ·
`POST /api/wk2500/flussonic-control/switch` (`{ engine, all | ch_start/ch_end | catv_ch }`).

**Terminal:**

```bash
tvlister-admin catv flussonic status      # quién empuja el UDP y el estado de cada canal
tvlister-admin catv flussonic map         # vista previa del mapeo
tvlister-admin catv flussonic map --apply # guardarlo
tvlister-admin catv flussonic apply 2-125 # mandar esos canales por Flussonic
tvlister-admin catv flussonic verify
tvlister-admin catv flussonic local 2-125 # devolverlos a TVLister
```

## Pruebas

| Prueba | Resultado |
| --- | --- |
| `node scripts/test_catv_flussonic_control.mjs` | **25 OK** — panel real + Flussonic simulado (API v3): mapeo exacto y por parecido, salida aplicada con el host:puerto exacto, verificación por canal, **0 datagramas** de TVLister mientras el canal está delegado, vuelta a local quitando la salida y el motor local emitiendo otra vez |
| `node scripts/test_catv_flussonic_ui.mjs` | **23 OK** — la tarjeta real en jsdom: botones, tabla con estados, aviso de canales sin coincidencia y los POST que se envían |
| `node scripts/test_catv_udp_pacer.mjs` | **20 OK** — el pacer sigue probado, ahora opt-in, con la resincronización a 0x47 |
| VOD, balanceadores y afinidad de nodos | sin regresiones (`test_vod_genres`, `test_balancer_lb`, `test_node_affinity` OK) · `npm run build` OK |

## Instalar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.33/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.33
```

En un panel ya instalado: `tvlister-admin update` + **Ctrl+F5**. Si venías de la v2.6.32 con el pacer activo,
esta versión lo apaga sola: **no hay que tocar nada** y los canales vuelven a salir como en la v2.6.31.
