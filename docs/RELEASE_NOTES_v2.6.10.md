# TVLister 24/7 — v2.6.10 «El comprobador de dominios, arreglado y con origen»

La v2.6.9 funcionaba, pero `tvlister-admin dominios` (y la tarjeta del panel) daban un falso negativo
en todos los dominios:

```
Cert : Cannot convert object to primitive value
✖ Sin HTTPS válido en 443: Cannot convert object to primitive value.
```

## 1. El fallo

`getPeerCertificate()` de Node devuelve objetos **con prototipo nulo**. Convertirlos a cadena
(`String(cert.subject)`) lanza exactamente ese error, y yo lo hacía al leer el asunto del
certificado. Resultado: dos dominios que estaban sirviendo HTTPS correctamente aparecían como rotos.

Ahora los campos se leen por propiedad (y se entiende que `CN` puede venir como **array** cuando el
certificado lleva dos, como el de Cloudflare) y el `CN` visible es el que parece un dominio, no
`CloudFlare Origin Certificate`.

## 2. Ahora también comprueba el ORIGEN

Antes sólo se miraba el certificado «de cara al cliente»: con el panel detrás de Cloudflare, eso es
el certificado del borde de Cloudflare, que puede estar perfecto mientras **el origen está caído** —
y eso es justo un **521**. Ahora, por cada dominio, se pregunta a `127.0.0.1:443` con el SNI de ese
nombre:

| Situación | Lo que dice el comando |
| --- | --- |
| Origen sin certificado para ese nombre | `El 443 de este servidor presenta un certificado que NO cubre <dominio>` |
| Origen caído (panel) | `Cloudflare dará 521 mientras el 443 de este servidor no responde…` |
| Origen caído (video) | `El video se conecta directo: el 443 de este servidor no responde…` |
| Video con certificado de CA privada | `El 443 del origen usa un certificado que el reproductor no conoce (Cloudflare, Inc.)` |

La tarjeta del panel muestra una línea `origen :443 → <CN> · <días>d` por dominio.

## 3. Otros arreglos de la misma pasada

- El recordatorio final sugería `certbot --standalone`, que **falla** con el 80 ocupado por el panel.
  Ahora propone lo que funciona: `tls origin` para el panel y `acme <video> <correo>` para el video.
- `Dominios configurados` repetía el dominio de video (venía de `panel_domain`, `stream_domain` y la
  base pública). Ahora va sin duplicados.
- `tls list` mostraba como nombre del certificado `CloudFlare Origin Certificate`; ahora muestra el
  dominio que cubre.
- `tvlister-admin acme` reinicia el panel tras instalar el certificado y distingue «emitido» de
  «ya estaba vigente» (certbot responde *not yet due for renewal*).

## Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| `inspectCertificate` contra un 443 real | `ok: true`, sujeto `tvadmin.alphadigitalnic.xyz`, cubre el nombre, 5474 días |
| Certificado comodín de Cloudflare | cubre `tvadmin…` y cualquier subdominio; se reconoce el emisor |
| Certificado de Let's Encrypt | cubre `live-stream…`, 89 días |
| `checkDomains` | ya no lanza el error de conversión; informa problemas reales |
| Build del panel | `vite build` correcto |

## Instalación

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.10/install.sh | bash
tvlister-admin update
sudo tvlister-admin dominios tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```
