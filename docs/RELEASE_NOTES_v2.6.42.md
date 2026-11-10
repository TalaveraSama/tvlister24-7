# TVLister v2.6.42 — detectar `config_external` cuando Flussonic rechaza todo

Sobre v2.6.41. Si **todas** las formas de escritura devuelven 400, hay una causa que explica el patrón
completo: el servidor tiene `config_external` y, en ese modo, Flussonic **rechaza cualquier cambio de stream
por API** (los streams los define ese backend).

## Qué cambia

- Al fallar todas las formas, el panel lee `GET /streamer/api/v3/config` y, si hay `config_external`, lo dice
  en el error, con qué hacer: editar la salida en ese backend o quitar `config_external`.
- `tvlister-admin catv flussonic probe <stream>` imprime `config_external` cuando existe.

## Pruebas

`test_catv_flussonic_push` 80 OK · `push_ui` 56 · `control` 25 · `ui` 28 · `pacer` 20 · regresiones 55/36/29/21.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.42/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.42

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```
