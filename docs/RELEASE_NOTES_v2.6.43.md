# TVLister v2.6.43 — el panel escribe la salida como diga **tu** Flussonic

Sobre v2.6.42. Tu `flussonic.conf` **no tiene `config_external`**, así que esa pista no explicaba el `HTTP 400`.
En tu servidor los streams están definidos *nativamente* (`stream a0ed { … push udp://ens37@239.1.1.2:1002; }`),
y ahí el cuerpo del `PUT` tiene que ser exactamente el que espera **esa** versión. En vez de seguir probando
formas a ciegas, ahora se le pregunta al propio servidor.

## Qué cambia

- **Se lee el OpenAPI del servidor**: `GET /streamer/api/v3/schema` → ruta `PUT /streams/{name}` → su
  `requestBody` → la propiedad de tipo lista llamada `outputs`/`push`/`udp` y si sus elementos son objetos o
  texto. El panel escribe con esa forma **antes** que con las seis de siempre, y la recuerda.
- **Forma `schema:full`**: si el servidor rechaza todo cuerpo parcial, se le devuelve **su propio stream** tal
  como lo publica el `GET`, recortado a las propiedades que acepta su esquema (fuera `stats`, `effective`,
  entradas reducidas a su `url`) y con la salida puesta. Es lo que necesitan los 23.12 que exigen el objeto
  completo o que rechazan claves que no figuran en su OpenAPI.
- **`probe` más útil**: `tvlister-admin catv flussonic probe <stream>` imprime ahora la versión del esquema, el
  **campo de salidas que declara**, si es texto u objetos, la lista de propiedades del cuerpo y prueba también
  `schema:full`, con la respuesta exacta de cada intento. Sigue dejando el stream como estaba.
- **El canal nunca se queda sin emisor**: al pasar un canal a Flussonic, primero se escribe y se **verifica** la
  salida allí; sólo entonces TVLister suelta el canal. Si Flussonic la rechaza, el canal sigue emitiendo desde
  TVLister y la fila dice por qué (antes se apagaba el motor local y se cambiaba el motor aunque el guardado
  hubiera fallado).

## Pruebas

`test_catv_flussonic_push` **90 OK** (nuevas: esquema con `push` de texto, esquema estricto que exige el objeto
completo, forma recordada y un solo `PUT` la segunda vez) · `push_ui` 56 · `control` 25 · `ui` 28 · `pacer` 20 ·
regresiones 55/36/29/21.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.43/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.43

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

Y para ver qué contesta tu 23.12 concreto:

```bash
sudo /opt/tvlister24-7/scripts/tvlister-admin.sh catv flussonic probe a0ed
```
