# TVLister v2.6.44 — el diagnóstico ya no puede dar un falso «funciona»

Sobre v2.6.43. Al probar `probe a0ed` contra un servidor que **rechazaba** el `PUT` con `400
parsing_parameters`, el diagnóstico decía *«✅ Forma que funciona: outputs»*: el stream **ya tenía** esa salida y
el probe sólo comprobaba que siguiera estando. Un `400` no la quita, así que el resultado era un falso positivo
y escondía justo lo que hay que ver.

## Qué cambia

- Una forma sólo cuenta si el servidor **la aceptó** (`2xx`) **y** la salida quedó puesta al releer el stream.
- Cada intento indica `accepted`, y la consola pinta ✅ sólo con las dos condiciones.
- Si la URL de prueba ya estaba entre las salidas del stream, el probe lo avisa:
  *«⚠️ (el stream ya tenía esa salida: que «siga» no prueba que el PUT se acepte)»*.
- El mismo criterio se aplica a la prueba sin interfaz (`outputs_sin_iface`).
- Nueva prueba de regresión: un stream que ya tiene la salida pedida y rechaza todo `PUT` ⇒ **sin ganador**.

## Pruebas

`test_catv_flussonic_push` **92 OK** · `push_ui` 56 · `control` 25 · `ui` 28 · `pacer` 20.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.44/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.44

sudo /opt/tvlister24-7/scripts/tvlister-admin.sh update
```

Después, contra tu servidor:

```bash
sudo /opt/tvlister24-7/scripts/tvlister-admin.sh catv flussonic probe a0ed
```
