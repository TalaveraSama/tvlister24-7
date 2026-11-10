# TVLister 24/7 — v2.6.12 «Video directo, panel por Cloudflare (sin 8443 ni naranja)»

Esta versión cierra la pregunta de cómo repartir los dos dominios: **el panel puede ir por
Cloudflare; el video no.** Y arregla dos cosas que estorbaban al hacerlo con nombres reales.

## 1. `streams-port 8443` guardaba `http://`, no `https://`

El comando decidía el esquema con «si no es 443, es HTTP». Con 8443 los enlaces de video salían
como `http://live-stream…:8443`, que ningún reproductor abre (ese puerto es TLS).

Ahora se tratan como HTTPS los puertos **443, 8443, 2053, 2083, 2087 y 2096** (los que Cloudflare
acepta para TLS, aunque con el video siempre en nube gris). Además el comando avisa de que el 8443
no cambia nada respecto a Cloudflare y de que el 443 es el puerto que menos falla en redes móviles.

## 2. Un certificado para los dos nombres

`acme` acepta varios dominios y emite **un solo certificado SAN** que cubre panel y video:

```bash
sudo tvlister-admin acme tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz correo@dominio.com
```

- Usa `--webroot` (no necesita el 80 libre): sigue funcionando con el panel o el nginx de XUI.one
  ocupando el puerto.
- Guarda el certificado con `--cert-name <primer dominio>` y lo instala **por SNI para cada nombre**.
- `TVLISTER_ACME_DIR` se respeta también en el comando (antes estaba fijo a `/var/www/tvlister-acme`).
- El correo se detecta por el `@`; el orden de los dominios no importa.

## 3. Documentación de la decisión

`docs/DOMINIOS_PANEL_STREAMS.md` explica con la tabla de puertos de Cloudflare por qué el video
**no** puede ir por el proxy (ni en 8443, ni en 2053, ni en ninguno):

- El proxy self-serve prohíbe el video continuo (ToS 2.8) y añade buffering, cortes y riesgo de
  suspensión del dominio.
- Si algún día hace falta Cloudflare delante del video, los productos válidos son **Stream** o
  **Spectrum** (de pago); el proxy normal no lo es.
- Con el registro en **gris** el puerto es irrelevante para Cloudflare: el tráfico va directo al
  servidor. Por eso el 443 es la mejor elección (y el 8443 solo si hay un motivo concreto).

## Comprobado

| Prueba | Resultado |
| --- | --- |
| `streams-port 8443 live-stream.alphadigitalnic.xyz` | guarda `https://live-stream.alphadigitalnic.xyz:8443` |
| `streams-port 443 …` | guarda `https://live-stream.alphadigitalnic.xyz` (sin `:443`) |
| `acme a b correo` con un certbot simulado | `certonly --webroot -w … -d a -d b --cert-name a` y una instalación por dominio |
| DNS real de los dos nombres | `tvadmin` → IPs de Cloudflare (naranja, correcto); `live-stream` → IP del servidor (gris, correcto) |
| `vite build`, `bash -n`, `node --check` | correctos |

## Instalación

```bash
sudo tvlister-admin update
sudo tvlister-admin dominios tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
sudo tvlister-admin acme tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz correo@dominio.com
```
