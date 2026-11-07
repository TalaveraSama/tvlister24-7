# v2.6.31 — «Dentro de Movies deben estar Acción, Comedia…»

Publicada el 2 de noviembre de 2026. Sobre la v2.6.30 (reparto de canales entre nodos).

## Qué pasó

> «no salen las categorías de la selección de TMDB, la comedia, acción. Después del reseteo que hicimos
> solo salen Movies. Dentro de Movies deben estar Acción, Comedia y así»

No era TMDB ni la clave: era cómo se elegían los títulos a clasificar.

La separación por género sólo miraba las filas **sin género guardado** (`tmdb_genres IS NULL`). Al pasar todo
el catálogo a la categoría maestra `Movies`, el género de cada título **siguió guardado en la base**, así que:

- la vista previa decía «0 revisadas» y
- «Aplicar a Películas y Series» respondía *«No queda ningún título pendiente»*

…y no creaba Acción, Comedia, Terror ni movía nada. Todo se quedaba en `Movies`.

## Qué cambia

| Antes | Ahora (v2.6.31) |
| --- | --- |
| Sólo se procesaban filas sin género guardado | También **las que ya tienen género pero están en otra categoría** (por ejemplo, todas las que la limpieza devolvió a `Movies`) |
| Esas filas nunca volvían a moverse | Se mueven a su categoría **sin volver a preguntar a TMDB**: el género ya estaba guardado |
| El resumen decía «N con género» | Añade **«N ya tenían el género guardado»**, para que se vea que sí está trabajando |
| Al borrar categorías no se avisaba de nada | El mensaje y `tvlister-admin vod-cats clean` avisan de que las categorías de género se reconstruyen pulsando **Aplicar** |
| Un título con `tmdb_genres = '[]'` se reintentaba en cada lote | Se respeta: no se repite la consulta (salvo con `refresh`) |

Lo que **no** cambia: el género principal sigue mandando (una película de «Ciencia ficción, Acción» va a
Ciencia ficción), tu lista de prioridad y tus alias se respetan igual, y las categorías no se duplican.

**Importante:** un título va a **una** categoría (su género principal). No aparece en varias a la vez, igual
que en XUI.one. Si quieres que una comedia romántica vaya a «Románticas», ponlo en la prioridad del cuadro
de la pantalla (ya lo tienes así).

## Cómo dejarlo listo en tu panel

1. *Películas → Sincronizar Carpeta → Separar el catálogo por género de TMDB*.
2. Pulsa **Vista Previa**: verás «N revisadas • N en su categoría de género • N ya tenían el género guardado».
3. Pulsa **Aplicar a Películas y Series**. En unos segundos aparecen **Acción, Comedia, Drama, Terror…** y
   los títulos salen de `Movies`.
4. Si algún título se queda en `Movies`, es porque TMDB no le conoce género (p. ej. un nombre de archivo
   raro). El mensaje lo dice: «N sin resultado en TMDB».

## Pruebas

| Prueba | Qué comprueba | Resultado |
| --- | --- | --- |
| `node scripts/test_vod_genre_reclassify.mjs` | Escenario exacto: todo en `Movies` con el género guardado. La vista previa ve 7 títulos, no crea nada; Aplicar crea Acción, Comedia, Ciencia ficción, Crimen, Animación y Thriller y vacía `Movies`; el segundo clic no hace nada; **un «reseteo» simulado se reconstruye sin gastar consultas de TMDB**; prioridad «Románticas» aplicada | **30 OK** |
| `node scripts/test_vod_genre_apply_api.mjs` | Lo mismo por HTTP contra el panel real (el botón que pulsas), incluyendo un título sin género guardado que se resuelve en TMDB | **21 OK** |
| `test_vod_genre_tmdb_ui.mjs` | Pantalla real: al pulsar **Aplicar** se ve «Separadas por género de TMDB: 7 películas», las categorías creadas y «5 ya tenían el género guardado» | **24 OK** |
| `test_vod_genres` / `test_vod_genre_tmdb_state` / VOD / balanceadores | Sin regresiones | todo OK |

Con el código de la v2.6.30 la primera prueba falla (sólo creaba «Thriller» y `Movies` se quedaba con todo):
es una regresión real, no una prueba acomodada.

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.31/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.31
```

En un panel ya instalado: `tvlister-admin update`, y luego **Ctrl+F5** en Películas. Después, Vista Previa →
Aplicar: es un solo clic, no hace falta volver a tocar TMDB.
