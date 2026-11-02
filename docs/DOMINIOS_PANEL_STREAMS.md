# Tus dominios: `tvadmin` (panel) y `live-stream` (video)

Configuración exacta para el caso real:

| Nombre | Papel | DNS (verificado) | Cloudflare |
| --- | --- | --- | --- |
| `tvadmin.alphadigitalnic.xyz` | Panel, API, login, WebTV, DRM | `104.21.66.70`, `172.67.168.15` → **IPs de Cloudflare** | **Naranja (proxied)** — correcto |
| `live-stream.alphadigitalnic.xyz` | Playlist, `.m3u8`, `.ts`, VOD, EPG | `173.208.183.66` → **tu servidor** | **Gris (DNS only)** — correcto |

Ese reparto es el bueno: el panel va por Cloudflare (peticiones pequeñas, caché, protección) y el
video sale directo a tu servidor, porque el proxy de Cloudflare no sirve para HLS continuo y en
planes self-serve puede acabar en suspensión.

**Lo único que falta es que el 443 de tu servidor atienda `live-stream` con un certificado válido y
que el panel sepa que ese es su dominio de video.** Es lo que hacen los pasos 3 y 4.

---

## Paso 1. DNS en Cloudflare (ya está, solo para confirmar)

| Tipo | Nombre | Contenido | Proxy |
| --- | --- | --- | --- |
| `A` | `tvadmin` | IP del servidor | **Proxied** (naranja) |
| `A` | `live-stream` | **la misma IP** | **DNS only** (gris) |

- Si `live-stream` está en naranja, cámbialo a gris: el video se corta solo y Cloudflare puede
  suspender el dominio. Compruébalo con `tvlister-admin dominios`.
- Sin registro `AAAA` en `live-stream` es lo correcto (solo IPv4, apunta al origen).

## Paso 2. Certificado que cubra **los dos** nombres

El mismo 443 va a atender `tvadmin` (cuando conecta Cloudflare) y `live-stream` (cuando conecta el
reproductor), así que el certificado del origen tiene que cubrir ambos. Lo más simple es **un solo
certificado con los dos nombres**:

```bash
sudo certbot certonly --standalone \
  -d tvadmin.alphadigitalnic.xyz \
  -d live-stream.alphadigitalnic.xyz
```

Queda en `/etc/letsencrypt/live/tvadmin.alphadigitalnic.xyz/{fullchain,privkey}.pem` y el panel lo
detecta solo (también vale acme.sh o el Origin Certificate si algún día separas los nombres).

- Con Cloudflare en **SSL/TLS → Full (strict)**, el certificado del origen debe ser de una CA
  pública y cubrir `tvadmin`. Let's Encrypt sirve; un Origin Certificate también, pero **solo**
  valdría para el panel: el video va directo y un reproductor rechazaría una CA privada.
- Renovación: `certbot renew --deploy-hook "systemctl restart tvlister24-7"`. Si el panel sirve el
  443, también vale **Reabrir puertos TLS** en la UI tras renovar.

## Paso 3. Quién atiende el 443 del servidor (elige **una** opción)

Solo un proceso puede escuchar en el 443. Mira quién lo tiene:

```bash
sudo ss -ltnp | grep ':443 '
```

### Opción A — ya tienes el nginx de XUI.one en el 443 (lo más probable)

```bash
sudo tvlister-admin cloudflare tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```

Esto hace, de una vez:

1. Crea **dos** server blocks (`tvlister-panel.conf`, `tvlister-streams.conf`) en
   `/home/xui/bin/nginx/conf/servers/`.
2. Usa el certificado que ya tenga el nginx de XUI o el de Let's Encrypt.
3. Declara los rangos de Cloudflare como proxies de confianza (IP real del cliente).
4. Guarda `public_stream_base = https://live-stream.alphadigitalnic.xyz`.
5. Recarga nginx; si `nginx -t` falla, **desactiva** lo nuevo para no tumbar tu nginx.

### Opción B — que el 443 lo sirva el propio panel (sin nginx)

```bash
sudo tvlister-admin tls /etc/letsencrypt/live/tvadmin.alphadigitalnic.xyz/fullchain.pem \
                       /etc/letsencrypt/live/tvadmin.alphadigitalnic.xyz/privkey.pem
sudo tvlister-admin add-port 443 https     # TLS en el 443
sudo tvlister-admin add-port 80 both       # HTTPS en el 80 + HTTP redirigido a HTTPS
```

El panel sirve las mismas rutas que ya sirve, pero cifradas, con el certificado indicado. No hace
falta nginx. La tarjeta **Certificado HTTPS** de la pestaña de puertos muestra dominio, caducidad,
fuente y qué nombres quedan sin cubrir.

> Si eliges B, el nginx de XUI **no** debe estar escuchando en 443 (o lo paras para el panel, o te
> quedas en A). El panel lo detecta y responde `Puerto 443 ocupado por otro proceso (EADDRINUSE)`.

## Paso 4. Guardar los dos dominios en el panel

```bash
sudo tvlister-admin dominios tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```

o en el panel: *Ingesta → Multi-Puertos HTTPS/HTTP → **Dominios públicos: panel y video*** →
escribe los dos y pulsa **Guardar y abrir 80/443**.

Guarda exactamente:

| Ajuste | Valor |
| --- | --- |
| `panel_domain` | `tvadmin.alphadigitalnic.xyz` |
| `stream_domain` | `live-stream.alphadigitalnic.xyz` |
| `public_stream_base` | `https://live-stream.alphadigitalnic.xyz` (puerto 443 implícito) |

Y si detecta que el panel pasa por Cloudflare, declara sus rangos como proxies de confianza (para
que el panel vea la **IP real** de cada cliente y no la de Cloudflare).

**Por qué importa:** `public_stream_base` es lo que hace que los enlaces de video salgan por
`live-stream` y no por el dominio del panel. Sin él, el reproductor pediría el `.ts` a
`tvadmin…` → Cloudflare → vídeo por el proxy → cortes y riesgo de suspensión.

## Paso 5. Comprobar

```bash
sudo tvlister-admin dominios            # DNS + certificado + Cloudflare + HTTP, de los dos
sudo tvlister-admin streams-check       # reproduce un canal de punta a punta
```

Resultado esperado:

```
  [OK]   tvadmin.alphadigitalnic.xyz  —  PANEL (puede ir por Cloudflare)
          DNS  : 104.21.66.70, 172.67.168.15
          Cert : *.alphadigitalnic.xyz · vence 2027-01-14 (73 días)
          HTTP : 200 · cloudflare · por Cloudflare
  [OK]   live-stream.alphadigitalnic.xyz  —  VIDEO (nube gris)
          DNS  : 173.208.183.66
          Cert : live-stream.alphadigitalnic.xyz · …
          HTTP : 200 · nginx · directo
```

Y los enlaces que reciben los clientes, a mano:

```bash
# La lista debe traer las URLs del dominio de VIDEO
curl -s "https://tvadmin.alphadigitalnic.xyz/get.php?username=USUARIO&password=CLAVE&type=m3u_plus" \
  | grep -m3 '^http'      # → https://live-stream.alphadigitalnic.xyz/live/...

# Un canal, directamente por el dominio de video
curl -skI "https://live-stream.alphadigitalnic.xyz/live/USUARIO/CLAVE/1.m3u8" | head -5

# Certificado que ve un reproductor (debe cubrir live-stream y no ser autofirmado)
echo | openssl s_client -connect live-stream.alphadigitalnic.xyz:443 \
  -servername live-stream.alphadigitalnic.xyz 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

## Lo que el panel ya hace con esos ajustes

- `get.php` / `player_api.php` → `server_info.url` y todos los enlaces apuntan a
  `https://live-stream.alphadigitalnic.xyz`.
- `xmltv.php` (EPG), login, WebTV y API siguen en `tvadmin…`.
- Las claves DRM (`/drm/…`) salen por el dominio del panel, no por el de video.
- Con Cloudflare delante, el panel lee `CF-Connecting-IP` solo si el rango está declarado como
  proxy de confianza (lo hace el paso 4). **Sin eso, todos los clientes parecen la misma IP** y los
  límites por IP (intentos de contraseña, anti-compartición) se aplicarían a todos a la vez.

## Si algo falla

| Síntoma | Causa | Arreglo |
| --- | --- | --- |
| `[FALLA] live-stream… Sin HTTPS válido` | No hay cert para ese nombre en el 443 | Paso 2 con el SAN e.e. `-d live-stream…`, o el server block del paso 3-A |
| `El certificado del 443 no cubre live-stream` | Cert emitido solo para `tvadmin` | Reemitir con los dos `-d` |
| `El origen responde 404` | Ese nombre no tiene server block | Opción A, o `add-port 443 https` en opción B |
| `El dominio de video está detrás del proxy` | Nube naranja en `live-stream` | Cloudflare → DNS → gris |
| Vídeo con cortes, panel perfecto | El video está saliendo por `tvadmin` | Revisa `public_stream_base` (paso 4) |
| `Puerto 443 ocupado` | nginx y panel quieren el mismo puerto | Quédate con A **o** con B, no las dos |
| Clientes aparecen con IP de Cloudflare | Falta el drop-in de proxies de confianza | `sudo tvlister-admin dominios <panel> <video>` (lo crea solo) |
| Cloudflare 521/522 en el panel | El origen no responde en el 443/80 que usa CF | Paso 3 y firewall (`ufw allow 443`) |
