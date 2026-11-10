# TVLister 24/7 v2.6.37 — el panel guarda el UDP en Flussonic y no emite

**Lo pedido:** «el panel tiene que guardar en Flussonic el UDP; el panel no emite UDP cuando el control lo
tiene Flussonic, el panel sólo lo que hace es enviarle el texto de salida UDP».

Eso es exactamente lo que hace ahora, y está comprobado midiendo datagramas.

## 1. La regla, sin casillas ni dudas

| Situación | Quién emite | Qué hace el panel |
| --- | --- | --- |
| El canal está en **TVLister** (`udp_engine = local`) | TVLister | Abre su socket / FFmpeg hacia la IP:puerto del canal |
| El canal está en **Flussonic** (`udp_engine = flussonic`) | **Flussonic** | **Nada**: sólo escribe la salida en Flussonic por su API y vigila que siga puesta. **Cero datagramas** |

- Al guardar una salida en la tarjeta **Flussonic UDP · push**, el canal **pasa a Flussonic y TVLister apaga su
  emisor** en ese mismo momento. Ya no hay una casilla que se pueda dejar mal: es el comportamiento por defecto
  (`take_over` sólo se puede desactivar a propósito, por API o con `--keep-local` en la terminal).
- Se quitó la casilla «Apagar TVLister…» y en su lugar se explica la regla: *«El panel no emite este UDP: sólo
  escribe la salida en Flussonic».*
- Hay una **red de seguridad** en cada petición: cualquier canal que esté en Flussonic y todavía tenga un socket
  local abierto se cierra ahí mismo.

## 2. Canales cuya fuente está sólo en Flussonic

Antes la tarjeta sólo listaba canales con fuente local (`stream_id` o `custom_source_url`). Si el canal vive en
Flussonic (lo normal en tu caso), no aparecía y no se le podía poner la salida. Ya sí:

- La lista y el plan del push incluyen **todo canal con destino UDP**, tenga o no fuente en TVLister.
- El vigilante del canal delegado (el que reaplica la salida si alguien la borra en Flussonic) **ya no exige
  fuente local** y arranca también después de reiniciar el panel.

## 3. Lo que ves en el panel

- Por fila: **`TVLister apagado`** cuando el canal lo controla Flussonic; si sigue en local, dice si
  **está emitiendo** y ofrece `volver a TVLister`.
- Al aplicar, el aviso lo confirma: *«TVLister no emite: el UDP lo pone Flussonic»*.
- Si quitas una salida de un canal que ya es de Flussonic, avisa de que ese canal **queda sin emisor** (ni
  Flussonic ni el panel) hasta que lo devuelvas con `volver a TVLister`.
- La API devuelve `panel_emitting` (0 = el panel no emite ninguno) y `emitters` por canal.

## 4. Terminal

```bash
tvlister-admin catv flussonic push --range 2-125 --apply          # escribe la salida y apaga TVLister
tvlister-admin catv flussonic push --range 2-125 --apply --keep-local  # a propósito: los dos emiten
tvlister-admin catv flussonic push --stream a0ek --url udp://ens37@239.1.1.2:1002 --apply
tvlister-admin catv flussonic local 2-125                          # devolver a TVLister
```

## 5. Comprobado ejecutando el código real

`scripts/test_catv_flussonic_push.mjs` — **65 OK**, con un FFmpeg de mentira y un Flussonic simulado:

| Comprobación | Resultado |
| --- | --- |
| CH3 emitiendo desde TVLister | **400 datagramas** en 2,5 s |
| Se le guarda la salida en Flussonic (una fila) | push escrito y canal pasado a Flussonic |
| Después de guardar | **0 datagramas** de TVLister al mismo destino |
| El plan lo confirma | `live_engine = flussonic_api` |
| La tabla por canal | `panel_emitting: false` |
| Canal sin fuente local (`a0zz`) | la salida se escribe igual: `udp://ens37@127.0.0.1:4777`, panel sin emitir |
| «Volver a TVLister» | retira la salida de Flussonic y el panel vuelve a emitir |
| Quitar una salida de un canal delegado | avisa: ese canal queda **sin emisor** |
| Reconciliador a los 5 s | no reescribe ni pierde la salida (`ens37@`, sin `ttl`) |

`test_catv_flussonic_push_ui.mjs` **51 OK** (marca `TVLister apagado`, explica la regla, sin casilla de
duplicar emisor) · `test_catv_flussonic_ui.mjs` **28 OK** · `test_catv_flussonic_control.mjs` **25 OK** ·
`test_catv_udp_pacer.mjs` **20 OK**. Sin regresiones: VOD/géneros 55 OK, balanceo 36 OK, afinidad 29 OK,
paginación 21 OK; `npm run build` OK.

## 6. Instalar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.37/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.37
```

En un panel ya instalado: `tvlister-admin update` y **Ctrl+F5**.
