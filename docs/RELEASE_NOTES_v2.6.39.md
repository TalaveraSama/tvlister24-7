# TVLister v2.6.39 / v2.6.40 — el push escribe de verdad en Flussonic 23.12

Corrige el `HTTP 400 · parsing_parameters` que dejaba las salidas UDP sin guardar y los canales sin emisor.

## Qué pasaba

- La API v3 de Flussonic se actualiza con **PUT** (JSON merge patch). El panel probaba `PATCH` primero y, al
  fallar, hacía `GET` del stream y reenviaba **el stream entero**, con `inputs` y sus campos de estado
  (`stats`, `id`, `mixer_strategy`). Flussonic valida el cuerpo y responde **400 «parsing_parameters»**.
- Resultado: `0 de 105 stream(s) con la salida UDP del canal`, todas las filas en «Sin salida», y los canales
  que ya estaban en modo Flussonic se quedaban **sin emisor**.

## Qué cambia

- Se escribe **sólo** `{"outputs":[{"url":"udp://…"}]}` por **PUT**; la lista de URLs y el `PATCH` quedan como
  respaldo para instalaciones que no acepten la forma nueva.
- **Se relee el stream** tras escribir: si Flussonic responde 200 pero no guarda, se informa como fallo.
- El canal **sólo pasa a Flussonic si la salida quedó confirmada**; si falla, sigue emitiendo desde TVLister.
- Aviso en la tarjeta con **Devolver a TVLister** para los canales que Flussonic dejó sin salida (los que
  tienen fuente local).
- El mensaje del 400 ya no vuelca el JSON crudo: explica el motivo y qué revisar.
- Los nombres de servicio del TS (`mpegts.service_name`) usan el mismo PUT parcial.

## Cómo recuperar un panel afectado

1. `tvlister-admin update` y **Ctrl+F5**.
2. Pulsar otra vez **«Poner salida UDP del rango»**: ahora escribe y lo confirma releyendo cada stream.
3. Si algo sigue sin salida, la caja ámbar lo dice y ofrece **Devolver a TVLister**.

## v2.6.40 (sobre v2.6.39)

- `GET /api/wk2500/flussonic-push` devuelve **`has_source`** en cada canal: la caja ámbar y el botón
  **Devolver a TVLister** saben qué canales tienen fuente en TVLister y cuáles no.
- Devolver a TVLister un canal **sin stream mapeado** ya no falla con «Falta el nombre del stream»: no hay nada
  que quitar en Flussonic y el canal vuelve a emitir.
- Un canal **sin fuente local** se rechaza con el motivo claro en vez de arrancar un emisor sin señal.
- `has_output` vuelve a significar «el stream tiene alguna salida UDP» (la comparación con el destino del canal
  sigue en `in_sync`).

## Pruebas

- `test_catv_flussonic_push` **74 OK** — incluye un Flussonic de prueba que rechaza `PATCH` y cualquier cuerpo
  con `inputs` de estado, y otro que responde 200 sin guardar. Se comprueba que el canal **no** se pasa a
  Flussonic cuando la escritura falla.
- `test_catv_flussonic_push_ui` **56 OK** — aviso de canales sin salida y devolución a TVLister.
- `control` 25 · `ui` 28 · `pacer` 20 · VOD/géneros 55 · balanceo 36 · afinidad 29 · paginación 21.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.40/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.40

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```
