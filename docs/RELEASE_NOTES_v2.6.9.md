# TVLister 24/7 — v2.6.9 «Certificado del video sin parar el panel y canal 1 arreglado»

Dos fallos reales encontrados usando la v2.6.8 en producción.

## 1. `Could not bind TCP port 80` al emitir el certificado del video

`certbot --standalone` necesita escuchar en el 80, y en v2.6.6 el panel puede quedarse con ese
puerto (`add-port 80 both`): certbot fallaba en bucle y el dominio de video se quedaba sin
certificado.

Ahora el panel publica los retos HTTP-01 de Let's Encrypt y hay una orden que hace todo:

```bash
sudo tvlister-admin acme live-stream.alphadigitalnic.xyz tu@correo.com
```

- Crea `/var/www/tvlister-acme/.well-known/acme-challenge/`.
- Emite con `certbot certonly --webroot` (sin pelear por el 80).
- Instala el certificado en el panel con SNI para ese dominio.
- Deja `--deploy-hook` que reinicia el panel al renovar.

El reto se sirve **en claro y sin redirigir** (en el panel y en el listener del 80); si se
redirigiera a HTTPS, la validación fallaría. Los server blocks de `cloudflare` también incluyen la
`location` del reto, para cuando el 80 lo tiene nginx.

## 2. `table wk2500_channels_new has no column named pkt_size`

La migración que habilita el **canal 1** (portadora de 44–50 MHz) escribía a mano la lista de
columnas de la tabla nueva. En bases que ya tenían `pkt_size`, `rtp` o `freq_locked` —es decir,
cualquiera actualizada desde v2.5.x— el `INSERT` fallaba, el error se capturaba y **el canal 1 se
quedaba deshabilitado para siempre**, sin más aviso que una línea en el log.

Ahora la tabla se reconstruye **a partir de su propio DDL**, cambiando solo la restricción del canal:
se conservan todas las columnas presentes y los datos. Verificado con una base «vieja» con
`CHECK (catv_ch >= 2)`, `pkt_size/rtp/freq_locked` y filas dentro:

| Prueba | Resultado |
| --- | --- |
| Migración | `[db] Migración: canal 1 habilitado…`, CHECK nuevo, 23 columnas conservadas |
| Datos | CH2 y CH3 intactos, con su `pkt_size` |
| Canal 1 | se inserta correctamente después |

## 3. Certificados comodín

Un Origin Certificate `*.dominio` se guarda como comodín y cubre el panel y cualquier subdominio;
`tls list` lo muestra así y el SNI lo aplica a todos los nombres que no tengan uno propio.

## Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| Reto ACME en el panel | `200` con el token, `404` si no existe, traversal rechazado |
| Reto por el 80 (redirección) | sirve el token en claro; el resto sigue dando `301` a HTTPS |
| SNI con comodín + Let's Encrypt | `tvadmin…` → Origin de Cloudflare · `live-stream…` → Let's Encrypt |
| Migración wk2500 | canal 1 habilitado, columnas y filas conservadas |

## Documentación

- `docs/LETSENCRYPT_WEBROOT.md`: validación webroot, quién sirve el reto, comprobaciones y
  alternativa DNS-01 con Cloudflare.
- `docs/CERTIFICADO_ORIGEN_CLOUDFLARE.md`: añadido el caso comodín y el comando `acme`.

## Instalación

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.9/install.sh | bash
tvlister-admin update
sudo tvlister-admin acme live-stream.alphadigitalnic.xyz tu@correo.com
```
