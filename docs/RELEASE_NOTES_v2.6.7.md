# TVLister 24/7 — v2.6.7 «Tus dos dominios: panel y video»

Configurar `tvadmin.alphadigitalnic.xyz` (panel, por Cloudflare) y
`live-stream.alphadigitalnic.xyz` (video, directo) ya no es editar ajustes a ciegas: el panel los
guarda, comprueba DNS, certificado y proxy **desde el propio servidor**, y avisa de lo que rompería
la reproducción.

## 1. Dominios en el panel

*Multi-Puertos HTTPS/HTTP → **Dominios públicos: panel y video*** (o `tvlister-admin dominios`):

| Ajuste | Qué controla |
| --- | --- |
| `panel_domain` | web, API, login, WebTV, DRM |
| `stream_domain` + `public_stream_base` | playlist, `.m3u8`, `.ts`, VOD, `server_info.url` |

Se guardan juntos y validados (sin protocolo, sin ruta, sin dominio inventado). La base pública se
crea sola como `https://live-stream.…` y se rechaza que apunte a otro dominio que el de video.

## 2. Comprobación real, no un semáforo de mentira

`GET /api/domains/check` (y `tvlister-admin dominios`) hace, desde el servidor:

- **DNS**: registros `A`/`CNAME` de cada nombre.
- **Certificado del 443**: asunto, emisor, vencimiento, **si cubre el nombre** (con comodines) y si
  es de confianza para los clientes.
- **HTTP**: código, servidor y, sobre todo, **si hay `cf-ray`** — es la forma de saber si el video
  está pasando por el proxy de Cloudflare, que es el error caro: se corta y puede acabar en
  suspensión.

Cada dominio se juzga según su papel: el panel *puede* ir por Cloudflare (si no, aviso); el video
**no debe** ir nunca.

## 3. IP real de los clientes detrás de Cloudflare

El panel sólo cree `CF-Connecting-IP` si viene de un proxy de confianza. Si no, **todos los clientes
parecen la misma IP** y los límites por IP (intentos de contraseña, anti-compartición) se aplicarían
a todos a la vez. Al guardar los dominios, si se detecta `cf-ray`, se declara el drop-in con los
rangos de Cloudflare y se reinicia el servicio. La lógica se comparte con `tvlister-admin cloudflare`.

## 4. Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| Guardar `tvadmin… / live-stream…` | `panel_domain` + `public_stream_base=https://live-stream.alphadigitalnic.xyz`, puerto 443 implícito |
| Dominio con espacios (`no es un dominio`) | rechazado con mensaje y ejemplo |
| Base pública de otro dominio | rechazada: «no corresponde al dominio de streams» |
| `GET /api/domains/check` | informa DNS real (`104.21.66.70`/`172.67.168.15` = Cloudflare para el panel; `173.208.183.66` directo para el video) y los problemas de certificado uno a uno |
| `tvlister-admin dominios` | mismo informe en consola y código de salida ≠ 0 si hay fallos |
| Sintaxis y build | `bash -n`, `node --check` y `vite build` sin errores |

## 5. Guía

`docs/DOMINIOS_PANEL_STREAMS.md`: DNS en Cloudflare (naranja/gris), certificado **SAN con los dos
nombres**, las dos formas de servir el 443 (nginx de XUI o el propio panel), comprobaciones con
`curl`/`openssl` y tabla de síntomas.

## Instalación

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.7/install.sh | bash
tvlister-admin update
tvlister-admin dominios tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```
