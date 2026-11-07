# TVLister v2.6.46 — guardar la salida **canal por canal**

Sobre v2.6.45. El botón de la fila se llamaba «Guardar» y no dejaba claro que escribía en Flussonic; y el del
rango podía parecer que hacía lo mismo. Ahora se ve a la primera:

- **«Guardar en Flussonic»** en cada fila: escribe la salida UDP **sólo de ese canal**, relee el stream para
  comprobar que quedó y avisa con «✅ stream: salida UDP puesta (udp://…)» o con el error exacto. No hace falta
  usar el botón del rango.
- El botón del rango pasa a decir **«Poner salida UDP a todo el rango (N)»**: así se sabe que toca **N canales
  de una vez** y no uno.
- El recuadro verde lo explica: cada fila se guarda sola; el rango los hace todos.

## Script suelto para tu PC (`tools/flussonic_push.py`)

También va incluido un script de una sola pieza (Python 3.8+, sin dependencias) para probar y escribir la
salida UDP desde tu PC, editable a tu gusto:

```bash
# qué guarda tu Flussonic y qué forma acepta (no deja cambios)
python tools/flussonic_push.py probe a0ed --server http://192.168.200.10 --user admin --pass TU_CLAVE

# poner o cambiar la salida de un canal
python tools/flussonic_push.py set a0ed --url "udp://ens37@239.1.1.2:1005" --server http://192.168.200.10 --user admin --pass TU_CLAVE

# quitarla
python tools/flussonic_push.py set a0ed --remove --server http://192.168.200.10 --user admin --pass TU_CLAVE
```

Hace lo mismo que el panel: no reenvía `inputs`, copia la forma de las salidas del servidor (interfaz dentro de
la url o en `interface`), prueba las variantes y verifica releyendo.

## Pruebas

`push_ui` **60 OK** (nuevas: botón de fila explícito, botón del rango con el número de canales) · `push` 96 ·
`control` 25 · `ui` 28.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.46/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.46

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```
