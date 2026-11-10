# Let's Encrypt cuando el panel ocupa el puerto 80

`certbot certonly --standalone` necesita **escuchar en el 80**. Si el panel (o nginx) ya lo tiene,
certbot falla:

```
Could not bind TCP port 80 because it is already in use by another process on this system
```

La solución no es apagar el panel cada 60 días: es validar por **HTTP-01 con webroot**. Certbot deja
un token en un directorio y lo publica quien tenga el 80. El panel ya lo hace.

```bash
sudo tvlister-admin acme live-stream.alphadigitalnic.xyz tu@correo.com
```

Ese comando:

1. Crea `/var/www/tvlister-acme/.well-known/acme-challenge/`.
2. Ejecuta `certbot certonly --webroot -w /var/www/tvlister-acme -d <dominio>` (con `--keep-until-expiring`,
   así renovar no vuelve a pedir nada).
3. Instala el certificado en el panel como certificado **de ese dominio** (SNI), para que el 443 lo
   sirva sin depender de nginx.
4. Deja un `--deploy-hook` que reinicia el panel al renovar, para que cargue el PEM nuevo.

## Cómo se sirve el reto

| Quién tiene el 80 | Cómo se publica `/.well-known/acme-challenge/<token>` |
| --- | --- |
| El panel (`add-port 80 both`) | Lo sirve él mismo, **sin redirigir a HTTPS** (si redirigiera, la validación fallaría) |
| nginx de XUI.one | Los server blocks que genera `tvlister-admin cloudflare` ya incluyen la `location` del reto |
| nginx del sistema | Igual, si usaste `cloudflare`; si no, añade la `location` a mano |

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/www/tvlister-acme;
    default_type text/plain;
    add_header Cache-Control "no-store" always;
}
```

## Comprobar antes de pedir el certificado

```bash
# ¿quién tiene el 80?
sudo ss -ltnp | grep ':80 '

# ¿responde el panel a un reto inventado? (404 es correcto: la ruta existe)
curl -s -o /dev/null -w '%{http_code}\n' http://live-stream.alphadigitalnic.xyz/.well-known/acme-challenge/prueba
```

## Renovación

Certbot instala un timer (`systemctl list-timers | grep certbot`) o un cron. Con el `--deploy-hook`
del comando, al renovar se reinicia el panel y coge el certificado nuevo. Si prefieres hacerlo a
mano:

```bash
sudo certbot renew
sudo tvlister-admin tls list      # aquí se ve la fecha nueva
```

## Si certbot sigue fallando

| Síntoma | Causa | Arreglo |
| --- | --- | --- |
| `Timeout during connect (likely firewall problem)` | El 80 no llega desde Internet | Abrir el 80 en UFW/router/NAT |
| `Invalid response ... 404` | Quien tiene el 80 no publica el reto | `tvlister-admin cloudflare <panel> <video>` o la `location` de arriba |
| `DNS problem: NXDOMAIN` | El nombre no resuelve | Crear el registro A antes |
| `too many failed authorizations` | Muchos intentos seguidos | Esperar 1 hora (límite de Let's Encrypt) |
| `Could not bind TCP port 443` | Algo ocupa el 443 y el reto fue por TLS-ALPN | Usar `--webroot` (puerto 80), que es lo que hace el comando |

## Alternativa sin abrir el 80: validación DNS

Si el 80 no puede abrirse, se valida por DNS con el plugin de Cloudflare:

```bash
sudo apt install -y python3-certbot-dns-cloudflare
# /root/.secrets/cloudflare.ini →  dns_cloudflare_api_token = <token con permiso Zone:DNS:Edit>
sudo chmod 600 /root/.secrets/cloudflare.ini
sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d live-stream.alphadigitalnic.xyz
```

Después, `sudo tvlister-admin tls add live-stream.alphadigitalnic.xyz
/etc/letsencrypt/live/live-stream.alphadigitalnic.xyz/fullchain.pem
/etc/letsencrypt/live/live-stream.alphadigitalnic.xyz/privkey.pem`.
