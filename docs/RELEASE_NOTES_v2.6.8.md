# TVLister 24/7 — v2.6.8 «Certificado de origen de Cloudflare desde la consola»

Para el panel detrás de Cloudflare lo normal es usar su **Origin Certificate** (15 años, CA
privada). Hasta ahora había que colocarlo a mano en nginx; ahora se **pega en la consola** y el panel
lo usa él mismo. Y como el dominio de video se conecta directo, el servidor sirve **un certificado
distinto por dominio** en el mismo 443.

## 1. Pegar el certificado (sin ficheros, sin editores)

```bash
sudo tvlister-admin tls origin
```

Pide el certificado y la clave, los lee por sus marcas (`BEGIN CERTIFICATE` / `BEGIN … PRIVATE
KEY`) y los instala para el dominio del panel. También admite ficheros o tubería:

```bash
sudo tvlister-admin tls origin /root/origin.pem /root/origin-key.pem
cat origin.pem origin-key.pem | sudo tvlister-admin tls origin
```

Antes de guardar valida que **sean pareja** (`tls.createSecureContext`) y que el certificado
**cubra** el nombre; si no, no escribe nada y dice por qué. La clave queda en `600` y no se devuelve
nunca por la API.

## 2. Un certificado por dominio (SNI)

| Dominio | Quién valida | Certificado |
| --- | --- | --- |
| `tvadmin.alphadigitalnic.xyz` (naranja) | Cloudflare → origen | **Origin Certificate** |
| `live-stream.alphadigitalnic.xyz` (gris) | el reproductor, directo | **Let's Encrypt** |

Con `SNICallback`, el 443 entrega el que corresponde a cada nombre y el resto recibe el de por
defecto. Sin SNI (clientes antiguos) sigue funcionando con el de por defecto.

```bash
sudo tvlister-admin tls add live-stream.alphadigitalnic.xyz     # pega el PEM de Let's Encrypt
sudo tvlister-admin tls list                                   # quién tiene qué
sudo tvlister-admin tls remove tvadmin.alphadigitalnic.xyz
```

> El Origin Certificate **no sirve** para el video: lo emite una CA privada de Cloudflare y el
> reproductor, que conecta directo, no la conoce. El comando lo avisa al instalarlo.

## 3. Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| Pegar Origin por tubería | instalado en `/etc/tvlister/tls/certs/<dominio>/`, clave `600`, CN/SAN y 5474 días detectados |
| Certificado que no cubre el dominio | rechazado: «El certificado no cubre <dominio> (nombres: …)» |
| Cert y clave de parejas distintas | rechazado: «key values mismatch» |
| SNI en el mismo puerto | `-servername tvadmin…` → Origin de Cloudflare; `-servername live-stream…` → Let's Encrypt; sin SNI → por defecto |
| Renovar (reinstalar) | sobrescribe el del dominio, sella los ficheros y sigue sirviendo |
| Quitar | borra ficheros y deja de apuntar a ellos si era el de por defecto |
| API | `GET /api/ports/certs` lista sin la clave; `POST` y `DELETE` reabren los puertos |
| UI | tarjeta con los certificados por dominio, marca `ORIGIN CF` y aviso si está autofirmado |

## 4. Documentación

`docs/CERTIFICADO_ORIGEN_CLOUDFLARE.md`: crear el certificado en Cloudflare, las tres formas de
instalarlo, Let's Encrypt para el video, Cloudflare en *Full (strict)*, comprobaciones con
`openssl s_client` y tabla de errores (526, 521/522, "certificate verify failed").

## Instalación

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.8/install.sh | bash
tvlister-admin update
sudo tvlister-admin tls origin
```
