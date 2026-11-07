# TVLister 24/7 — v2.6.20

**El disco de Jellyfin se monta desde el panel (NFS o SMB) y «Create Symlink» pasa a ser real.**
Cuando Jellyfin está en otra máquina el panel no ve los archivos: no hay nada que enlazar. Ahora el
panel monta el recurso compartido en el servidor, los enlaces apuntan al archivo del montaje y el
vídeo sale del disco — Jellyfin no interviene en la reproducción.

## Qué se añadió

### Montaje del disco desde el panel

En el modal de Jellyfin hay un bloque nuevo, **«Disco de Jellyfin en este servidor (NFS / SMB)»**:

- **Protocolo** NFS o SMB, **host** y **carpeta exportada / recurso**.
- Para SMB, **usuario** y **contraseña**.
- **Probar sin dejar nada**: monta en una carpeta temporal, cuenta los vídeos y lo desmonta. Si ahí ya
  salen los vídeos, la ruta y las credenciales son buenas.
- **Montar y usar Create Symlink**: montaje definitivo, línea en `/etc/fstab`, y **detección
  automática** de la equivalencia de rutas que devuelve Jellyfin (`/data` → `/mnt/jellyfin-…`).
- **Desmontar** y **Volver a montar**.

El estado se ve en el mismo bloque: origen, punto de montaje, número de vídeos, si está en
`/etc/fstab` y un archivo de ejemplo.

### Montaje desde la terminal

```bash
sudo tvlister-admin jellyfin mount                                   # estado
sudo tvlister-admin jellyfin mount nfs 192.168.1.50 /srv/media
sudo tvlister-admin jellyfin mount smb 192.168.1.50 Media usuario -  # «-» pide la clave sin eco
sudo tvlister-admin jellyfin mount test nfs 192.168.1.50 /srv/media
sudo tvlister-admin jellyfin mount umount | remount
```

Al montar, la consola detecta la equivalencia de rutas y la guarda; después
`sudo tvlister-admin jellyfin import` crea los enlaces.

### Pensado para producción

| Detalle | Cómo queda |
| --- | --- |
| Punto de montaje | `/mnt/jellyfin-<host>` (o el que se indique) |
| Opciones NFS | `ro,hard,_netdev,nofail,nosuid,nodev,noexec` (+`vers=` opcional) |
| Opciones SMB | `ro,_netdev,nofail,nosuid,nodev,noexec,iocharset=utf8,credentials=…` |
| `/etc/fstab` | **una sola línea**, terminada en `# tvlister:jellyfin`; copia del original en `/etc/fstab.tvlister-bak` |
| Resto de `/etc/fstab` | intacto: comentarios, UUID y swap se conservan tal cual |
| Credenciales SMB | `/etc/tvlister-cifs-<host>.cred` con permisos **600**; nunca en `fstab` ni en la base de datos |
| Persistencia | el montaje sobrevive al reinicio (`fstab` + `nofail`: si el NAS no está, el servidor arranca igual) y **desmontar quita la línea** |
| Si falta el cliente | se muestra el comando exacto (`sudo apt install -y nfs-common` / `cifs-utils`); el panel **no** instala nada solo |
| Sin root | el panel avisa y el montaje se hace con `sudo tvlister-admin jellyfin mount …` |

### API

`GET/POST/DELETE /api/jellyfin/mount`, `POST /api/jellyfin/mount/test`,
`POST /api/jellyfin/mount/remount` y `GET /api/jellyfin/mount/capabilities`.

## Comprobado ejecutando el panel (Jellyfin en otra máquina + montaje NFS/SMB)

| Caso | Resultado |
| --- | --- |
| Vista previa **antes** de montar | `accesibles: 0`, `no accesibles: 2`, `remoteServer: true` |
| Probar NFS desde el panel | `ok`, **2 vídeos**, se desmontó y no dejó nada |
| Montar NFS | `/mnt/jellyfin-192.168.1.50`, **2 vídeos**, legible |
| Línea de `/etc/fstab` | `192.168.1.50:/srv/media /mnt/jellyfin-192.168.1.50 nfs ro,hard,_netdev,nofail,nosuid,nodev,noexec 0 0 # tvlister:jellyfin` |
| Equivalencia detectada | `/data => /mnt/jellyfin-192.168.1.50`, **2/2 archivos resueltos** |
| Vista previa **después** de montar | `accesibles: 2`, `no accesibles: 0`, `remoteServer: false` |
| Import con «Create Symlink» | 1 película + 1 serie + 1 episodio, **2 enlaces**, `relayed: 0` |
| Enlaces creados | `vod/movies/Pelicula NFS (2022).mkv -> /mnt/jellyfin-192.168.1.50/peliculas/…` |
| Reproducción `/movie/usuario/clave/1.mkv` | `206`, `Content-Range: bytes 1000-2999/120000`, **bytes idénticos** al archivo montado |
| Montaje SMB | `//192.168.1.60/Media`, credenciales en archivo **600** (`-rw-------`) |
| Desmontar | desmontado, línea de `fstab` quitada, configuración borrada; la vista previa vuelve al relé (`remoteServer: true`) |
| `fstab` tras desmontar | igual que antes de montar (UUID, comentarios y swap intactos) |

## Sin cambios

Salida UDP/CATV, Flussonic, registro de aparatos, límite por equipos, VOD local, el relé
`jellyfin://` de v2.6.19 y el contrato de las apps Xtream/M3U.

## Guía

[`docs/JELLYFIN_VOD.md`](JELLYFIN_VOD.md) — sección **3b**.

## Instalación / actualización

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.20/install.sh \
  | sudo bash -s -- --tag v2.6.20 --port 8095
```
