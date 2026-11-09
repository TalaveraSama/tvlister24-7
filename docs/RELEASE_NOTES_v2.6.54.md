# TVLister v2.6.54 — si falta yt-dlp, el panel lo dice (no «está roto»)

Sobre v2.6.53. Un detalle que se veía justo al probar lo de YouTube: en un servidor **sin** yt-dlp, la pantalla
decía *«yt-dlp está en el sistema pero no arranca»*. Era falso: lo que pasaba es que el panel daba por hecho que el
binario existía por el simple hecho de llamarse `yt-dlp`.

- Ahora, cuando el candidato es un nombre suelto, se comprueba que **esté de verdad en el `PATH`**; si no, se sigue
  buscando en `.runtime/bin`, `/usr/local/bin`, `/usr/bin`…
- Si no hay ninguno: `installed: false`, **binario vacío** y el consejo correcto (*«Falta yt-dlp. Instálalo con
  “Instalar yt-dlp”…»*), que es lo que muestra el botón de la pantalla.
- Si existe pero no arranca (falta python3, binario roto), se sigue avisando igual: ese mensaje sólo sale cuando el
  binario está y falla.

Pruebas: `node scripts/test_youtube_live.mjs` → **82 OK** (cuatro nuevas: sin yt-dlp no se inventa una ruta, el
estado dice que falta, el probe pide instalarlo y no dice que esté roto). `test_youtube_live_ui.mjs` → 53 OK.

## Actualizar

```bash
sudo tvlister-admin update
```
