# TVLister v2.6.38 — la tabla del push, sólo lo que importa

Sobre v2.6.37 (el panel guarda la salida en Flussonic y deja de emitir).

## Qué cambia

- La tabla de «Salidas UDP de Flussonic (push)» abre en **Canales con stream asignado**, no con los 124
  canales del rango. El selector permite ver **todos**, los **sin stream** o los que tienen **salida puesta**.
- Al emparejar un canal con su stream, la tabla **vuelve a «con stream»** y muestra la fila recién asignada
  (antes el canal desaparecía de la vista).
- La API de `GET /api/wk2500/flussonic-push` devuelve `has_output` por canal.
- Si el filtro deja la tabla vacía, se explica cómo cambiarlo.

## Lo que no cambia

- El UDP de los canales y la línea de argumentos de FFmpeg quedan igual.
- Toda la regla de v2.6.37 sigue en pie: `udp_engine = flussonic` ⇒ TVLister no emite, sólo escribe el texto
  de la salida en Flussonic y lo vigila.
- Clientes Xtream/XUI, M3U y `/live/:user/:pass/…` intactos.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.38/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.38

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

## Pruebas

- `test_catv_flussonic_push` 65 OK · `test_catv_flussonic_push_ui` **52 OK** · `control` 25 · `ui` 28 ·
  `pacer` 20 · regresiones (vod_genres 55, balancer_lb 36, node_affinity 29, vod_paging 21).
- Instalación limpia verificada por HTTP real sobre v2.6.37 (misma base de código del push): guardar una
  salida deja `panel_emitting: 0`, canal sin fuente local recibe su salida, reinicio del panel no reabre el
  emisor y «volver a TVLister» reemite (597 datagramas en 2,5 s).
