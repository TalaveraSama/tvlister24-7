# TVLister v2.6.45 — la salida se escribe **como la guarda tu servidor**

Sobre v2.6.44. Dos ideas de la revisión externa son correctas y dos no; lo que sí faltaba era dejar que el
propio servidor dictara la **forma exacta** de cada salida, y poder verla.

## Qué cambia

- **Se copia el estilo del servidor.** Antes de escribir, el panel mira una salida que el stream ya tenga:
  - si la guarda con la interfaz **dentro de la url** (`udp://ens37@239.1.1.2:1002`), escribe igual;
  - si la guarda en un **campo aparte** (`{"url":"udp://239.1.1.2:1002","interface":"ens37"}`), escribe así,
    con la url limpia;
  - y **copia los campos extra** que añada ese servidor (`type`, `ttl`, `bitrate`…). No se inventan valores: se
    imitan los suyos.
- **Forma `iface_field`** en la rotación de respaldo (url sin `@` + `"interface"`), por si una instalación la
  acepta aunque su `GET` no la enseñe.
- **`probe` enseña el JSON real**: las salidas y entradas tal cual las publica el servidor (`JSON: [...]`) y una
  línea **`Formato`** que dice si la interfaz va dentro de la url o en un campo aparte. Con eso se acaba el
  adivinar.

## Sobre la revisión: qué es cierto y qué no

| Afirmación | Veredicto |
| --- | --- |
| El endpoint es `PUT /streamer/api/v3/streams/{name}` | ✅ Correcto, es el que usa el panel. |
| Cuerpo mínimo `{"outputs":[…]}` | ✅ Correcto, es la primera forma que se prueba. |
| «El 405 significa endpoint equivocado» | ❌ El 405 lo produce el **último recurso `PATCH`** del panel (Flussonic sólo admite `GET`/`PUT`/`DELETE` ahí). Confirma el endpoint, no lo desmiente. |
| «Nunca pongas `udp://ens37@…` en la url: es sintaxis de entrada» | ❌ Es sintaxis **de salida** documentada desde Flussonic 20.05 (`push udp://eth0@239.0.0.1:1234`), y es la que ya tienes en tu `flussonic.conf`. |
| «`type`/`interface`/`ttl`/`bitrate` son obligatorios» | ⚠️ No están garantizados como obligatorios; Flussonic ignora los campos que no conoce y **falla si un campo conocido llega mal**. Por eso ahora se copian sólo si tu servidor los usa. |

## Pruebas

`test_catv_flussonic_push` **96 OK** (nuevas: servidor que guarda la interfaz en campo aparte y rechaza `@` en
la url, conservación de `type`, y el `probe` enseñando el JSON) · `control` 25 · `push_ui` 56 · `ui` 28.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.45/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.45

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

Y el diagnóstico, que ahora imprime el JSON del servidor:

```bash
sudo /opt/tvlister24-7/scripts/tvlister-admin.sh catv flussonic probe a0ed
```
