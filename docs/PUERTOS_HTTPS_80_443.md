# Puertos HTTPS del panel: 80 y 443

El panel puede servir **él mismo** por HTTPS en los puertos estándar, sin depender de nginx ni de
Cloudflare. Esta guía cubre el certificado, cómo abrir los puertos, qué pasa con cada protocolo en
cada puerto y los errores típicos.

---

## 1. Qué significan los tres modos de puerto

En *Ingesta → Multi-Puertos HTTPS/HTTP* (o `tvlister-admin add-port <puerto> <modo>`):

| Modo | Qué acepta en ese puerto | Para qué |
| --- | --- | --- |
| `https` | **Sólo TLS.** El texto plano se corta | El **443** normal: reproductores que exigen HTTPS |
| `both` | **TLS y HTTP en el mismo puerto** (se mira el primer byte de la conexión). En el 80 el HTTP contesta `301` al mismo host por HTTPS | El **80**, para que ni el navegador ni el reproductor se queden fuera |
| `http` | HTTP plano, como siempre | Puertos altos (8080, 8880, 25461…) y compatibilidad |

Sin modo indicado: **443 → `https`**, **80 → `both`**, **cualquier otro → `http`**. Así, añadir un
8880 sin certificado sigue funcionando exactamente igual que antes.

Ejemplos:

```bash
tvlister-admin add-port 443 https     # HTTPS estándar
tvlister-admin add-port 80 both       # HTTPS en 80 + HTTP redirigido a HTTPS
tvlister-admin add-port 8880 http     # el de siempre, sin TLS
```

Y desde el panel: *Multi-Puertos HTTPS/HTTP* → botones **:443 HTTPS** y **:80 HTTPS+HTTP**.

---

## 2. El certificado (obligatorio para HTTPS)

El panel **no genera certificados autofirmados**: un autofirmado hace que los reproductores rechacen
la conexión y es imposible de distinguir de un ataque. Si no hay certificado, el puerto HTTPS **no se
abre** y la pantalla dice qué falta.

Orden de búsqueda (el primero que exista y sea válido):

1. Variables de entorno `TVLISTER_TLS_CERT` y `TVLISTER_TLS_KEY`.
2. Rutas guardadas en el panel (`tls_cert_path` / `tls_key_path`), desde la UI o `tvlister-admin tls`.
3. Let's Encrypt: `/etc/letsencrypt/live/<dominio>/{fullchain.pem,privkey.pem}`.
4. acme.sh: `~/.acme.sh/<dominio>{,_ecc}/{fullchain.pem,privkey.pem}`.
5. `/etc/tvlister/tls/{fullchain.pem,privkey.pem}`.

El dominio se toma de `panel_domain` / `stream_domain` (los fija `cloudflare` o `streams-port`).

### Emitir el certificado

```bash
# Opción A: Let's Encrypt con certbot (necesita el 80 libre o el plugin de nginx)
sudo certbot certonly --standalone -d tv.midominio.com
#   → /etc/letsencrypt/live/tv.midominio.com/{fullchain,privkey}.pem  (se detecta solo)

# Opción B: Cloudflare Origin Certificate (si el DNS está en Cloudflare)
#   Panel → SSL/TLS → Origin Server → Create Certificate
#   guarda los dos PEM y cárgalos:
tvlister-admin tls /etc/tvlister/tls/fullchain.pem /etc/tvlister/tls/privkey.pem

# Opción C: acme.sh (sin certbot)
~/.acme.sh/acme.sh --issue -d tv.midominio.com --standalone
```

### Comprobar el estado

```bash
tvlister-admin tls          # dominio, fuente, rutas y días de validez
```

o en el panel: la tarjeta **Certificado HTTPS** muestra dominio, caducidad, fuente y qué dominios
quedan sin cubrir. Si caduca en ≤ 21 días avisa en ámbar; **caducado** avisa en rojo.

### Renovar

```bash
sudo certbot renew --deploy-hook "systemctl restart tvlister"     # o
tvlister-admin tls /etc/letsencrypt/live/tv.midominio.com/fullchain.pem \
                   /etc/letsencrypt/live/tv.midominio.com/privkey.pem
```

Si el panel sigue con el certificado viejo en memoria (no se reinició), **Reabrir puertos TLS** en la
UI (o `POST /api/ports/rebind`) recarga el certificado sin reiniciar el panel.

---

## 3. Requisitos del sistema

- **Puertos < 1024:** el servicio corre como root en la instalación estándar; si lo bajas a usuario
  normal, dale `CAP_NET_BIND_SERVICE` o el panel responderá «Permiso denegado» al abrir 80/443.
- **Firewall:** además del panel, abre el puerto:

  ```bash
  sudo tvlister-admin add-port 443
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
  ```

- **Un solo dueño por puerto.** Si el nginx de XUI ya escucha en el 443, el panel dirá
  `Puerto 443 ocupado por otro proceso (EADDRINUSE)`. Dos opciones:
  - liberar el 443 y que lo atienda el panel, o
  - dejar el nginx ahí y que haga proxy al panel (no hacen falta los dos).

---

## 4. Qué contestar en cada caso

| Petición | `https` | `both` (puerto 80) | `http` |
| --- | --- | --- | --- |
| `https://host/...` | sirve | sirve | falla el handshake |
| `http://host/...` | conexión cortada | `301` → `https://host/...` | sirve |
| Certificado ausente | no abre, error explicado | no abre, error explicado | abre igual |

El `301` conserva host y ruta, así que un reproductor que empieza por `http://` (o una lista M3U con
enlaces `http://`) sigue funcionando: el reproductor salta a HTTPS solo.

---

## 5. Cloudflare (importante)

- **Panel/API** sí pueden ir por el proxy de Cloudflare (naranja), con SSL *Full (strict)*.
- **Video** no: los enlaces de los canales deben salir por un subdominio **DNS only (gris)** y por el
  puerto configurado en `public_stream_base`. El proxy no sirve para streaming continuo.
- Con el panel sirviendo HTTPS por sí mismo, Cloudflare en modo *Full (strict)* sólo acepta el
  certificado si es de una CA pública (Let's Encrypt sí; el *Origin Certificate* requiere modo
  *Full*, no *strict*).

---

## 6. Errores típicos y qué significan

| Mensaje | Causa | Solución |
| --- | --- | --- |
| `no hay certificado TLS` | Ninguna ruta válida | `tvlister-admin tls` y emite/carga el certificado |
| `Permiso denegado para el puerto 443` | Servicio sin privilegios | Corre como root o añade `CAP_NET_BIND_SERVICE` |
| `Puerto 443 ocupado por otro proceso (EADDRINUSE)` | nginx/proxy ya lo usa | Libera el puerto o haz proxy desde ese nginx |
| `El certificado y la clave no forman un par válido` | Rutas cruzadas | Verifica que `fullchain` y `privkey` son del mismo dominio |
| El certificado aparece «no cubre: …» | El dominio del panel no está en el SAN | Emite el certificado con `-d` para ese dominio |
| HTTPS funciona en el panel pero no desde Internet | Firewall/NAT | Abre 443 en UFW y en el router/MikroTik |

---

## 7. Cómo verificarlo (los mismos comandos que usa el panel)

```bash
# ¿escucha y responde por HTTPS?
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/player_api.php

# ¿qué certificado se está sirviendo?
echo | openssl s_client -connect 127.0.0.1:443 -servername tv.midominio.com 2>/dev/null \
  | openssl x509 -noout -subject -dates

# ¿el 80 redirige a HTTPS?
curl -sI http://tv.midominio.com/live/usuario/clave/1.m3u8 | grep -i location

# ¿queda texto plano abierto en el 80 (no debería servir contenido)?
curl -s -o /dev/null -w '%{http_code}\n' http://tv.midominio.com/
```
