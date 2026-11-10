# TVLister 24/7 — v2.5.21 «Cloudflare en un servidor con XUI.one»

El comando `cloudflare` no te dejó nada configurado en `s309214`: buscaba el nginx del sistema
(`/etc/nginx/sites-available`) y en tu máquina manda el **nginx interno de XUI.one**. Esta versión lo
detecta e instala ahí.

```bash
tvlister-admin release v2.5.21
tvlister-admin cloudflare tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
tvlister-admin cloudflare --check tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz
```

---

## 1. Qué estaba roto (y ya no)

| # | Fallo | Qué te pasó | Cómo queda |
| --- | --- | --- | --- |
| 1 | Sólo miraba `/etc/nginx/sites-available` | «No hay nginx del sistema… se generan los archivos en /root» y **nada** quedó configurado | Detecta el nginx de **XUI.one** (`<xui>/bin/nginx/conf/servers`), el del sistema (`sites-available` o `conf.d`) o, si no hay ninguno, deja los archivos en `/root` |
| 2 | La base de streaming sólo se guardaba si había nginx del sistema | `--check` decía «Sin base pública de streaming» y las playlist seguían saliendo por el dominio del panel | Se guarda **siempre**, haya o no nginx |
| 3 | `--check` se cortaba tras el panel | Sólo veías la línea del panel y volvía al prompt | Las consultas de red van con `|| true`: el informe sale completo (fallo clásico de `set -e` + `curl` fallido) |
| 4 | Sin forma de tener HTTPS en el origen | `setup-ssl` generaba un archivo inútil en `/root` | `setup-ssl` explica la vía correcta en un servidor XUI (Origin Certificate) y `cloudflare --cert/--key` lo instala |
| 5 | Riesgo de tumbar el panel al recargar | — | Si `nginx -t` falla, **no recarga** y deja los archivos como `.disabled`; el nginx de XUI.one sigue en pie |

## 2. Qué hace ahora en tu servidor

```
  nginx detectado: XUI.one (/home/xui/bin/nginx/conf/servers)
✅ nginx de XUI.one recargado con los dos server blocks.
  Base pública de streaming: https://live-stream.alphadigitalnic.xyz
```

- Escribe **`/home/xui/bin/nginx/conf/servers/tvlister-panel.conf`** y **`tvlister-streams.conf`**
  (la carpeta que XUI.one incluye con `conf/servers/*.conf`, verificado en su propio código).
- Hace copia de los archivos anteriores (`*.bak.<epoch>`) antes de sobrescribir.
- Prueba con `/home/xui/bin/nginx/sbin/nginx -t` y recarga con `-s reload`. Si la prueba falla, no
  recarga y desactiva los archivos nuevos.
- Si XUI.one ya tiene certificado (`conf/ssl.conf`), lo **reutiliza** en los dos server blocks; si no,
  genera sólo `listen 80` y te indica cómo ponerle uno.

### Con certificado (recomendado: Origin Certificate, 15 años, sin renovar)

```bash
# 1. Cloudflare -> SSL/TLS -> Origin Server -> Create Certificate (copia .pem y .key)
# 2. En el servidor:
nano /root/origin.pem      # pega el certificado
nano /root/origin.key      # pega la clave
tvlister-admin cloudflare tvadmin.alphadigitalnic.xyz live-stream.alphadigitalnic.xyz \
  --cert /root/origin.pem --key /root/origin.key
```

Ahora los dos server blocks escuchan en `80` y `443 ssl` con ese certificado, que es lo que
Cloudflare necesita para **Full (strict)**.

## 3. `--check` completo

```
  [OK]    Base pública de streaming: https://live-stream.alphadigitalnic.xyz
  Origen         : 203.0.113.20 (se consulta directo, sin Cloudflare)
  Panel: https://tvadmin.alphadigitalnic.xyz
         IP resuelta : 2606:4700:3031::6815:4246  ·  Servidor: cloudflare
         [OK]    El panel va por Cloudflare.
         [OK]    El origen (203.0.113.20) sirve tvadmin.alphadigitalnic.xyz directamente (nginx)
         Certificado : caduca Mar 14 12:00:00 2027 GMT
  Streams: https://live-stream.alphadigitalnic.xyz
         IP resuelta : 203.0.113.20  ·  Servidor: nginx/1.24.0
         [OK]    Directo al servidor (sin Cloudflare), como debe ser.
  [OK]    nginx de XUI.one: server blocks en /home/xui/bin/nginx/conf/servers
  [OK]    Proxies de confianza declarados en el servicio (anti-spoofing)
```

Novedades: comprueba el **origen directamente** (con `--resolve`, sin pasar por Cloudflare), así
distingue "Cloudflare responde" de "mi nginx sirve el dominio", y avisa si el subdominio de streams
está en naranja. Sale con código 1 si algo está mal, para poder ponerlo en un cron.

## 4. Cómo se probó

Los cuatro escenarios, con nginx simulado y tus dominios reales como datos:

| Escenario | Resultado |
| --- | --- |
| nginx de XUI.one | server blocks en `conf/servers`, `-t` OK, reload ejecutado |
| XUI.one con `nginx -t` fallando | no recarga y deja `.disabled`; el panel no se rompe |
| nginx del sistema (`sites-available`) | sitios enlazados, `real_ip` en `conf.d`, reload |
| nginx sin `sites-available` (RHEL/Alpine) | server blocks en `/etc/nginx/conf.d` |
| sin ningún nginx | archivos en `/root` + `base_stream` guardada igualmente |
| `--cert/--key` | `listen 443 ssl` + `ssl_certificate` en los dos bloques |
| `cloudflare --clear` | borra la base y vuelve al comportamiento anterior |

Y de punta a punta con el panel encendido: `get.php` pasó de
`http://<host>/live/demo/demo123/1.m3u8` a `https://live-stream.alphadigitalnic.xyz/live/demo/demo123/1.m3u8`,
mientras `player_api.php → server_info` seguía informando el dominio del panel.

## 5. Lo que sigue igual

- El video **no** va por Cloudflare (ni se camufla): su contrato no permite streaming continuo en
  planes self-serve y su proxy mete buffering. El panel sí se beneficia de Cloudflare.
- No se toca la línea de FFmpeg ni la cadena UDP.
