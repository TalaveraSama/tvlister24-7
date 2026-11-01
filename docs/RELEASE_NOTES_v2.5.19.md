# TVLister 24/7 — v2.5.19 «Cloudflare delante del panel, el video por fuera»

Proxy inverso listo para poner el panel detrás de Cloudflare **sin que el video pase por su CDN**.

```bash
tvlister-admin cloudflare tv.midominio.com stream.midominio.com
```

---

## Antes de nada: por qué el video no va por Cloudflare

Cloudflare **no permite el tráfico de video continuo** en los planes self-serve (su propio contrato,
§2.8: "serving video … unless purchased separately as a Paid Service"). No es un límite técnico que
se pueda sortear con cabeceras: cuando detectan un dominio sirviendo video, avisan y pueden suspender
el dominio. Y aunque no lo detectaran, su proxy está pensado para peticiones cortas, no para 145
canales de TS: mete buffering, corta conexiones largas y añade saltos.

Así que **no voy a montarte un camuflaje**. Lo que sí he hecho es la arquitectura que funciona y que
además es la que ellos aceptan:

```
   Espectador
      │
      ├── https://tv.midominio.com      ──►  Cloudflare (naranja)  ──►  nginx  ──►  panel :8095
      │        panel, API, WebTV, login, MNF/WebSocket, VOD pequeño
      │
      └── https://stream.midominio.com  ──►  SIN Cloudflare (gris) ──►  nginx  ──►  panel :8095
               playlist .m3u8, segmentos .ts, catchup
```

El panel se beneficia de Cloudflare (SSL, anti-DDoS, caché de la interfaz). El video sale directo
desde tu servidor: sin buffering, sin cortes, sin riesgo de suspensión.

---

## 1. Qué genera el comando

| Archivo | Qué hace |
| --- | --- |
| `/etc/nginx/sites-available/tvlister247-panel.conf` | El dominio del panel, proxied a `127.0.0.1:8095` con WebSocket, `proxy_buffering off`, timeouts de 1 h y `client_max_body_size 250M`. |
| `/etc/nginx/sites-available/tvlister247-streams.conf` | El subdominio de streams: sin buffer ni gzip, `sendfile`/`tcp_nopush`, `.m3u8` con `no-store` y segmentos con 30 s de caché. |
| `/etc/nginx/conf.d/tvlister-cloudflare-realip.conf` | Los rangos de Cloudflare como proxies de confianza + `real_ip_header CF-Connecting-IP`. Sin esto, **todos** los clientes aparecen con IP de Cloudflare y el bloqueo por IP de las líneas deja de servir. |
| `/etc/systemd/system/tvlister24-7.service.d/cloudflare.conf` | `TVLISTER_TRUSTED_PROXIES` con los rangos de Cloudflare (se descargan al ejecutar; si no hay red, se usa la lista incluida). |

Además guarda la clave `public_stream_base` para que **todos los enlaces de video** que reparte el
panel (playlist `get.php`, catchup, `hls_proxy`, Enigma2) apunten al subdominio sin Cloudflare.

```bash
tvlister-admin cloudflare --clear   # vuelve a usar el dominio del panel para todo
```

## 2. Lo que hay que hacer en el panel de Cloudflare

1. **DNS**
   - `tv.midominio.com` → A a la IP del servidor → **naranja (proxied)**
   - `stream.midominio.com` → A a la IP del servidor → **gris (DNS only)**
2. **SSL/TLS → Full (strict)** y un certificado real en el servidor (los dos dominios):
   ```bash
   tvlister-admin setup-ssl tv.midominio.com tu@correo.com
   tvlister-admin setup-ssl stream.midominio.com tu@correo.com
   ```
   Con "Flexible" el tráfico llega por HTTP al servidor y el modo estricto de Cloudflare se rompe.
3. **Regla de caché:** si la ruta termina en `.m3u8` o `.ts` → *Bypass cache*.
4. **Rocket Loader: OFF** (rompe el reproductor web).
5. **WebSockets: ON** (los usan MNF y la vista en vivo).

## 3. Agujero de seguridad que se cierra con esto

`CF-Connecting-IP` y `X-Forwarded-For` los puede escribir cualquiera. El panel las creía **siempre**:
bastaba mandar la cabecera a mano para que el bloqueo por IP de una línea, el firewall y el control
de sharers vieran la IP que al atacante le diera la gana.

Ahora sólo se aceptan si la conexión llega de un proxy de confianza (loopback, red privada o
`TVLISTER_TRUSTED_PROXIES`). Comprobado:

| Petición | Cabecera enviada | IP que ve el panel |
| --- | --- | --- |
| Desde `8.8.8.8` (directo) | `CF-Connecting-IP: 1.2.3.4` | `8.8.8.8` (cabecera ignorada) |
| Desde `127.0.0.1` (nginx) | `CF-Connecting-IP: 1.2.3.4` | `1.2.3.4` |
| Desde `192.168.1.9` (LAN) | `X-Forwarded-For: 5.6.7.8, …` | `5.6.7.8` |

## 4. Cómo se verificó

- `tvlister-admin cloudflare …` ejecutado con nginx simulado: escribe los cuatro archivos, enlaza los
  dos sitios y recarga (`nginx -t` correcto).
- `/root` como alternativa cuando el servidor no tiene `/etc/nginx` (XUI.one con nginx embebido).
- `get.php` **antes** de configurar nada: `http://<host-del-panel>/live/demo/demo123/1.m3u8`.
- `get.php` **después**: `https://stream.midominio.com/live/demo/demo123/1.m3u8`, y el
  `player_api.php → server_info` sigue apuntando al dominio del panel.
- `cloudflare --clear` borra la clave y devuelve todo al comportamiento anterior.

## 5. Si de verdad necesitas video por CDN

- **Cloudflare Stream** (producto aparte, se paga por minuto servido) si es VOD.
- **Cloudflare Enterprise** con el add-on de video, si es un headend grande.
- O una CDN de video de verdad (Bunny, Fastly, Akamai) delante del subdominio de streams.

Un plan gratis/pro con 145 canales en TS no es el sitio: ni por contrato ni por rendimiento.
