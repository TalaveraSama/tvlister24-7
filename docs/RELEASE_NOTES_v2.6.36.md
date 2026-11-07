# TVLister 24/7 v2.6.36 — la página CATV ordenada en tres mundos

**Lo pedido:** «no entiendo, eso es un solo revoltijo, no entiendo qué toca: ordena bien lo que es nativo, lo que
es Flussonic y Flussonic UDP… también Flussonic debe poner los nombres de servicio de cada canal para
identificarlos en el IP analógico al escanearlo».

## 1. Tres pestañas, un solo mundo a la vez

La página **CATV WK2500 · Flussonic** ya no mezcla las tres cosas. Arriba hay tres botones y sólo se abre el
que se elige:

| Pestaña | Qué hay dentro | Quién manda |
| --- | --- | --- |
| **1 · Nativo TVLister** (UDP 2–125) | Tus moduladores y el **armado rápido** (32/64/125), la **Interfaz de Red Dedicada**, los **Nombres de las portadoras (CH 1 al 125)**, la plantilla IP/puerto, el troncal MNF y la **grilla de canales** con su motor | TVLister |
| **2 · Flussonic · quién emite** | Qué canal empuja Flussonic y cuál TVLister; enviar, verificar y volver sin dos emisores. Incluye el cambio manual por rango (avanzado) | Flussonic como emisor |
| **3 · Flussonic UDP · push** | La **salida UDP de cada canal** (lo que antes se escribía a mano en *Push live video to certain URLs*) y el **nombre con el que se identifica al escanear** | Flussonic como salida UDP |

Lo que estaba bien se queda igual, sólo que ahora bajo **Nativo**: el armado rápido de equipos (va con los IP
analógicos y la lista UDP), la interfaz dedicada y la lista de nombres de portadoras. El nombre del menú lateral
pasa a **CATV WK2500 · Flussonic (UDP 2–125)**.

## 2. El «revoltijo» de nombres: elegir el stream a mano

En tus imágenes los streams de Flussonic se llaman **`a0ek`, `a0cq`, `a0di`…** (su título es *A&E*, *A3 Cine*,
*AMC*…) y tu lista repite **`NACIONAL`** en nueve canales. Emparejar por nombre ahí sólo puede salir mal.

- **El mapeo automático ya no usa un nombre repetido.** Si un nombre lo comparten varios canales, ese canal
  queda **sin asignar** y se avisa: *«El nombre “NACIONAL” lo comparten 9 canales: asígnalo a mano»*. Sólo
  empareja cuando el nombre es propio del canal (p. ej. `A3 CINE` ↔ *A3 Cine*).
- **La tabla del push ahora es por canal**, como tu lista: `CH`, **portadora**, **una lista desplegable con los
  streams de Flussonic** (con su título: `A3 Cine · a0cq`), la salida UDP y el estado. Eliges el stream y queda
  guardado; si estaba en otro canal, se libera de allí (un stream nunca en dos canales).
- Cada fila dice **quién emite** ese canal (`por Flussonic` / `por TVLister`) y si su push apunta a **otra
  IP/puerto**.

## 3. El nombre de servicio, para reconocerlo al escanear

Bloque nuevo dentro de la pestaña 3: **«Nombre del canal en el TS»**.

- **Ver qué nombres se escribirían** — no escribe nada.
- **Aplicar nombres** — escribe en cada stream el nombre de su portadora como **nombre de servicio del TS**
  (`mpegts.service_name`, que es lo que leen los equipos en la SDT). Si esa versión de Flussonic no guarda ese
  campo, se escribe en `title`, que es lo que Flussonic usa por defecto como nombre del servicio. Se comprueba
  leyendo otra vez el stream, así que el panel dice **qué campo quedó**.

Resultado: al escanear la salida del modulador el canal aparece con su nombre (`NACIONAL`, `UNIMAS`, …) y no
como `a0ek`.

## 4. Terminal

```bash
tvlister-admin catv flussonic push                          # estado: CH, portadora, stream, salida, estado, MB
tvlister-admin catv flussonic push --map 4 --stream a0ek    # asignar el stream de un canal a mano
tvlister-admin catv flussonic push --titles                 # ver los nombres de servicio
tvlister-admin catv flussonic push --titles --apply         # escribirlos en Flussonic
tvlister-admin catv flussonic push --range 2-125 --apply    # poner la salida UDP del rango
tvlister-admin catv flussonic push --range 2-125 --remove --apply
```

## 5. API

| Ruta | Qué hace |
| --- | --- |
| `GET /api/wk2500/flussonic-push` | Streams **y** la vista por canal (`channels`) con su portadora, stream, salida y estado |
| `POST /api/wk2500/flussonic-push/map` | `{catv_ch, stream}` — asignar a mano (o `stream: ""` para quitar) |
| `POST /api/wk2500/flussonic-push/titles` | `{dry_run, ch_start, ch_end}` — nombre de servicio del TS |
| `POST /api/wk2500/flussonic-push` | `{from_channels…}` o `{items:[{stream, url, remove}]}` |

## 6. Comprobado ejecutando el código real

| Prueba | Resultado |
| --- | --- |
| `test_catv_flussonic_push.mjs` | **52 OK** — incluido «CH8 con nombre NACIONAL repetido **no** se empareja», «CH10 (A3 CINE) sí por su nombre», asignación a mano `a0ek → CH8`, un stream nunca en dos canales, nombre de servicio escrito en `mpegts.service_name` y verificado, vista previa sin escribir, y todo lo anterior del push (rtmp intacto, reemplazo de la UDP, quitar, `take_over` con 0 datagramas, reconciliador que no pisa) |
| `test_catv_flussonic_push_ui.mjs` | **48 OK** — las tres pestañas, la tabla por canal, el desplegable de streams, el aviso del nombre repetido, guardar/quitar, y los nombres de servicio |
| `test_catv_flussonic_ui.mjs` | **28 OK** — el control de Flussonic ahora se abre en su pestaña |
| `test_catv_flussonic_control.mjs` | 25 OK · `test_catv_udp_pacer.mjs` 20 OK |
| Regresiones | VOD y géneros 55 OK, balanceo 36 OK, afinidad 29 OK, paginación 21 OK; `npm run build` OK |

## 7. Instalar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.36/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.36
```

En un panel ya instalado: `tvlister-admin update` y **Ctrl+F5** (la página cambia de pestañas: no hay que
reconfigurar nada; los datos de canales y streams son los mismos).
