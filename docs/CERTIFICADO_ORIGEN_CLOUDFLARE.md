# Certificado de origen de Cloudflare, pegado desde consola

El **Origin Certificate** de Cloudflare es un certificado de 15 años emitido por su CA privada.
Sirve para el panel (que va detrás de Cloudflare, nube naranja) y **no sirve** para el dominio de
video, porque el video se conecta **directo** y el reproductor no conoce esa CA.

Desde v2.6.8 el servidor puede tener **un certificado por dominio** (SNI) en el mismo 443:

| Dominio | Quién valida el certificado | Certificado recomendado |
| --- | --- | --- |
| `tvadmin.alphadigitalnic.xyz` | Cloudflare (naranja) → origen | **Origin Certificate** (Cloudflare) |
| `live-stream.alphadigitalnic.xyz` | el reproductor, conexión directa | **Let's Encrypt** (CA pública) |

---

## 1. Crear el Origin Certificate

Cloudflare → tu dominio → **SSL/TLS → Origin Server → Create Certificate**:

- *Private key type*: RSA (2048).
- *Hostnames*: `tvadmin.alphadigitalnic.xyz` y `*.alphadigitalnic.xyz` (así también cubre el
  subdominio de video si algún día lo quieres).
- *Certificate Validity*: 15 years.
- Pulsa **Create** y copia los dos bloques: **Origin Certificate** y **Private Key**.
  (El `.pem` y el `.key` que ofrece para descargar son lo mismo.)

## 2. Instalarlo desde la consola

### Opción A — pegar (lo más cómodo)

```bash
sudo tvlister-admin tls origin
```

El comando pide el **certificado** y luego la **clave**; se leen solos por sus marcas
(`-----BEGIN CERTIFICATE-----` … `-----BEGIN PRIVATE KEY-----`), así que puedes pegarlos con
Ctrl+Mayús+V en orden. Al terminar, **Ctrl-D**.

```
----------------------------------------------------------------
 Certificado para: tvadmin.alphadigitalnic.xyz
----------------------------------------------------------------
 Pega el CERTIFICADO (incluye -----BEGIN CERTIFICATE-----) y después
 la CLAVE PRIVADA (-----BEGIN PRIVATE KEY-----). Se leen solos por sus
 marcas; al terminar, pulsa Ctrl-D.

-----BEGIN CERTIFICATE-----
MIIE...
-----END CERTIFICATE-----
-----BEGIN PRIVATE KEY-----
MIIE...
-----END PRIVATE KEY-----
^D
```

### Opción B — desde los ficheros descargados

```bash
sudo tvlister-admin tls origin /root/origin.pem /root/origin-key.pem
```

### Opción C — por tubería

```bash
cat origin.pem origin-key.pem | sudo tvlister-admin tls origin
```

Resultado:

```
✅ Certificado instalado para tvadmin.alphadigitalnic.xyz
   Emisor      : CN=Cloudflare Origin SSL Certificate
   Válido hasta: 2041-10-29 (5474 días)
   Nombres     : tvadmin.alphadigitalnic.xyz, *.alphadigitalnic.xyz
   Ficheros    : /etc/tvlister/tls/certs/tvadmin.alphadigitalnic.xyz/fullchain.pem
                 /etc/tvlister/tls/certs/tvadmin.alphadigitalnic.xyz/privkey.pem (sólo root)

   ℹ️  Origin Certificate de Cloudflare: sólo es válido cuando quien
       valida es Cloudflare (panel con nube naranja). Un dominio que se
       conecta DIRECTO, como el de video, necesita CA pública
       (Let's Encrypt) o el reproductor rechazará la conexión.
```

La clave privada queda en `600` (solo root) y **nunca** se devuelve por la API ni se muestra en el
panel: la UI solo enseña dominio, emisor, vencimiento y de dónde salió.

> **Si el certificado es comodín** (`*.alphadigitalnic.xyz`, lo más habitual en Cloudflare), se
> guarda como comodín y cubre el panel y cualquier subdominio: en `tls list` aparece como
> `*.alphadigitalnic.xyz`. No hay que instalar uno por nombre.

> **Si el 80 lo ocupa el panel**, certbot `--standalone` falla con «Could not bind TCP port 80».
> Usa `tvlister-admin acme <dominio> <correo>` (validación webroot): ver
> [`LETSENCRYPT_WEBROOT.md`](LETSENCRYPT_WEBROOT.md).

## 3. El video, con Let's Encrypt (obligatorio)

```bash
# Una sola orden: emite con webroot (el 80 lo tiene el panel) e instala el
# certificado en el panel como certificado de ese dominio.
sudo tvlister-admin acme live-stream.alphadigitalnic.xyz tu@correo.com
```

Equivalente a mano, si ya tenías el certificado emitido:

```bash
sudo certbot certonly --webroot -w /var/www/tvlister-acme -d live-stream.alphadigitalnic.xyz
sudo tvlister-admin tls add live-stream.alphadigitalnic.xyz \
  /etc/letsencrypt/live/live-stream.alphadigitalnic.xyz/fullchain.pem \
  /etc/letsencrypt/live/live-stream.alphadigitalnic.xyz/privkey.pem
```

Si no quieres indicar rutas, `sudo tvlister-admin tls add live-stream.alphadigitalnic.xyz` y pega
el PEM que te dé tu CA (también vale el de acme.sh).

A partir de ahí, en el **mismo 443**:

| Petición con SNI | Certificado que se entrega |
| --- | --- |
| `tvadmin.alphadigitalnic.xyz` | Origin Certificate de Cloudflare |
| `live-stream.alphadigitalnic.xyz` | Let's Encrypt |
| cualquier otro nombre | el certificado por defecto |

Comprobado con `openssl s_client`:

```
$ echo | openssl s_client -connect 127.0.0.1:8443 -servername tvadmin.alphadigitalnic.xyz | openssl x509 -noout -subject
subject=CN = Cloudflare Origin SSL Certificate, O = "Cloudflare, Inc.", CN = tvadmin.alphadigitalnic.xyz

$ echo | openssl s_client -connect 127.0.0.1:8443 -servername live-stream.alphadigitalnic.xyz | openssl x509 -noout -subject
subject=CN = live-stream.alphadigitalnic.xyz
```

## 4. Abrir los puertos y activar Cloudflare

```bash
sudo tvlister-admin add-port 443 https
sudo tvlister-admin add-port 80 both
sudo tvlister-admin dominios tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```

En Cloudflare: **SSL/TLS → Overview → Full (strict)**. Con «Flexible» Cloudflare hablaría con el
origen por HTTP y se perdería el cifrado; con «Full» (sin strict) aceptaría cualquier certificado.

## 5. Comprobar

```bash
sudo tvlister-admin tls list      # qué certificado tiene cada dominio
sudo tvlister-admin dominios      # DNS + certificado + Cloudflare, de los dos nombres
```

`tls list` muestra los instalados a mano y los que detecta solos (Let's Encrypt/acme.sh):

```
============================================================
  Certificados del servidor
============================================================
  Por defecto : tvadmin.alphadigitalnic.xyz
                Cloudflare Origin
                vence 2041-10-29 (5474 días)

  tvadmin.alphadigitalnic.xyz
     Emisor : Cloudflare Origin
     Vence  : 2041-10-29 (5474 días)
     ℹ️  Origin de Cloudflare: sólo vale con Cloudflare delante.

  live-stream.alphadigitalnic.xyz
     Emisor : Let's Encrypt
     Vence  : 2027-02-08 (97 días)
```

## 6. Renovar y quitar

```bash
# Renovar el del video (Let's Encrypt)
sudo certbot renew --deploy-hook "systemctl restart tvlister24-7"

# Reemplazar el Origin (por ejemplo, si añades otro subdominio)
sudo tvlister-admin tls origin          # se sobrescribe el de ese dominio

# Quitar el de un dominio
sudo tvlister-admin tls remove tvadmin.alphadigitalnic.xyz
```

Renovar el Origin Certificate **no es urgente**: dura 15 años. Si un día Cloudflare cambia la
configuración, basta con repetir `tls origin`.

## 7. Errores típicos

| Mensaje | Causa | Arreglo |
| --- | --- | --- |
| `El certificado no cubre <dominio>` | El Origin se creó sin ese nombre | Crear el cert con ese hostname o `*.dominio` |
| `…no forman un par válido` | Pegaste la clave de otro certificado | Volver a pegar los dos bloques correctos |
| `No se pudo guardar… ¿Ejecutaste con sudo?` | Falta permiso sobre `/etc/tvlister/tls` | `sudo tvlister-admin tls origin` |
| Cloudflare **526** (Invalid SSL) | El origen no presenta el cert esperado | Revisar `tls list`, SNI y que el 443 sea el del panel/nginx |
| Cloudflare **521/522** | El origen no responde en 443/80 | Puertos abiertos y firewall (`ufw allow 443`) |
| El video falla con «certificate verify failed» | El video está usando el Origin (CA privada) | Let's Encrypt para `live-stream`, como en el paso 3 |
| El panel carga con aviso de certificado desde el origen | Estás entrando a la IP/origen sin pasar por Cloudflare | Normal: el Origin sólo es de confianza para Cloudflare |
