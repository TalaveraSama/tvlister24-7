# TVLister 24/7 — v2.6.3 «Fase 1 en un clic: AES-128 en todos los canales HLS»

Implementado lo que acordamos: **AES-128 emitido por tu panel**, en todos los canales que se puedan
cifrar, con rotación cada 10 min y revocable por línea. Dos comandos y listo.

```bash
tvlister-admin drm protect-all              # ver qué se cifra y qué no, con el motivo
tvlister-admin drm protect-all --apply      # activarlo en el panel
tvlister-admin drm push-all                 # enviar el bloque drm a Flussonic
```

En el panel: *DRM & Claves* → tarjeta **Fase 1** con tres botones (*Ver qué se cifra* / *Proteger
todos* / *Enviar a Flussonic*).

## Qué entra y qué no (y por qué)

| Canal | Decisión | Motivo |
| --- | --- | --- |
| Empaquetado por **Flussonic** | **Se cifra** | Es donde vive el `drm aes128` y el CAS del panel |
| Empaquetado por el **FFmpeg de TVLister** | fuera | Cifrarlo exigiría `-hls_key_info_file` en la línea de argumentos de FFmpeg, y esa línea no se toca |
| **Nodo cabecera Astra** | fuera | Lo empaqueta el nodo, no Flussonic |
| **Alimenta el UDP de CATV** (Flussonic) | **fuera por defecto** | Pediste que el UDP no se vea afectado *para nada*. `--include-catv` lo fuerza, avisando |
| Archivo local / MNF / canal detenido | fuera | No hay HLS de Flussonic que cifrar |

El plan te lo dice canal por canal, con el nombre del stream en Flussonic deducido de la URL:

```
  Canales totales     : 5
  Se pueden cifrar    : 2
  Ya protegidos       : 1
  Se quedan fuera     : 2

  SE CIFRAN (Flussonic empaqueta):
   #3    Canal Flussonic B           -> canalB

  SE QUEDAN FUERA (y por qué):
   #2    Canal Flussonic A           Lo usa el UDP de CATV (CH 7, 8): cifrarlo podría afectar la salida analógica
   #4    Canal Transcode C           TVLister lo empaqueta con su FFmpeg (cifrarlo exigiría tocar los argumentos de FFmpeg)
```

## El paso que falta para que Flussonic cifre

El panel ya tiene las claves y los tokens; el cifrado lo hace Flussonic. Dos formas:

- **Automático**: `tvlister-admin drm push-all` (o el botón *Enviar a Flussonic*). Lee cada stream por
  la API v3, le añade `drm aes128 keyserver=…` y lo guarda. Respeta `inputs`, `transcoder`, `dvr` y
  `protocols` del stream; si uno falla, te dice exactamente cuál y por qué (por ejemplo: no hay
  servidor Flussonic configurado en el panel).
- **Manual**: `tvlister-admin drm snippet <canal>` y pegar el bloque en
  `/etc/flussonic/flussonic.conf`.

## Arreglo importante en la URL de la clave

`X-Key-Url` (la URL que Flussonic publica en el HLS para que el reproductor pida la clave) usaba la
base **de la petición**, y el CAS lo llama Flussonic. Si Flussonic llama por `127.0.0.1`, el
reproductor del cliente recibía `http://127.0.0.1:8095/drm/key/...` → pantalla negra. Ahora usa
siempre la base que ven los clientes:

1. `public_stream_base` (lo que fija `streams-port`/`cloudflare`),
2. `panel_domain` si existe,
3. y solo si no hay nada, la base de la petición (avisado en el panel).

## Comprobado

| Prueba | Resultado |
| --- | --- |
| Plan con 5 canales de prueba | 1 cifrable, 1 ya protegido, 3 fuera con motivo correcto |
| Canal usado por CATV | excluido; y con `--include-catv` entra, marcado `[CATV CH 7,8]` |
| `--apply` | activa AES-128 en el panel (master key + tokens nuevos por canal) |
| `--include-catv` sin `--apply` | sólo plan, no cambia nada |
| `drm push-all` sin Flussonic configurado | 0/2 enviados, con el motivo real por canal (no finge éxito) |
| Clave del canal 2: CAS vs reproductor | **16 bytes idénticos** |
| `get_drm` tras aplicar | los 3 canales con `aes128` y su `key_url` |
| Lista M3U y resto del panel | siguen sirviendo igual |
| `/api/drm/bulk/*` sin sesión | `401` |

## Siguiente

Con esto la Fase 1 queda operativa. Si quieres, lo siguiente natural es un **informe en el panel**
de "canales sin DRM" (para que no se te escape ninguno tras añadir canales nuevos) y el aviso en el
Dashboard cuando un canal nuevo entre sin proteger.
