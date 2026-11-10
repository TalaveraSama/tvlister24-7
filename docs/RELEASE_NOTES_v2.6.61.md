# TVLister v2.6.61 — «¿por qué no iniciar sesión?»: no se puede con contraseña, y las cookies SON la sesión

Sobre v2.6.60. Aclaración de la pregunta más lógica: *«¿por qué no iniciamos sesión en YouTube y ya está?»*.

## La respuesta corta

**Porque YouTube no deja.** No es una limitación del panel ni algo que hayamos evitado:

- Google **bloquea el inicio de sesión automático** con usuario y contraseña desde programas (máquinas,
  datacenter, IP sin navegador) y obliga a verificación en dos pasos.
- yt-dlp lo dice con todas las letras en su propio código: `Login with password is not supported for YouTube` y
  `Login with OAuth is no longer supported`. No hay `--username/--password` que funcione con YouTube.

Y la buena noticia: **ya lo hacemos**. Un archivo de cookies de un navegador con la sesión iniciada **es** la
sesión: lleva el `SID` / `__Secure-3PSID` con el que YouTube identifica a la cuenta. Es exactamente «haber
iniciado sesión», pero sin darle la contraseña al servidor (y sin que Google lo bloquee).

## Qué se añade en esta versión

1. **La pantalla lo explica** en el bloque de cookies: *«Por qué un archivo y no usuario/contraseña: YouTube
   (Google) no permite que un programa inicie sesión con la contraseña; yt-dlp lo rechaza explícitamente. La
   sesión se le da con este .txt…»*.
2. **Hasta cuándo vale la sesión.** Se lee la fecha de caducidad de las cookies de sesión y se muestra:
   *«Sesión iniciada con estas cookies (válida hasta el 2026-11-12, quedan 6 días)»*, también en la cabecera del
   bloque: *«activas (48 de youtube.com, con sesión hasta 2026-11-12)»*.
3. **Aviso antes de que caduque.** Si a la sesión le quedan 3 días o menos, el panel lo dice en ámbar y pide
   volver a exportar las cookies — mejor enterarse ahí que cuando un canal se queda sin señal de madrugada.

## Si tu vídeo sigue sin verse

Con la sesión puesta, comprobar el enlace dirá el motivo exacto (v2.6.60). Los dos casos típicos:

| Motivo | Qué hacer |
| --- | --- |
| «restricción de edad» | La cuenta de esas cookies tiene que tener la **edad verificada** en YouTube. |
| «esa cuenta no tiene acceso» | Inicia sesión con **una cuenta que sí pueda ver el vídeo** en el navegador y exporta esas cookies. |
| «sólo para miembros» | La cuenta debe ser **miembro de ese canal**. |

Y si el vídeo no da pistas por PO token, **«Actualizar yt-dlp»**; si no da MP4 progresivo,
**«Descargar vídeo (una vez)»** (v2.6.59).

## Datos nuevos

- `GET /api/youtube/status` → `cookies.auth_expires_iso` (`YYYY-MM-DD`) y `cookies.auth_days_left`.
- `inspectCookiesText` devuelve `warn` cuando quedan ≤ 3 días.

## Pruebas

- `test_youtube_live.mjs`: **192 OK** (fecha de caducidad legible, días restantes y aviso de «caduca pronto»).
- `test_youtube_live_ui.mjs`: **121 OK** (la línea «válida hasta el …» y la explicación de por qué no hay
  usuario/contraseña).

## Actualizar

```bash
sudo tvlister-admin update
```
