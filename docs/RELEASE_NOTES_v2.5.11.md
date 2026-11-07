# TVLister 24/7 — v2.5.11 «Nombre real del canal y UDP sin ráfagas»

Dos cosas de la página *IP Input* del modulador:

1. El nombre del programa sigue saliendo **`Service01`** aunque el CSV lleve `CANAL2_NACIONAL`.
2. El UDP **«sube demasiados megas»**: 30 Mbps en una portadora que lleva 2–3.

Las dos tienen causa concreta y las dos quedan medidas, no explicadas.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.11
tvlister-admin restart
```

Después, **reiniciar los canales** (UDP / CATV → *Iniciar todo*) y en cada modulador pulsar **Refresh Input** una
vez: el equipo cachea el nombre que leyó al enganchar el flujo.

---

## 1. El nombre: la SDT, no el CSV

La página *IP Input* no lee el nombre del CSV: lo saca de la **SDT** (tabla de servicios) del TS que recibe.
FFmpeg, si nadie le dice lo contrario, escribe ahí:

```
service_provider = "FFmpeg"      service_name = "Service01"
```

Que es exactamente lo que se veía: `1: [2] Service01`. El nombre del CSV pinta la página *Canales* (la derecha),
no la de entrada.

La salida UDP ahora monta la SDT con el nombre del canal:

```
-metadata service_provider=TVLister -metadata service_name=<nombre del canal>
```

- Es **metadato del muxer**: vídeo y audio siguen en `-c copy`, sin re-codificar nada.
- Funciona con cualquier FFmpeg desde 2011 (`-metadata`, no una opción nueva).
- Nombre tomado de `custom_name`; si está vacío, del nombre del stream; recortado a 40 caracteres.

Verificado con FFmpeg real capturando la SDT del flujo enviado:

| Salida | SDT capturada |
| --- | --- |
| antes | `provider="FFmpeg" name="Service01"` |
| ahora | `provider="TVLister" name="CANAL 2 NACIONAL"` |

---

## 2. Las ráfagas: `-re` en la salida al modulador

Con `-c copy` y sin límite de ritmo, FFmpeg escribe **tan rápido como lee**. Si el origen entrega a trozos (un
segmento HLS de 2 s que aparece de golpe, o una reconexión que recupera lo perdido) esos 2 s salen en
milisegundos: el modulador marca un pico de decenas de Mbps en una portadora de 2–3.

Medido con `catv watch` sobre el mismo TS de 2,9 Mbps entregado en trozos de 2 s:

| Salida | Media | Pico | Ráfagas | Oscilación |
| --- | --- | --- | --- | --- |
| sin `-re` (hasta v2.5.10) | 4,87 Mbps | **58,42 Mbps** | **12×** | 331,7 % |
| con `-re` (v2.5.11) | 3,05 Mbps | 5,06 Mbps | 1,66× | 20,9 % |

- `-re` (leer a ritmo nativo) se añade **sólo** en la salida hacia el modulador, delante de `-i`.
- No se aplica a `pipe:0` (MNF) ni cuando la portadora ya lleva `muxrate` (un CBR ya marca el ritmo).
- **No toca la línea del motor HLS** que sirve a los clientes: es otra función (`buildFfmpegUdpOutputArgs`).
- Interruptor de seguridad si un origen concreto se atasca:

```bash
systemctl edit tvlister24-7       # añadir: Environment=TVLISTER_CATV_PACING=0
tvlister-admin restart
```

---

## 3. `catv watch` lo comprueba (menú 21)

Ahora muestra el **nombre DVB real** de lo que sale y el **perfil de ráfagas**:

```
  CANAL  EQUIPO           DESTINO UDP                  MEDIDO      PICO   PKT/S   DECLARADO
         NOMBRE DVB (lo que ve el modulador)                       PIDs
  CH2    CSP-2500C 1      239.9.9.1:7111            2.93 Mbps 3.54 Mbps     296   2.90 Mbps
        DVB: "CANAL 2 NACIONAL" · proveedor "TVLister" · service_id 2
        PIDs: 0x0100 0x0101 0x0000 · ráfagas 1.21× · oscilación 9.2%
  CH3    CSP-2500C 1      239.9.9.1:7112            2.92 Mbps 3.19 Mbps     295   2.90 Mbps
        DVB: "Service01" · proveedor "FFmpeg" · service_id 3
        [!!] el TS lleva el nombre genérico "Service01" en vez de "CH3 sin nombre DVB"
```

| Aviso | Qué significa |
| --- | --- |
| `el TS lleva el nombre genérico "Service01"` | ese canal aún corre con la salida sin nombre: reinícialo |
| `nombre DVB "X" distinto del canal "Y"` | el nombre del panel y el de la SDT no coinciden |
| `el TS no trae SDT` | el muxer no emite tabla de servicios |
| `RÁFAGAS: pico N Mbps = X× la media` | el flujo sale a saltos (≥ 2,5× la media) |
| `flujo inestable: oscilación N%` | variación tramo a tramo alta |
| `N tramo(s) de 500 ms sin datos` | cortes intermitentes |

Las ráfagas se miden en tramas de **500 ms**: el kernel entrega los datagramas a Node por lotes y con 100 ms se
estaría midiendo el lote de lectura, no la red.

> El PID nulo `0x1FFF` se excluye del contador de duplicados: en un mux CBR rellena con el mismo
> `continuity_counter` y daría miles de falsos positivos.

---

## Prueba realizada (FFmpeg real, no simulada)

| Caso | Resultado |
| --- | --- |
| Salida generada con los argumentos nuevos | `-re` presente · `-metadata service_name=CANAL 2 NACIONAL` |
| SDT capturada de ese flujo | `provider="TVLister" name="CANAL 2 NACIONAL" service_id=2` |
| Mismo flujo sin `-metadata` | `provider="FFmpeg" name="Service01"` → aviso de nombre genérico |
| Fuente a trozos de 2 s sin `-re` | pico **58,42 Mbps**, ráfagas 12× → aviso `RÁFAGAS` |
| Fuente a trozos de 2 s con `-re` | pico 5,06 Mbps, ráfagas 1,66× → sin aviso |
| Flujo CBR (`-muxrate`) | sin falsos duplicados tras excluir `0x1FFF` |
| Canal sin emisor | `NO LLEGA NADA` |
