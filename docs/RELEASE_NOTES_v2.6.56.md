# TVLister v2.6.56 — el yt-dlp del panel arranca siempre (también sin Python)

Sobre v2.6.55. Respuesta al error que salía al pulsar **Instalar yt-dlp**:

```
File "/usr/lib/python3.10/runpy.py", line 194, in _run_module_as_main
ModuleNotFoundError: No module named '_ssl'
```

El panel se quedaba sin yt-dlp y los canales de YouTube no se podían emitir. Ya no pasa.

## Qué ocurría

El enlace «oficial» de GitHub (`yt-dlp`) **no es un binario**: es un zipapp de Python. Necesita el
**python3 del sistema** (≥ 3.9) con los módulos `_ssl` y `sqlite3`. En servidores recortados
(instalaciones mínimas, XUI.one, contenedores) ese Python existe pero está incompleto, así que el
programa se descarga bien y **revienta al arrancar**. El panel, además, daba por buena la descarga
antes de probarla.

## Cómo queda

1. **Primero el binario autónomo.** Se baja `yt-dlp_linux` (o `yt-dlp_linux_aarch64` según la CPU),
   **~39 MB**, que lleva dentro su propio Python: no depende de nada del sistema. Si por lo que sea
   ese archivo no está, se prueba el zipapp como plan B.
2. **Se prueba antes de instalarlo.** El archivo se descarga como `yt-dlp.tmp.<hora>.<variante>`, se
   le da permiso de ejecución y se lanza `--version`. Sólo si responde se mueve a
   `.runtime/bin/yt-dlp`. **Nunca queda un binario roto con el nombre bueno**: si falla, no se toca
   el que hubiera.
3. **Si nada arranca, se dice por qué.** El mensaje trae las **últimas 3 líneas** del error
   (`ModuleNotFoundError: No module named '_ssl'`…) y qué se intentó (`zipapp`, `standalone`). Ya no
   promete `apt install python3`, que es justo lo que no se puede hacer en estos servidores.
4. **La instalación va en segundo plano.** Son ~39 MB: una petición HTTP abierta se corta en el
   proxy (Cloudflare corta a los 100 s) y el panel se quedaba colgado. Ahora `POST /api/youtube/install`
   arranca el trabajo y responde al instante; la pantalla pregunta a `GET /api/youtube/install-status`
   y va enseñando el paso: *«descargando binario autónomo…»*, *«comprobando que arranca…»*. Si pulsas
   dos veces, no se lanza una segunda descarga.
5. **La pantalla lo explica.** El estado incluye la variante instalada; el mensaje de éxito añade
   **«· binario autónomo, sin depender de Python»** y, si el binario está pero no arranca, sale
   *«yt-dlp está descargado pero no arranca»* con la pista de volver a instalar.

## Datos que ahora se guardan

- Ajustes: `ytdlp_path`, `ytdlp_version` y `ytdlp_variant` (`standalone` | `zipapp`).
- `GET /api/youtube/status` añade `variant` y un `hint` que, cuando el error huele a Python, dice
  *«Pulsa «Instalar yt-dlp»: ahora baja el binario autónomo…»*.
- `GET /api/youtube/install-status`: `{ running, step, startedAt, result }`.

## Pruebas

- `test_youtube_live.mjs`: **111 OK**. Sección 1c con un `curl` falso que sirve cada variante:
  instala el autónomo y lo deja en `.runtime/bin/yt-dlp`; con el autónomo en 404 usa el zipapp; con
  los dos roto no queda binario y el error trae el `ModuleNotFoundError`; el trabajo en segundo plano
  informa del paso y se puede relanzar al terminar; y por HTTP, contra un panel real, `POST /api/youtube/install`
  responde **202** al instante mientras `GET /api/youtube/install-status` va contando el paso y termina
  diciendo que el panel se quedó **sin** yt-dlp (no finge tenerlo).
- `test_youtube_live_ui.mjs`: **59 OK**, con el aviso del paso mientras instala y el de «no depende
  del Python del servidor» al terminar.

## Actualizar

```bash
sudo tvlister-admin update
```

Y en **Canales 24/7 → YouTube**, pulsa **Instalar yt-dlp**. Si ya tenías uno roto, este lo sustituye.
