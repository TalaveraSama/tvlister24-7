# TVLister 24/7 v2.6.35 — las salidas UDP de Flussonic, desde el panel

> **Corrección de esta versión (v2.6.35):** si el canal quedaba en modo Flussonic (`take_over`), el
> reconciliador de 4 s **reescribía** la salida que acababa de poner el push, perdiendo la interfaz
> (`ens37@`) y añadiendo `ttl`/`pkt_size`. Ahora el motor delegado **no toca** una salida que ya apunta al
> mismo `IP:puerto` y, cuando tiene que escribirla, usa el mismo formato (`udp://ens37@IP:PUERTO`).
> Cubierto por una prueba nueva: tras 5 s, la salida sigue exactamente igual.

**Lo pedido:** «los canales ya los tiene Flussonic y yo sólo agrego en push la salida UDP de manera manual;
quería una sección que controle los canales de Flussonic y agregue la salida UDP a Flussonic, que ya tiene
salida UDP, más sencillo, más práctico, ya tienes la lista de canales».

Se acabó el ir stream por stream a *Push live video to certain URLs*. La tarjeta nueva hace exactamente eso,
con la lista de canales que ya tiene el panel.

## 1. «Salidas UDP de Flussonic (push)» — la tarjeta nueva

En **UDP / CATV**, arriba de todo:

| Columna | Qué muestra |
| --- | --- |
| **Stream en Flussonic** | Todos los streams que ya existen en tu Flussonic |
| **Canal** | A qué canal de la lista corresponde (`CH12 · CANAL 12`) y cómo se emparejó |
| **Salida UDP (push)** | La URL que tiene el push, **editable**. Si el canal tiene otra IP/puerto, se ve debajo en ámbar |
| **Estado** | `Emitiendo`, `Puesta`, `Otra IP/puerto` o `Sin salida`; avisa si el stream está caído |
| **Enviado** | Los MB que reporta Flussonic, como el `running · 134.2 MB` de su pantalla |
| **Guardar / Quitar** | Escribe ese push en Flussonic al instante |

Las salidas que **no son UDP** (rtmp, srt, http) se muestran pero **nunca se tocan**.

## 2. Por rango y con la lista de canales

| Botón | Qué hace |
| --- | --- |
| **Ver plan del rango** | Calcula `CH → stream → udp://IP:PUERTO` y lo pone en la tabla **sin escribir nada** |
| **Poner salida UDP del rango** | Lo aplica en Flussonic (un `PATCH` por stream, sin reescribir el stream entero) |
| **Quitar salidas del rango** | Quita sólo la salida UDP del canal; el resto del stream queda igual |
| **Interfaz (opcional)** | Si escribes `ens37`, la salida queda como `udp://ens37@239.1.1.2:1002` (el mismo formato de tu pantalla). Se guarda para la próxima vez |
| **Apagar TVLister en esos canales** | Marcado por defecto: evita dos emisores al mismo destino |

Si un stream ya tenía otra salida UDP, al aplicar desde la lista **se queda una sola: la del canal** (es lo que
haría el operador a mano). Si se edita una fila a mano, se escribe exactamente lo que se ve, sin añadidos.

## 3. Desde la terminal

```bash
tvlister-admin catv flussonic push                                  # estado: stream, canal, URL, MB
tvlister-admin catv flussonic push --range 2-125                    # vista previa (no escribe)
tvlister-admin catv flussonic push --range 2-125 --iface ens37 --apply
tvlister-admin catv flussonic push --range 2-125 --remove --apply
tvlister-admin catv flussonic push --stream "NACIONAL 2" --url udp://ens37@239.1.1.2:1002 --apply
```

## 4. API

| Ruta | Qué hace |
| --- | --- |
| `GET /api/wk2500/flussonic-push` | Streams con su push, estado, MB y su canal de la lista |
| `POST /api/wk2500/flussonic-push` | `{from_channels:true, ch_start, ch_end, action:'apply'\|'remove', dry_run, iface, take_over}` o `{items:[{stream, url, remove}]}` |
| `POST /api/wk2500/flussonic-push/interface` | Guarda la interfaz de salida por defecto |

## 5. Comprobado ejecutando el código real

`scripts/test_catv_flussonic_push.mjs` — **40 comprobaciones OK** contra el panel real y un Flussonic
simulado (API v3 con `outputs` y `stats.push`):

| Caso | Resultado |
| --- | --- |
| `udp://ens37@239.1.1.2:1002` y `udp://239.1.1.2:1002` | Son el mismo destino (no se duplica el push) |
| Vista previa del rango | 3 canales planeados, **0 PATCH** |
| Aplicar | cada stream con `udp://ens37@239.1.1.2:<puerto del canal>`, todo por `PATCH` |
| Push anterior en otra IP | se reemplaza: **una sola salida UDP** por stream |
| Salida `rtmp://` del usuario | **intacta** antes, durante y después |
| Quitar del rango | CH2 y CH3 sin UDP, CH4 sin tocar, rtmp sigue |
| Fila a mano | se guarda tal cual (`udp://239.5.5.5:5555`, sin añadir interfaz) |
| URL que no es UDP | rechazada con motivo, también en la vista previa |
| Stream inexistente | `HTTP 404` informado, sin tumbar el panel |
| `take_over` | el canal pasa a Flussonic y TVLister deja de emitir: **0 datagramas** |
| Flussonic caído | `flussonic_reachable:false` con el motivo; el panel sigue en pie |
| Reconciliador tras `take_over` | a los 5 s la salida sigue `udp://ens37@127.0.0.1:4776`, sin reescrituras |

`scripts/test_catv_flussonic_push_ui.mjs` — **33 comprobaciones OK** sobre la página renderizada (jsdom):
tarjeta, tabla, estado, MB, filtros, vista previa, aplicar, quitar, edición de fila y de interfaz.

Sin regresiones: `test_catv_flussonic_control.mjs` (25 OK), `test_catv_flussonic_ui.mjs` (23 OK),
`test_catv_udp_pacer.mjs` (20 OK), VOD, balanceo y afinidad. `npm run build` OK.

## 6. Instalar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.35/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.35
```

En un panel ya instalado: `tvlister-admin update` y **Ctrl+F5**.
