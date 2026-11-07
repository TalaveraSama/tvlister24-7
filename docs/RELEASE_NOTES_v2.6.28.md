# v2.6.28 — «Falta la API Key de TMDB» aunque la clave esté puesta

Publicada el 2 de noviembre de 2026. Sobre la v2.6.27 (categoría maestra `Movies`).

## Qué pediste

> «tengo este error en vod y ya tengo el tmdb puesto con su key»

En *Películas → Sincronizar Carpeta → Separar el catálogo por género de TMDB* salían a la vez el aviso
ámbar **«Falta la API Key de TMDB»** y el error rojo *«Configura primero tu API Key de TMDB
(themoviedb.org) para separar el catálogo por género»*, con los botones **Vista Previa** y **Aplicar**
desactivados, aunque la clave ya estuviera guardada.

## Qué pasaba

No era la clave: era la pantalla perdiendo el dato.

1. **Al guardar las reglas** (`Guardar Reglas`) el panel llamaba a `POST /api/vod/genres/config`, y esa
   respuesta traía **sólo** las reglas (`aliasesText`, `priorityText`…). La pantalla reemplazaba su
   estado completo con esa respuesta, así que **borraba el `tmdb.configured`** que había leído al
   abrir. Desde ese momento la tarjeta creía que no había API Key y bloqueaba los dos botones.
2. **Al guardar la clave** en el modal *Configurar TMDB*, la tarjeta de géneros no se enteraba: su
   estado se cargaba una sola vez al abrir la pantalla. Había que recargar con F5 para que
   desapareciera el aviso.
3. El mensaje rojo de un intento anterior tampoco se borraba al configurar la clave, así que quedaban
   los dos avisos a la vez.

## Lo que cambia

| Antes | Ahora (v2.6.28) |
| --- | --- |
| `POST /api/vod/genres/config` devolvía sólo las reglas | Devuelve **lo mismo que el `GET`**: reglas + `categories` + `tmdb` |
| Guardar reglas borraba el estado de la clave y desactivaba «Vista Previa»/«Aplicar» | El estado se **fusiona**, nunca se reemplaza |
| Guardar o importar la clave no refrescaba la tarjeta | Se vuelve a pedir el estado y **el aviso desaparece sin recargar** |
| El error rojo viejo se quedaba pegado | Se limpia en cuanto la clave queda configurada |
| El aviso ámbar no decía de dónde sacar la clave | Añade: *«Si ya la tienes en XUI.one, entra en Configurar TMDB y usa Importar desde XUI.one»* |

No cambia nada del resto: ni las reglas, ni los alias, ni la clasificación por lotes, ni el
sincronizador de carpetas, ni la lista M3U, ni `/live/…`, ni el motor FFmpeg.

## Si el aviso sigue saliendo con la v2.6.28

Entonces sí falta la clave **en el panel** (no en XUI.one). En el modal *Configurar TMDB*:

- Si arriba a la derecha se ve **`Activa: xxxx••••••••yyyy`**, la clave está guardada y el aviso no
  debería salir.
- Si no se ve, pulsa **«Importar Clave desde XUI.one»** (lee `tmdb_api_key` de la tabla `settings` de
  XUI.one) o pega la clave: vale la **API Key (v3)** de 32 caracteres o el **Read Access Token (v4)**.
- «Guardar y Probar TMDB» consulta `api.themoviedb.org/configuration`: si el servidor no tiene salida a
  Internet, el guardado se queda hecho pero el botón avisará del fallo de conexión.

## Pruebas

| Prueba | Qué hace |
| --- | --- |
| `node scripts/test_vod_genre_tmdb_state.mjs` | Arranca el panel de verdad contra un TMDB de mentira: sin clave avisa y se niega; al guardar la clave el `GET` lo refleja; **el `POST` de reglas sigue trayendo `tmdb`**; la vista previa ya funciona |
| `node scripts/test_vod_genre_tmdb_ui.mjs` | Renderiza la pantalla (jsdom): guardar reglas con un servidor viejo **no** muestra el aviso, y guardar la clave en el modal lo quita sin recargar |

Las dos fallan con el código de la v2.6.27 y pasan con este. La de UI necesita `npm i -D jsdom` (si no
está, se omite y no falla).

## Instalar / actualizar

```bash
# Instalación nueva
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.28/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.28
```

En un panel ya instalado: `tvlister-admin update` o `tvlister-admin release v2.6.28`. Después recarga
la pantalla de Películas con Ctrl+F5 (el bundle cambia de nombre, pero el navegador puede tener el
anterior en caché).
