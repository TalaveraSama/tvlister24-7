# TVLister 24/7 — v2.5.27 «Canal 1 disponible (y el 125 sigue)»

Sí se puede: la grilla pasa de **2–125 (124 portadoras)** a **1–125 (125 portadoras)**. El
canal 125 ya estaba; lo nuevo es el **canal 1**.

```bash
tvlister-admin release v2.5.27
tvlister-admin catv check          # avisa de lo que implica el CH 1
tvlister-admin catv names --apply  # incluye el nombre del CH 1
```

## 1. Qué se ha cambiado

| Antes | Ahora |
| --- | --- |
| Grilla 2–125, 124 portadoras | Grilla **1–125, 125 portadoras** |
| `CHECK (catv_ch >= 2)` en la base | `CHECK (catv_ch >= 1)` con **migración automática** |
| Canal 1 sin frecuencia | **45.25 MHz vídeo / 49.75 MHz audio** (NTSC-M, 44–50 MHz) |
| 124 nombres | **125** (el CH 1 arranca como «CANAL 1», editable) |

La migración reconstruye la tabla una sola vez conservando todos los datos (probado: 124 filas
antes, 124 filas + CH 1 después, nombres y puertos UDP intactos).

Un equipo de **125 canales** ahora cubre la grilla completa él solo: `WK2500 1: CH1–32`,
`CH33–64`, `CH65–96`, `CH97–125` con tus cuatro unidades de 32.

## 2. Lo que tienes que saber del canal 1 (importante)

El canal 1 ocupa **44–50 MHz**. En EE. UU. esa banda está asignada a servicios móviles y
radioastronomía (no es un canal de difusión), y en una planta de cable queda **pegada al camino
de retorno (5–42 MHz)**. Consecuencias reales:

- **Puede meter ruido al upstream** de tu red de datos si compartes coaxil o si hay amplificadores
  con retorno activo. Si tienes retorno, revisa que el filtro de 42 MHz esté bien.
- **Muchos televisores y decos no sintonizan el canal 1**: la mayoría empieza a buscar en el 2.
  No es que no llegue la señal, es que el sintonizador no lo ofrece.
- Algunos moduladores (según firmware) sólo aceptan 2–125 en su tabla de frecuencias; si el
  WK2500/CSP-2500C no lo deja, no hay forma de emitirlo desde el equipo.

Por eso `tvlister-admin catv check` lo marca como **aviso** (no error) con los datos exactos:

```
  [!]  El canal 1 emite en 45.25 MHz (44–50 MHz)
         45.25 MHz vídeo / 49.75 MHz audio (NTSC-M). Banda compartida con servicios
         móviles y pegada al retorno del cable (5–42 MHz)…
```

**Mi recomendación:** si el objetivo es tener 125 portadoras, usa el 1 sólo si tus abonados lo
sintonizan. Si no, el **125** ya lo tienes y es el más seguro (799.25 MHz, ultrabanda).

## 3. Cómo se aplica

- **Plan**: al abrir *CATV WK2500* verás la fila del CH 1 con su frecuencia y su nombre.
- **Equipos**: `quick-setup` ya reparte desde el 1 (`CH1–32`, `CH33–64`, `CH65–96`, `CH97–125`).
- **Nombres**: `tvlister-admin catv names --apply` escribe las 125 etiquetas (CH 1 = «CANAL 1»;
  cámbialo en `docs/canales_analogos_2_125.txt` o desde la tarjeta del panel).
- **CSV para el modulador** (equipo 1):

```
Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,Nombre_Canal
1,1,45.25,49.75,CANAL 1
2,2,55.25,59.75,NACIONAL
3,3,61.25,65.75,TELEMUNDO
```

- **Motor UDP** (`catv udp-engine`, Flussonic incluido) acepta ya el canal 1.

## 4. Lo que NO cambia

- Frecuencias del 2 al 125: **idénticas** (55.25 … 799.25 MHz).
- UDP, `pkt_size`, TTL, NIC dedicada y streams asignados: intactos.
- El canal 125 sigue exactamente como estaba.
- Si nunca usas el CH 1, no tienes que hacer nada: la portadora queda vacía y sin emitir.

## 5. Pruebas

| Prueba | Resultado |
| --- | --- |
| Base antigua (CHECK >= 2) con 124 filas → `initDb` | tabla migrada, 124 filas y datos intactos |
| Insertar CH 1 después de migrar | aceptado |
| Base nueva desde cero | 125 slots, rango 1–125 |
| `initDb` ejecutado dos veces | migración idempotente, sin duplicar |
| Frecuencias | CH1 45.25/49.75 · CH2 55.25 · CH125 799.25 |
| `PUT /api/wk2500/channels/1` | 200; el canal 0 → 400 «entre 1 y 125» |
| `quick-setup` desde 1 | CH1–32 / 33–64 / 65–96 / 97–125, 125 cubiertas, 0 sin cubrir |
| CSV por equipo | CH 1 presente con 45.25/49.75 |
| Nombres | 125 filas, CH 1 = «CANAL 1» |
| `catv check` | aviso del CH 1 con frecuencia y recomendación |
| `catv udp-engine` con CH 1 | aceptado |
