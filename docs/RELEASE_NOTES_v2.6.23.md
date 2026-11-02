# TVLister 24/7 — v2.6.23

**El aviso «tu cuenta ya está en uso en otro aparato» deja de salir con la línea vacía.** El cupo lo
llenan ahora **sólo las conexiones que están reproduciendo de verdad**; los aparatos ya registrados
(el televisor apagado, el móvil que se conectó la semana pasada) **no ocupan hueco** y no bloquean a
nadie. El rechazo aparece únicamente cuando la línea tiene agotadas sus `max_connections` conexiones
activas, que es lo que se pidió: *«hasta que llene las conexiones activas tiene que salir»*.

## La causa

El corte **no** venía de las conexiones: venía del registro de aparatos por MAC. En modo *bloquear*,
`resolveDeviceForLine` comparaba los **equipos apuntados** (`line_devices` activos) con el cupo y
rechazaba al siguiente equipo con `403`. Resultado: una línea de 2 conexiones con dos reproductores
apuntados y **nadie viendo nada** dejaba fuera al tercer aparato, y la app mostraba «Tu cuenta ya
está en uso en otro aparato. Contacta con soporte.» con la lista de reproducciones vacía.

Además había dos fuentes de «fantasmas» que llenaban el cupo solas:

- Las conexiones **MPEG-TS** tardaban **15 minutos** en caducar (las HLS 90 s): un televisor
  apagado seguía contando como conexión activa un cuarto de hora.
- Al reiniciar el panel, las filas de `active_connections` del proceso anterior **sobrevivían** en
  la base de datos.

Y `action=register_device` contestaba `active_cons` con el **número de aparatos apuntados**, un dato
que muchas apps comparan con `max_connections`: con dos aparatos guardados, la app pintaba «cuenta
en uso» aunque no hubiera nadie reproduciendo.

## Qué cambió

| Pieza | Antes | Ahora |
| --- | --- | --- |
| Puerta del registro de aparatos | `aparatos activos >= cupo` | `conexiones vivas >= max_connections` |
| Qué cuenta como conexión | fila en `active_connections` (MPEG-TS 15 min) | fila con latido en los **últimos 120 s**, cualquier protocolo |
| Rechazo | `device_limit` | `connection_limit`, con el número real: «admite N conexión(es) y ahora mismo están todas en uso (N)» |
| `active_cons` en `player_api.php` | filas totales de la línea | **conexiones vivas** |
| `active_cons` en `register_device` | aparatos apuntados | **conexiones vivas** |
| Almacenamiento en caché del rechazo | 60 s | **5 s** (en cuanto se libera una conexión, el cliente puede entrar) |
| Al arrancar el panel | — | se vacían las conexiones huérfanas del proceso anterior |
| Panel → *aparatos* de la línea | «N aparato(s) de M permitido(s)» | además «**N de M conexión(es) en uso**», en verde o en rojo, refrescándose sola cada 10 s |
| `tvlister-admin devices` | «Activos ahora» (aparatos) | «**Conexiones en uso** (es lo que corta al entrar)» |

Los aparatos se siguen registrando y se siguen viendo en el panel: lo único que cambia es que
**tener aparatos apuntados no consume cupo**. Un aparato nuevo entra, se apunta y reproduce mientras
haya una conexión libre.

Nota: existe un cupo propio por línea (`device_limit`), pero ya **no** corta al entrar; sólo se usa
para mostrar el cupo en el panel. Lo que corta es `max_connections` sobre conexiones vivas.

## Comprobado ejecutando el panel real (base de datos limpia, modo *bloquear*)

Con una línea `ruben` / `max_connections = 2`, y **cero reproducciones**:

| Caso | Antes (v2.6.22) | Ahora (v2.6.23) |
| --- | --- | --- |
| 1.ª app (IPTV Smarters) | `auth:1` | `auth:1`, `active_cons:0` |
| 2.ª app (XCIPTV) | `auth:1` | `auth:1`, `active_cons:0` |
| 3.ª app (TiviMate) | **`auth:0` «ya hay 2 registrados»** | **`auth:1`**, se registra |
| 4.ª app (GSE) / Kodi / OTT Navigator | `auth:0` | `auth:1` |
| 20 aparatos distintos seguidos | cortaba en el 3.º | **20 de 20 entran** |
| `register_device` con 2 aparatos guardados | `active_cons:2` (parecía lleno) | `registered:true`, `active_cons:0` |

Con **2 conexiones vivas** (dos reproductores abiertos):

| Caso | Resultado |
| --- | --- |
| Aparato nuevo (Kodi) | `auth:0` «Esta línea admite 2 conexión(es) y ahora mismo están todas en uso (2). Cierra la reproducción en otro aparato o espera a que se libere una.» |
| Aparato ya registrado (Smarters) | `auth:1`, `active_cons:2` |
| Se libera una conexión y el aparato nuevo reintenta | tras 5 s entra (`auth:1`, `register_device` con token) |

Ciclo de vida real de una conexión (canal servido desde disco, cliente cortado a mitad):

| Momento | Base de datos | Panel |
| --- | --- | --- |
| Reproduciendo | 1 fila con latido | «**1 de 5** conexión(es) en uso» |
| Cliente cerrado | 0 filas | «0 de 5» |

Filas viejas: una conexión con `last_ping_at` de hace 30 minutos **no** cuenta (`conexiones vivas: 0`)
y una petición nueva entra. Mensajes viejos de HLS y MPEG-TS se borran al pasar de 2 minutos. Al
arrancar el panel con filas heredadas, el log dice `[TVLister] N conexión(es) fantasma liberadas al
arrancar` y la tabla queda vacía.

## Nada más se toca

- La lista M3U, `/live/:usuario/:clave/…`, `/player_api.php`, MAG/Stalker y las apps Xtream siguen
  igual: el modo por defecto del registro sigue siendo **sólo registrar** y el corte necesita
  `enforce`.
- No se toca FFmpeg, ni UDP/CATV, ni Flussonic, ni ningún stream.
