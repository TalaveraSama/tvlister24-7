# TVLister v2.6.41 — el panel se adapta al Flussonic que haya (y si no puede, lo enseña)

Sobre v2.6.39/v2.6.40. Hay instalaciones de Flussonic 23.12 que siguen devolviendo `HTTP 400` al `PUT` de la
salida UDP aunque el cuerpo sea sólo `{"outputs":[…]}`. En vez de apostar a una única forma:

## Qué cambia

- Se prueban **seis formas** de cuerpo, en orden: `outputs` con objetos, `outputs` con URLs, `push` con objetos,
  `push` con URLs, el stream completo saneado (sin `stats`/`id`/`effective`; entradas reducidas a `{url}`) y su
  variante en texto. Cada intento se **verifica releyendo el stream**: sólo cuenta si la salida quedó puesta.
- La forma que funciona se **recuerda** (`settings.flussonic_write_shape`) y se usa para el resto de canales.
- Si ninguna funciona, el error dice **qué se probó y qué respondió el servidor** (`outputs→400 {…} | push→400
  {…} | … (+N)`) y remite a un diagnóstico:

```bash
tvlister-admin catv flussonic probe a0ed --url udp://ens37@239.1.1.2:1002
```

  que enseña el stream (claves, `static`, `named_by`, entradas/salidas), prueba cada forma con su **HTTP y
  respuesta exacta**, prueba además la URL **sin la interfaz** para saber si el problema es el prefijo `ens37@`,
  y **deja el stream como estaba**.
- `POST /api/wk2500/flussonic-push/probe {stream, url}` expone lo mismo por API.

## Pruebas

`test_catv_flussonic_push` **80 OK**, entre ellas un Flussonic de prueba que **sólo acepta `{"push": …}`**: el
panel lo descubre solo, escribe y la forma queda aprendida. `push_ui` 56 · control 25 · ui 28 · pacer 20 ·
VOD/géneros 55 · balanceo 36 · afinidad 29 · paginación 21.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.41/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.41

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

Después: **Ctrl+F5**, «Poner salida UDP del rango» y, si algo falla,
`tvlister-admin catv flussonic probe <stream>` y pega la salida.
