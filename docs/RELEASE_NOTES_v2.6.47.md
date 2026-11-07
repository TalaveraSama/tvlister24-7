# TVLister v2.6.47 — el número del botón es lo que de verdad escribe

Sobre v2.6.46. El botón del rango decía «(N)» usando las filas **visibles** (filtro y búsqueda incluidos), pero la
acción escribe **todos** los canales del rango con stream asignado. Ahora el número es ese.

- `Poner salida UDP a todo el rango (N)` → N = canales del rango **con stream asignado**, sin importar el filtro
  ni la búsqueda de la tabla. Coincide con lo que se escribe.
- Recordatorio: el guardado de un solo canal es **«Guardar en Flussonic»**, en su fila.

## Pruebas

`push_ui` **60 OK** · `push` 96 · `control` 25 · `ui` 28.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.47/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.47

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```
