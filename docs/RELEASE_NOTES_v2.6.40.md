# TVLister v2.6.40 — devolver a TVLister los canales que quedaron sin salida

Sobre v2.6.39 (el push escribe de verdad en Flussonic 23.12).

## Qué arregla

Después del fallo del push, un panel puede quedar con canales **en Flussonic y sin salida UDP**: no emiten por
nadie. Ahora la tarjeta lo dice y ofrece la vuelta:

- Caja ámbar **«N canal(es) están en Flussonic pero sin salida UDP»** con el botón **Devolver a TVLister**.
- La API devuelve `has_source` por canal, así que sólo se devuelven los que tienen fuente en TVLister.
- Devolver un canal **sin stream mapeado** ya no falla con «Falta el nombre del stream»: no hay nada que quitar
  en Flussonic.
- Un canal **sin fuente local** (vive sólo en Flussonic) se rechaza con el motivo claro, en vez de arrancar un
  emisor sin señal.
- `POST /api/wk2500/flussonic-control/switch` acepta `channels: [2,3,4]`.
- `has_output` = el stream tiene alguna salida UDP; `in_sync` = es exactamente la del canal.

## Recuperar un panel afectado

1. `tvlister-admin update` y **Ctrl+F5**.
2. **«Poner salida UDP del rango»**: escribe en Flussonic y confirma releyendo cada stream.
3. Lo que siga sin salida aparece en la caja ámbar, con **Devolver a TVLister**.

## Pruebas

`test_catv_flussonic_push` **74 OK** (Flussonic de prueba que rechaza `PATCH` y los cuerpos con `inputs` de
estado; otro que responde 200 sin guardar; devolución por lista, sin stream mapeado y sin fuente local) ·
`push_ui` **56 OK** · control 25 · ui 28 · pacer 20 · VOD/géneros 55 · balanceo 36 · afinidad 29 · paginación 21.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.40/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.40

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```
