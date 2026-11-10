# TVLister 24/7 — v2.5.22 «Saber por qué no se reproduce un canal»

Un comando nuevo que recorre el camino completo de un canal, igual que lo hace el
reproductor del cliente, y dice en qué eslabón se rompe:

```bash
tvlister-admin streams-check
tvlister-admin streams-check demo demo123        # con una línea concreta
tvlister-admin streams-check demo demo123 7      # y un canal concreto
```

En el menú es la opción **26**.

---

## 1. Qué comprueba (en este orden)

| Paso | Qué mira | Si falla dice |
| --- | --- | --- |
| 1 | El panel responde en su puerto (`/api/health`) | «Sin panel arriba no hay lista ni HLS» |
| 2 | La base pública de video (`public_stream_base`) | De qué dominio salen los enlaces |
| 3 | `get.php` con una línea activa | Cuántos canales entrega, o el error exacto del panel |
| 4 | El primer enlace de la lista, tal cual | Código HTTP, tipo, y si viene de Cloudflare (`cf-ray`) |
| 5 | El primer segmento HLS | Si el segmento llega o el reproductor se queda en negro |
| 6 | El TLS del dominio de video | Si es `https` sin certificado válido, o si el dominio ni existe |

Salida sana:

```
  [OK]    Panel arriba en 127.0.0.1:8095
  [INFO]  Los enlaces de video salen por: https://live-stream.midominio.com
  [OK]    get.php entrega 212 canales a esta línea
  [INFO]  HTTP 200 · tipo: application/vnd.apple.mpegurl · servidor: nginx
  [OK]    Playlist HLS válida (6 líneas de segmento)
  [OK]    El segmento llega completo: el canal se puede reproducir.
  [OK]    TLS del dominio de video: certificado válido hasta ...
```

## 2. Los tres fallos que más se ven, con su mensaje

**a) El dominio de video no existe en el DNS.** Es lo que pasa si guardaste
`public_stream_base` con un subdominio que todavía no tiene registro A. Todos los
enlaces de la lista apuntan a un dominio muerto y **no se ve ningún canal**:

```
  [FALLA] No se pudo conectar con ese enlace.
          curl: (6) Could not resolve host: live-stream.midominio.com
          -> vuelve al dominio del panel ya mismo:
             tvlister-admin cloudflare --clear && tvlister-admin restart
```

**b) El dominio de video está en naranja (proxied) en Cloudflare.** Se detecta por
la cabecera `cf-ray`:

```
  [FALLA] Ese dominio de video está pasando por Cloudflare (cf-ray ...).
```

**c) La fuente del canal no está entregando.** El panel responde 503 con el motivo
real, así que no se confunde con un problema de red:

```
  [FALLA] Respondió 503: Señal RTMP/SRT/RTSP sin transmisión activa...
          El problema está en la FUENTE del canal...
```

También distingue 401/403 (línea sin permiso), 404 (canal fuera del aire), 429
(límite de conexiones), 502/504 (proxy), HTML en vez de video (portal o página de
Cloudflare) y `https` sin certificado.

## 3. Avisos nuevos al aplicar el proxy

`tvlister-admin cloudflare` ahora avisa **antes** de dejar los enlaces apuntando a
un sitio que no existe:

- si el dominio de streams no resuelve en el DNS;
- si resuelve a otra IP que no es este servidor.

Antes lo aplicaba en silencio y el resultado era «no se ve nada» sin pista alguna.

## 4. Cómo se probó

Con el panel real levantado y un HLS local, 6 escenarios:

| Escenario | Resultado |
| --- | --- |
| Canal con fuente buena | playlist válida + segmento 200 de 188.000 B |
| Canal con fuente muerta | 503 con el motivo de la fuente |
| Dominio de video inexistente | «Could not resolve host» + orden de vuelta atrás |
| Base pública correcta | todo `[OK]` |
| Panel caído | `[FALLA]` en el primer paso, sin seguir |
| Línea con contraseña mal | error del panel (`Usuario o contraseña inválidos`) |

## 5. Si ahora mismo no ves los canales

```bash
tvlister-admin release v2.5.22
tvlister-admin cloudflare --clear     # vuelve al dominio del panel
tvlister-admin restart
tvlister-admin streams-check          # y mira dónde se rompe
```

Con los enlaces saliendo por el dominio del panel, el video funciona con la misma
URL que antes de tocar Cloudflare. Cuando el DNS del subdominio de streams exista y
responda en este servidor, se vuelve a aplicar `cloudflare`.
