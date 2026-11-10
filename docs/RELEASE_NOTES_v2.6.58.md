# TVLister v2.6.58 — «Requested format is not available» ya no deja el canal a oscuras

Sobre v2.6.57. Después de arreglar el «no eres un robot» con las cookies, el siguiente muro del mismo enlace:

```
ERROR: [youtube] ioSKlIL4Hs8: Requested format is not available. Use --list-formats for a list of available formats
```

## Qué pasaba (dos cosas, y una era nuestra)

1. **yt-dlp también elige formato por su cuenta.** El panel lo llama con `-J` para leer la ficha, y en ese modo
   yt-dlp hace además su propia selección. Si YouTube no le da **ninguna** pista que encaje —los directos que
   exigen *PO token*, o una sesión de cookies que no ve las pistas de vídeo— aborta con ese error **aunque la
   ficha del vídeo sea perfectamente válida**. El panel no necesita esa elección: elige él sus propias pistas.
2. **YouTube cambia cada pocas semanas qué cliente entrega pistas con URL.** El cliente «normal» puede no ver
   nada mientras `tv`, `web_safari` o `ios` sí. Un panel sano debe probar antes de rendirse.

## Cómo queda

- Todas las lecturas llevan **`--ignore-no-formats-error`**: `-J` ya no aborta por la selección de formato, así
  que el panel recibe la ficha y decide él. (Si aun así no hay pistas, se dice por qué, no se escupe el inglés.)
- **Cadena de clientes**: `normal` → `tv` → `web_safari` → `ios`. Sólo se reintenta cuando el problema es de
  formatos (no cuando el vídeo no existe, es privado o pide login), así que no se pierde tiempo en los casos
  normales. El resultado dice con qué se probó (`clients_tried`) y la tarjeta lo enseña.
- Si **ningún** cliente da una pista con URL, el mensaje es accionable: *«YouTube no ha dado ninguna pista de
  vídeo utilizable para este enlace («Requested format is not available»). Suele arreglarse actualizando
  yt-dlp…»*, con el texto original plegado en **detalle técnico**.
- **Botón «Actualizar yt-dlp»** en ese aviso. Reutiliza el instalador (descarga el último binario autónomo) y,
  al terminar, **vuelve a comprobar el enlace solo**.
- **Aviso de versión**: el panel consulta la última publicada en GitHub (cache 6 h, de fondo, sin bloquear; si
  no hay red se calla) y, si la instalada es más vieja, lo dice con su botón de actualizar. Compara bien
  `2026.10.26` con `2026.10.26-standalone` y no avisa cuando la instalada ya es la última.
- La renovación automática de la URL usa el mismo camino: un fallo de formatos ya no deja el canal muerto sin
  explicación; queda «SIN SEÑAL» con el motivo y se reintenta solo.

## API

- `POST /api/youtube/probe` → `needs_format_fix`, `clients_tried`.
- `GET /api/youtube/status` → `release: { tag, error }`, `latest_version`, `update_available`.
- `GET /api/channels247` → el estado del canal guarda `needs_format_fix` y `clients_tried`.
- Variables: `TVLISTER_YTDLP_RELEASES=0` (no consultar GitHub) y `TVLISTER_YTDLP_RELEASE_API` (otra URL).

## Pruebas

- `test_youtube_live.mjs`: **150 OK**. Nuevas: un yt-dlp falso que **sólo** entrega pistas con
  `--extractor-args youtube:player_client=tv` (se comprueba el reintento y que **todas** las llamadas llevan
  `--ignore-no-formats-error`), el caso de los cuatro clientes sin pistas (mensaje accionable + detalle), y la
  consulta de la última versión (servidor de prueba local, comparación de versiones).
- `test_youtube_live_ui.mjs`: **83 OK**, con el aviso de formatos, el botón «Actualizar yt-dlp», el reintento
  automático del enlace al terminar y el aviso de versión nueva.

## Actualizar

```bash
sudo tvlister-admin update
```

Y en la pantalla, si sale el aviso: **Actualizar yt-dlp** (o el botón junto al estado, cuando avise de versión
nueva).
