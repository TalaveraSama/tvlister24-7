# TVLister 24/7 — v2.5.28 «Por qué puerto salen los streams (80 / 443 / 8095)»

Respuesta corta: **salen por el mismo puerto por el que el cliente pide la lista**. Y ahora se
puede fijar a uno concreto con un comando.

```bash
tvlister-admin release v2.5.28
tvlister-admin streams-port            # estado: por dónde salen ahora
tvlister-admin streams-port 80 midominio.com
```

## 1. Cómo funciona (comprobado con peticiones reales)

| El cliente abre | Los enlaces de video salen por |
| --- | --- |
| `http://tvadmin.alphadigitalnic.xyz/` (puerto 80) | `http://tvadmin.alphadigitalnic.xyz/live/…` → **80** |
| `https://tvadmin.alphadigitalnic.xyz/` (443) | `https://tvadmin.alphadigitalnic.xyz/live/…` → **443** |
| `http://203.0.113.20:8095/` | `http://203.0.113.20:8095/live/…` → **8095** |

Salida real de la prueba (mismo panel, tres peticiones):

```
A) directo a :8095  ->  http://127.0.0.1:8095/live/ruben/ruben2026/1.m3u8
B) dominio en 80    ->  http://tvadmin.alphadigitalnic.xyz/live/ruben/ruben2026/1.m3u8
C) https tras nginx ->  https://tvadmin.alphadigitalnic.xyz/live/ruben/ruben2026/1.m3u8
```

Es decir: **si tus clientes entran por el dominio sin puerto, ya están saliendo por el 80.** No
hace falta tocar nada. El `:8095` sólo aparece cuando alguien da la IP y el puerto a mano.

## 2. Fijarlo a un puerto (nuevo comando)

```bash
tvlister-admin streams-port                      # estado y explicación
tvlister-admin streams-port 80  midominio.com    # el más común
tvlister-admin streams-port 443 midominio.com    # HTTPS
tvlister-admin streams-port 8095 203.0.113.20    # el interno
tvlister-admin streams-port auto                 # quitar la fijación
```

Qué hace: escribe `public_stream_base`, que es lo que usa el panel para construir **todos** los
enlaces (playlist de `get.php`, `player_api.php`, `.m3u8`, `.ts`, VOD y catch-up). Con una base
fija, da igual por dónde entre el cliente: los enlaces siempre salen por el puerto elegido.

```
✅ Base pública de streaming: http://midominio.com
   Todos los enlaces de video saldrán por el puerto 80.
```

```
   el enlace entregado: http://midominio.com/live/ruben/ruben2026/1.m3u8
```

Se aplica **al instante** (se lee de la base en cada petición), sin reiniciar ni recargar nginx.

## 3. Lo que hace falta para el 80

1. Un **server block** que atienda ese nombre y haga proxy a `127.0.0.1:8095` — lo crea
   `tvlister-admin cloudflare <panel> <streams>`, y la `location /` ya reenvía `/live/`, `/hls_proxy/`,
   `.m3u8` y `.ts`.
2. Un **registro A** que apunte a tu servidor.
3. Si es para **video**, el registro debe estar en **GRIS** en Cloudflare. En naranja el video
   pasaría por su proxy: no está permitido en planes self-serve y además añade buffering.

Para HTTPS (443): server block con certificado válido (Origin Certificate de Cloudflare o Let's
Encrypt) — `cloudflare … --cert/--key`.

## 4. El `--check` ahora dice el puerto

```
  [OK]    Base pública de streaming: http://live-stream.alphadigitalnic.xyz
          Puerto de salida de los streams: 80 (http)
```

Y si el puerto no es estándar, avisa:

```
          Puerto de salida de los streams: 8095 (http)
          [AVISO] Puerto no estándar: algunos reproductores y redes lo bloquean.
                  Para usar el 80: tvlister-admin streams-port 80 stream_dominio
```

También comprueba el dominio de streams con **su** esquema y puerto reales (antes forzaba
`https://` siempre, así que un enlace `http://` en el 80 se probaba mal).

## 5. Recomendación para tu caso

- **Panel**: por Cloudflare en 443 (`https://tvadmin…`) — ya está.
- **Video**: por un subdominio en gris, en el **80**: `streams-port 80 live-stream.alphadigitalnic.xyz`.
  El 80 es el que menos bloquea (hoteles, redes corporativas, TV boxes y Smart TV rara vez
  bloquean el 80; el 8095 sí lo bloquean muchas).
- Si algún cliente exige HTTPS, entonces `streams-port 443` con certificado; el 443 también pasa
  casi siempre.
- El 8095 déjalo sólo para administración desde la red interna.

## 6. Pruebas

| Prueba | Resultado |
| --- | --- |
| Enlaces por :8095 | `http://IP:8095/live/…` |
| Enlaces por dominio en 80 | `http://dominio/live/…` (sin `:80`) |
| Enlaces por https | `https://dominio/live/…` |
| `streams-port 80 dominio` | base `http://dominio`, enlaces por 80 |
| `streams-port 443 dominio` | base `https://dominio` |
| `streams-port 8095 IP` | base `http://IP:8095` |
| `streams-port auto` | vuelve a seguir la petición |
| Sin dominio | error con el uso correcto |
| `--check` | muestra el puerto y avisa si no es 80/443 |
| `streams-check` | «Los enlaces de video salen por: …» con el puerto real |
