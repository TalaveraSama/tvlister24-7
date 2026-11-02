# TVLister 24/7 — v2.6.13 «El troncal no se toca»

Tu Flussonic `69.30.212.194:2086` no es solo tu origen: **también alimenta a otro panel Flussonic de
otro cliente**. Ese servidor no usará DRM, y el panel tenía que saberlo para no escribirle nada.

## 1. El destino del DRM ya no es «el principal» a ciegas

Antes, `drm push-all` y el botón *Aplicar a Flussonic* escribían en el nodo marcado como principal
(`is_main`) — que puede ser justo el troncal. Ahora el destino se resuelve así:

1. el servidor que indiques a mano;
2. **el servidor del propio canal** (`streams.flussonic_server_id`);
3. el único Flussonic registrado, o el único que emite (no troncal);
4. si hay varios sin asignar: **error explicado**, no se adivina.

## 2. Rol TRONCAL (solo origen)

Nueva columna `origin_only` en `flussonic_servers` (y en `servers` por compatibilidad).

| Antes | Ahora |
| --- | --- |
| Nada impedía enviar `drm` al troncal y cifrar de paso la salida del otro cliente | El envío se **niega** con un mensaje claro (HTTP 409 `ORIGIN_ONLY`) |
| `protect-all` miraba solo CATV y FFmpeg | Además **excluye del plan** los canales que viven en el troncal, con el motivo escrito |
| Solo se podía cambiar por SQL | UI (`Marcar como troncal`, etiqueta `TRONCAL`) y CLI: `drm troncal <id> [off]` |

El bloqueo es **de escritura**: el troncal sigue alimentando tu panel con total normalidad.

## 3. Comandos nuevos

```bash
sudo tvlister-admin drm servers        # id, rol (TRONCAL/emisor) y canales asignados
sudo tvlister-admin drm troncal 1      # marcar como troncal
sudo tvlister-admin drm troncal 1 off  # volver a emisor
```

`drm push-all` ahora imprime el servidor de destino de cada canal y, al final, cuántos se quedaron
sin enviar por apuntar al troncal.

## Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| Columna nueva en `flussonic_servers` y `servers` | creadas al iniciar (BD existente) |
| Resolver con 2 servidores, canal asignado al emisor | elige el emisor (`el del canal`) |
| Canal asignado al troncal | rechazo `ORIGIN_ONLY` **antes** de abrir conexión |
| Forzar `serverId` del troncal | rechazo `ORIGIN_ONLY` |
| Varios Flussonic y canal sin asignar | error pidiendo asignarlo (no adivina) |
| `protect-all` con troncal marcado | el canal del troncal sale del plan con su motivo |
| `drm servers` / `drm troncal 1` / `drm troncal 1 off` | rol y aviso de canales afectados correctos |
| `vite build`, `node --check`, `bash -n` | correctos |

## Instalación

```bash
sudo tvlister-admin update
sudo tvlister-admin drm servers        # mira los ids
sudo tvlister-admin drm troncal <id_del_69>   # el 69.30.212.194 es troncal
sudo tvlister-admin drm protect-all    # ahora el plan no incluye sus canales
```
