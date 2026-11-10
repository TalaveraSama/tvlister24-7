# TVLister 24/7 — v2.6.25

**El panel vuelve a los puertos estándar: se entra por `http://TU_IP` (80) y por `https://TU_IP`
(443), sin escribir ningún puerto.** Antes la instalación caía en `8095` y el 80/443 había que
abrirlos a mano desde el panel. Ahora el instalador usa el **80** como puerto principal, el **443**
se abre solo en cuanto hay certificado, y el comando `tvlister-admin tls` carga el certificado y
comprueba que el 443 responde de verdad.

## Qué cambia para quien instala

| Antes | Ahora (v2.6.25) |
| --- | --- |
| Puerto por defecto `8095` | Puerto por defecto **`80`** |
| `http://TU_IP:8095` | **`http://TU_IP`** |
| El 443 se abría a mano desde *Multi-Puertos* | El **443** se abre solo con el certificado |
| Sin certificado, el 443 quedaba muerto sin explicación | El log dice qué falta y cómo cargarlo |

- **`PORT` sigue mandando.** Una instalación que ya existía **conserva su puerto** (8095, 8895…):
  sólo las instalaciones nuevas toman el 80.
- **Con XUI.one instalado** el panel se queda en el puerto interno (`8095`) para no pisar el nginx de
  XUI, que es quien da el 80/443 en ese servidor. Si el 80 lo ocupa cualquier otro proceso, el
  instalador toma el siguiente libre y avisa del puerto elegido.
- El **443** y el **80** se abren en **UFW e iptables** para que el panel funcione por los dos.
- Los textos del instalador, `tvlister-admin status/set-port` y la documentación ya no muestran
  `:8095` en las URLs estándar.

## El 443 con certificado real (nunca autofirmado)

El panel **no inventa certificados**: un autofirmado en producción sólo provoca avisos y
reproductores que se niegan a conectar. Lo que sí hace ahora:

- **Busca el certificado que ya existe** en el servidor: rutas guardadas, `TVLISTER_TLS_CERT/KEY`,
  `/etc/letsencrypt/live/*/`, `~/.acme.sh/*/` y `/etc/tvlister/tls/` (el más reciente primero). En un
  servidor que ya tenía Let's Encrypt, el 443 se abre en el primer arranque sin configurar nada. En
  un servidor con XUI.one no se toca: el 443 es de su nginx (se puede forzar con
  `TVLISTER_STANDARD_PORTS=1`).
- **`tvlister-admin tls <cert> <clave>`** valida que el certificado y la clave sean un par real, los
  guarda, deja preparados el 80 y el 443, abre el firewall, reinicia y **comprueba** que
  `https://127.0.0.1/api/health` responde.
- **Sin certificado el 80 sigue sirviendo el panel** en claro: nadie se queda fuera mientras se
  emite el certificado. Con certificado, el 80 como puerto extra redirige al 443 conservando host y
  ruta (los retos ACME se contestan siempre en claro, que si no la validación falla).

## Multi-Puertos: los estándar vienen puestos

- Al arrancar se registran **una vez** el `443:https` y el `80:both` (si no son ya el principal). Si
  después los quitas desde el panel, no vuelven a aparecer solos.
- Si cambias de puerto principal (`tvlister-admin set-port`), los estándar que dejaste atrás se
  completan otra vez.
- El puerto `80`/`443` en modo `both` **ya no falla sin certificado**: se queda en HTTP plano y dice
  en el log qué falta. El `443` a secas sigue negándose sin certificado, que es lo correcto.

## Docker y documentación

- `Dockerfile` y `docker-compose.yml` publican **80 y 443**, con `./certs` montado en
  `/app/certs` (`fullchain.pem` + `privkey.pem`).
- `README.md` y `docs/DOCUMENTACION_SISTEMA.md` describen los puertos estándar y el comando `tls`.

## Cómo instalar o actualizar

```bash
# última versión
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash

# versión exacta
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.25/install.sh \
  | sudo bash -s -- --tag v2.6.25
```

El instalador es **idempotente**: conserva base de datos, `.runtime`, canales, líneas y el puerto de
una instalación existente. Para actualizar desde el propio servidor: `tvlister-admin update`.

## Comprobado ejecutando los scripts reales

- Instalador completo en limpio → **puerto 80**, `/api/health` OK, resumen con `http://IP`.
- Instalador con el 80 ocupado → **8095** automático, avisando del puerto.
- Instalador sobre una instalación con `Environment=PORT=8095` → **se queda en 8095** (sin tocar la
  base de datos).
- Instalador en un servidor con XUI.one → **8095**, sin tocar su nginx.
- Certificado instalado en caliente (`setTlsPaths` + `rebindAllPorts`): el 80 pasa de HTTP a `301`
  hacia HTTPS y el 443 empieza a responder sin reiniciar el panel.
- `tvlister-admin tls <cert> <clave>` → certificado validado, 443 abierto (`200` por TLS) y el 80
  del puerto principal sirviendo el panel.
- Sin certificado: 80 responde `200` en claro, 443 cerrado y mensaje claro en el log.
- Con certificado: 443 `200`, y el 80 como puerto extra `301` a HTTPS conservando host y ruta.
