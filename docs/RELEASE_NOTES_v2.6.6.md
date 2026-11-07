# TVLister 24/7 — v2.6.6 «HTTPS en el 80 y el 443, servido por el panel»

Hasta ahora el gestor de puertos sólo abría **HTTP plano**: añadir el 443 daba un puerto que no
cifraba nada, y los reproductores o redes que exigen HTTPS se quedaban fuera. En esta versión cada
puerto puede abrirse en tres modos y el panel sirve TLS por sí mismo, sin nginx y sin Cloudflare.

## 1. Tres modos por puerto

| Modo | Qué acepta | Para qué |
| --- | --- | --- |
| `https` | sólo TLS; el texto plano se corta | **el 443** de siempre |
| `both` | TLS **y** HTTP en el mismo puerto (se mira el primer byte). En el 80 el HTTP contesta `301` al mismo host por HTTPS | **el 80**, sin dejar fuera a nadie |
| `http` | HTTP plano, como antes | 8080, 8880, 25461… |

Y sin modo indicado: **443 → `https`**, **80 → `both`**, cualquier otro → **`http`**, que es
exactamente lo que hacía antes. Los puertos ya guardados (`8880, 25461`) se leen sin romperse.

En el panel: *Ingesta → Multi-Puertos HTTPS/HTTP* → botones **:443 HTTPS** y **:80 HTTPS+HTTP**, con
selector de protocolo para cualquier otro puerto.

```bash
tvlister-admin add-port 443 https
tvlister-admin add-port 80 both
tvlister-admin add-port 8880 http
```

## 2. Certificado: se busca solo, nunca se inventa

El panel busca el certificado en `TVLISTER_TLS_CERT/KEY`, en las rutas guardadas, en Let's Encrypt
(`/etc/letsencrypt/live/<dominio>/`), en acme.sh y en `/etc/tvlister/tls/`. Si no hay ninguno el
puerto HTTPS **no se abre** y la pantalla dice qué falta: no se genera un autofirmado, porque eso
sólo provoca reproductores que se niegan a conectar.

```bash
tvlister-admin tls                                   # estado: dominio, fuente, días
tvlister-admin tls /ruta/fullchain.pem /ruta/privkey.pem   # fijar rutas
tvlister-admin tls auto                              # volver a la detección automática
```

La tarjeta del panel muestra dominio, caducidad, origen y **qué dominios no cubre** el certificado;
avisa en ámbar a 21 días y en rojo si está caducado. Tras renovar, **Reabrir puertos TLS** recarga el
certificado sin reiniciar el panel (`POST /api/ports/rebind`).

## 3. Lo que se comprobó ejecutando

| Prueba | Resultado |
| --- | --- |
| Puerto 443 en modo `https` | `https://127.0.0.1/player_api.php` → 200; en texto plano, conexión cortada |
| Puerto 80 en modo `both` | `https://…:80/` → 200 y `http://…/live/…` → `301` a `https://mismo-host/misma-ruta` |
| Certificado servido | `openssl s_client` → `CN = panel.test` |
| Persistencia | reinicio del panel y 80/443 vuelven a levantarse solos |
| Sin certificado | 443 no se abre y la API explica el motivo; HTTPS en 8444 rechazado, HTTP en 8880 sigue abriendo |
| Rutas erróneas | `{"error":"No se puede leer el certificado o la clave en esas rutas…"}` |
| Compatibilidad | base antigua `8880, 25461` → `http` en ambos puertos |
| Puerto ocupado | `EADDRINUSE` explicado con la salida (liberar o dejar que nginx haga proxy) |

## 4. Detalles que importan en producción

- **Puertos < 1024** necesitan root o `CAP_NET_BIND_SERVICE`; el error lo dice tal cual.
- El `301` del 80 conserva host y ruta, así una lista M3U con enlaces `http://` sigue funcionando.
- En el **443** el texto plano también se redirige a HTTPS en vez de servirse.
- Cloudflare: el panel puede ir en naranja con *Full (strict)* si el certificado es de CA pública; el
  **video sigue saliendo por subdominio DNS only** y por `public_stream_base`, como ya estaba.
- Guía completa: `docs/PUERTOS_HTTPS_80_443.md`.

## Instalación / actualización

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.6/install.sh | bash
tvlister-admin update
tvlister-admin tls          # ver qué certificado hay
tvlister-admin add-port 443 https
```
