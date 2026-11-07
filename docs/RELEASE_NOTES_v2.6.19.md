# TVLister 24/7 — v2.6.19

**Jellyfin en otro servidor: el panel retransmite el vídeo.** Si Jellyfin no está en la misma máquina
que el panel no hay archivo local que enlazar, así que el «Create Symlink» no puede funcionar. Ahora
hay una segunda vía que sí: el panel pide el archivo a Jellyfin y lo sirve a las apps, sin exponer la
API Key.

## Qué se añadió

### Fuente `jellyfin://` con retransmisión por el panel
- Al importar con **«Servir desde Jellyfin»**, la fuente se guarda como `jellyfin://<Id>`; la URL con
  la API Key **no se guarda ni se envía al cliente**.
- `GET /movie/:usuario/:clave/:id` y `/series/...` piden el archivo a Jellyfin (`static=true`),
  **reenvían el `Range`** y devuelven `206 Partial Content`. El *seek* funciona igual que con un
  archivo en disco.
- Se respeta `HEAD`, el `Content-Type` correcto por extensión (`video/x-matroska`, `video/mp4`…) y el
  `416` cuando el rango no cabe.
- Sirve igual para el reproductor del panel (vista previa) y para el portal WebTV.
- Los enlaces antiguos que guardaban la URL completa con `api_key` se siguen sirviendo, ahora también
  por el relé: la clave deja de salir al cliente.

### El panel lo detecta y lo propone
- La vista previa marca `remoteServer` cuando **nada** es accesible y no hay problemas de permisos, y
  ofrece el botón **«Servir desde Jellyfin»** (activa la opción y desactiva el enlace).
- Si «Create Symlink» está marcado pero el archivo no está, y «Servir desde Jellyfin» también, el
  panel **retransmite en vez de descartar** el título (contador `relayed`).
- Insignia **Remoto** en las tarjetas del VOD.
- Aviso al importar si no se importó nada por estar en otro servidor.

### Documentación
- Nueva sección **3b**: comparativa entre retransmitir y montar el disco por **NFS/SMB**, con los
  comandos exactos y el `chown`/`uid` del montaje.

## Comprobado ejecutando el panel (Jellyfin simulado en otra máquina)

| Caso | Resultado |
| --- | --- |
| Importar con «Servir desde Jellyfin» | 2 películas, `relayed: 2`, fuente `jellyfin://mv-…` |
| `Range: bytes=0-99` | `206`, `Content-Type: video/x-matroska`, `bytes 0-99/3000000` |
| `Range: bytes=1500000-1500099` (seek) | `206` y **bytes idénticos** al archivo original |
| Descarga completa de 58 MB | `200`, **sha256 idéntico** al original |
| `HEAD` | `200` con `Content-Length` y `Accept-Ranges` |
| Rango imposible | `416` reenviado de Jellyfin |
| Fuente antigua con `api_key` en la URL | servida por el relé y **la clave no aparece** en la respuesta |
| Vista previa del panel y `get_vod_info` | funcionan contra el relé |

## Sin cambios
Salida UDP/CATV, registro de aparatos, VOD local, Flussonic y el contrato de las apps Xtream/M3U.

## Guía
[`docs/JELLYFIN_VOD.md`](JELLYFIN_VOD.md) — sección 3b.

## Instalación / actualización
```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.19/install.sh \
  | sudo bash -s -- --tag v2.6.19 --port 8095
```
