# TVLister v2.6.49 — fuera la pestaña «Flussonic UDP · push»

Sobre v2.6.48. Se retira del panel la **salida UDP de Flussonic por canal**. El tema UDP/Flussonic queda para
después; la pantalla CATV se queda con lo que hace falta hoy: las **plantillas de los WK2500**.

## Qué se fue

- La pestaña **`3 · Flussonic UDP · push`** y todo su contenido: tabla de streams, rango de canales, interfaz de
  salida, mapeo canal→stream y «Nombre del canal en el TS».
- Su API: `GET/POST /api/wk2500/flussonic-push`, `/probe`, `/map`, `/titles`, `/interface`.
- El subcomando `tvlister-admin catv flussonic push`.
- Sus dos pruebas: `test_catv_flussonic_push.mjs` y `test_catv_flussonic_push_ui.mjs`.

La pantalla queda con **dos** pestañas:

1. **Nativo TVLister** — moduladores de 32 / 64 / 125, armado rápido, interfaz de red dedicada, nombres de las
   portadoras, grilla de canales 2–125 y **plantillas CSV** por modulador y del plan completo.
2. **Flussonic · quién emite** — qué canal lo empuja Flussonic y cuál TVLister, con «enviar», «verificar» y
   «volver a local», sin dos emisores. Sin cambios.

## Qué se queda igual

- La escritura de la salida UDP que hace el panel al **pasar un canal a Flussonic**: mismas formas de cuerpo
  (`outputs`, `iface_field`, `outputs_text`, `push`, `push_text`, `full`, `schema:full`) y misma relectura de
  confirmación.
- El diagnóstico `tvlister-admin catv flussonic probe <stream>` (no deja nada cambiado; sirve para seguir con el
  23.12 real).
- La base de datos: no se borra ni una fila ni una columna (`udp_engine`, `flussonic_output_url`,
  `catv_push_interface`… se quedan).
- El motor UDP propio, el pacer y el resto de la página CATV.

## Pruebas

- `scripts/test_catv_flussonic_ui.mjs` — ahora comprueba que la pestaña del push **no** está en la pantalla; el
  resto (dos pestañas, tabla de quién emite, envío por rango, «volver a local») sigue OK.
- `scripts/test_catv_flussonic_control.mjs` **25 OK** · `test_catv_udp_pacer.mjs` OK.
- Pruebas retiradas junto con la función: `test_catv_flussonic_push.mjs` (65 OK) y `test_catv_flussonic_push_ui.mjs`
  (60 OK).

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.49/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.49

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

> Si tenías canales con la salida ya puesta en Flussonic, **siguen funcionando**: esto sólo quita la pantalla que
> la editaba. Los canales se mueven igual desde **2 · Flussonic · quién emite**.
