# Jellyfin → TVLister: catálogo de películas y series con «Create Symlink»

Esta integración copia a **XUI.one** únicamente su función **Create Symlink**: en lugar de mover o
copiar archivos de vídeo, el panel crea un **enlace simbólico** dentro de su carpeta VOD que apunta
al archivo original que ya está en el disco. Jellyfin sólo se usa como **catálogo** (títulos, años,
sinopsis, géneros, carátulas y episodios).

> No se copia, no se mueve y no se recodifica nada. Tampoco se borra nunca un archivo real: si algo
> se elimina, se elimina el enlace, no el original.

---

## 1. Requisitos

| Elemento | Detalle |
|---|---|
| Jellyfin | 10.8 o superior, con API HTTP accesible desde el servidor del panel |
| API Key | Panel de Jellyfin → **Administración → API Keys → +** (usuario administrador) |
| Disco | Los archivos de vídeo tienen que ser **legibles por el servidor del panel** (misma máquina o montaje NFS/SMB) |
| Carpeta VOD | Por defecto `/opt/tvlister24-7/vod` (`vod/movies` y `vod/series` se crean solas) |

Si Jellyfin está en **otra máquina** y el disco no está montado aquí, los archivos no se pueden
enlazar: el panel lo detecta y los marca como «no accesibles». Para ese caso existe la opción
*«Si el archivo no está en este servidor, usar la URL de Jellyfin»* (respaldo directo), que **no**
crea enlaces y sirve el vídeo desde Jellyfin.

---

## 2. Configurar desde el panel

1. **VOD y Series → botón «Jellyfin»** (arriba a la derecha, con un punto verde cuando ya está
   configurado).
2. Rellena **URL del servidor** (`http://192.168.1.20:8096`, sin barra final) y **API Key**.
3. Pulsa **«Probar y guardar»**. Debe responder con el nombre y la versión del servidor; si la clave
   es incorrecta Jellyfin devuelve HTTP 401 y el panel lo indica.
4. Revisa la **carpeta VOD donde se crean los symlinks**.
5. Si hace falta, añade el **mapa de rutas** (ver abajo).
6. Marca las **bibliotecas** que quieres importar.
7. Pulsa **«Ver qué hay»** para la previsualización y después **«Importar»**.

El punto del botón indica el estado: **verde** = configurado y con clave, **gris** = sin configurar.

### Mapa de rutas

Jellyfin devuelve la ruta tal como **él** la ve. Si el contenedor de Jellyfin monta el disco con otro
prefijo, se traduce con una línea por equivalencia:

```
/media/peliculas => /mnt/peliculas
/media/series    => /mnt/series
```

Si la ruta que devuelve Jellyfin ya existe en este servidor, el mapa se deja **vacío**.

### Cuando la vista previa dice «0 archivos accesibles»

Es el caso típico de **Jellyfin en Docker**: él ve `/Media/…` pero en el servidor ese contenido está
en `/home/xui/media`, `/mnt/disco2/…`, etc. La importación lo resuelve de tres formas, en este
orden:

1. **Equivalencia ya guardada** (mapa de rutas) — instantáneo.
2. **«Buscar la carpeta real»** (botón en la vista previa, o `POST /api/jellyfin/detect-paths`):
   prueba a sustituir el primer tramo de la ruta por las carpetas reales del servidor
   (`/media`, `/mnt`, `/srv`, `/opt`, `/home`, `/var/lib`, las carpetas de sincronización VOD del
   panel y la que escribas en *«Carpeta real de los vídeos»*). Si con eso no acierta, indexa los
   archivos de vídeo por nombre y busca cada título. Devuelve la equivalencia con cuántos archivos
   resuelve (`5/5 archivos`) y un botón **«Aplicar y guardar»**.
3. **«Detectar la carpeta real sola»** (casilla marcada por defecto): al pulsar **Importar**, el
   panel hace esa detección, guarda la equivalencia y luego importa. Así no hay que saber nada de
   rutas.

Lo que no se pueda resolver por prefijo se busca **por nombre de archivo** en un índice que el
panel guarda al detectar (`jellyfin_file_index`), útil cuando el mismo prefijo de Jellyfin tiene el
contenido repartido en dos discos.

Si los archivos **existen pero no se pueden leer** (permisos), la vista previa lo dice aparte
(`sin permiso`) y no se crean enlaces: se arregla con
`sudo chown -R tvlister:tvlister CARPETA` (o el usuario con el que corre el servicio).

Las bibliotecas de tipo **lista de reproducción, música o fotos se omiten**: contienen las mismas
películas con otro identificador y duplicarían el catálogo.

### Opciones de importación

| Opción | Qué hace |
|---|---|
| **Create Symlink** (activado por defecto) | Crea el enlace en la carpeta VOD y lo usa como `source_url`. Es lo que hace XUI.one con las películas |
| Crear una categoría por biblioteca | Crea categorías `Jellyfin · <biblioteca>` |
| Completar carátulas con TMDB | Sólo rellena las que falten (requiere TMDB configurado) |
| Usar la URL de Jellyfin si el archivo no está aquí | Respaldo directo por HTTP, sin enlace |
| Películas y series / Sólo películas / Sólo series | Filtro de contenido |

---

## 3. Qué se crea exactamente

Nombres de archivo, iguales para la importación y para el enlace individual:

| Tipo | Enlace | Ejemplo |
|---|---|---|
| Película | `<Carpeta VOD>/movies/<Título> (<año>)<ext>` | `vod/movies/Matrix (1999).mkv` |
| Episodio | `<Carpeta VOD>/series/<Serie> - S01E02<ext>` | `vod/series/Breaking Bad - S01E01.mkv` |

El nombre se limpia (se quitan `/ \ : * ? " < > |`) y, si ya existe un enlace distinto con ese
nombre, se prueban sufijos (`… - 2`, `… - 3`). Si el enlace existente **ya apunta al mismo archivo**,
se reutiliza: importar dos veces no duplica nada.

En la base de datos:

- `vod_items.source_provider = 'jellyfin'` y `external_id` = Id del elemento en Jellyfin (clave de la
  importación idempotente).
- `vod_items.symlink_path` / `series_episodes.symlink_path` = ruta del enlace creado.
- `series.external_id` = Id de la serie en Jellyfin.
- Las carátulas se descargan a `data/jellyfin_images/` y se sirven firmadas por
  `/vod_local_poster?p=…&sig=…` (nunca se expone la ruta real).
- Los elementos nuevos se enganchan al **primer bouquet** del panel, igual que la sincronización de
  carpetas.

Contadores de la importación: `moviesAdded`, `moviesExisting`, `seriesAdded`, `seriesExisting`,
`episodesAdded`, `episodesExisting`, `symlinks`, `directUrls`, `skippedNoFile`, `images`,
`tmdbEnriched`, `errors`.

---

## 3b. Jellyfin en **otro** servidor

Si Jellyfin no está en la misma máquina que el panel (o su disco no está montado aquí), **no se
puede crear un enlace**: no hay archivo local al que apuntar. Hay dos caminos:

### A) Servir desde Jellyfin (recomendado si no quieres montar discos)

1. En el modal, marca **«Servir desde Jellyfin»** (o pulsa el botón que aparece cuando la vista
   previa detecta que estás en otro servidor).
2. Pulsa **Importar**.

Qué hace el panel:

- Guarda la fuente como `jellyfin://<Id>` — **nunca** la URL con la API Key.
- Cuando un cliente pide `/movie/usuario/clave/1`, el panel pide el archivo a Jellyfin con
  `static=true`, **reenvía el `Range`** y devuelve `206 Partial Content`, igual que con un archivo en
  disco. El *seek* y el currículum de la reproducción funcionan.
- La **API Key no sale nunca** al reproductor (ni en la URL ni en cabeceras) y Jellyfin no tiene por
  qué ser accesible desde Internet: sólo desde el panel.
- El panel hace de intermediario: **todo el tráfico de vídeo pasa por él** (cuenta ancho de banda del
  VPS y consume conexiones de Jellyfin según su propio límite).

### B) Montar el disco de Jellyfin aquí (para usar «Create Symlink» de verdad)

El panel monta el recurso compartido en **este** servidor (NFS o SMB) y deja el enlace apuntando al
archivo real del montaje. No hay retransmisión: el vídeo sale del disco, no de Jellyfin.

#### Paso 1 — en el servidor de Jellyfin: compartir la carpeta

El panel no puede montar algo que el otro servidor no comparte. Esto se hace **en la máquina donde
está el disco** (el ejemplo usa `/mnt/Storage1/movie`), como root. Cambia `192.168.1.77` por la IP
del panel: la ves en el propio bloque del panel, que genera estos comandos ya rellenados
(«¿El otro servidor todavía no comparte la carpeta?») y en `tvlister-admin jellyfin mount share`.

**NFS (Linux / NAS con NFS)**

```bash
sudo apt install -y nfs-kernel-server
sudo mkdir -p /mnt/Storage1/movie
echo '/mnt/Storage1/movie 192.168.1.77(ro,sync,no_subtree_check)' | sudo tee -a /etc/exports
sudo exportfs -ra
sudo systemctl enable --now nfs-kernel-server

# Sólo si hay firewall:
sudo ufw allow from 192.168.1.77 to any port 2049 proto tcp
sudo ufw allow from 192.168.1.77 to any port 111 proto tcp
```

Se exporta en **sólo lectura** (`ro`): el panel únicamente lee los vídeos. Si quieres autorizar toda
la red interna en vez de una IP, usa `192.168.1.0/24`.

**SMB / Samba (Windows o NAS)**

```bash
sudo apt install -y samba
sudo mkdir -p /mnt/Storage1/movie
sudo tee -a /etc/samba/smb.conf > /dev/null <<'CONF'
[jellyfin]
   path = /mnt/Storage1/movie
   read only = yes
   browseable = yes
   valid users = tvlister
CONF
sudo smbpasswd -a tvlister        # define la contraseña del usuario
sudo systemctl reload smbd
sudo ufw allow from 192.168.1.77 to any port 445 proto tcp   # sólo si hay firewall
```

**Comprobar antes de montar** (desde el panel):

```bash
sudo tvlister-admin jellyfin mount exports 192.168.1.50   # showmount -e
# o el botón «Ver carpetas compartidas» del modal
```

Debe listar la carpeta (`/mnt/Storage1/movie`). Si no aparece, el export no está activo en el otro
servidor o el firewall está cortando los puertos `111`/`2049`.

> **Jellyfin en Docker:** comparte la ruta del **host** (`/mnt/Storage1/movie`). Dentro del
> contenedor Jellyfin puede verla como `/data/...`; al montar, el panel detecta esa equivalencia y la
> guarda sola.

#### Paso 2 — desde el panel

1. Modal **Jellyfin** → bloque **«Disco de Jellyfin en este servidor (NFS / SMB)»**.
2. Elige el protocolo y escribe el host y la carpeta:
   - **NFS**: host `192.168.1.50` + carpeta exportada `/srv/media`.
   - **SMB**: host `192.168.1.50` + recurso `Media` + usuario y contraseña.
3. **Probar sin dejar nada** monta el recurso en una carpeta temporal, cuenta los vídeos y lo
   desmonta. Si ahí ya salen los vídeos, el usuario/clave/ruta son correctos.
4. **Montar y usar Create Symlink** hace el montaje definitivo en `/mnt/jellyfin-<host>` (o el punto
   que escribas), lo deja en `/etc/fstab` y **detecta solo la equivalencia de rutas** que devuelve
   Jellyfin (`/data` → carpeta montada). Después, importa con **Create Symlink** marcado.

El estado queda a la vista: origen, punto de montaje, número de vídeos, si está en `/etc/fstab` y un
ejemplo de archivo. **Desmontar** lo desmonta, quita su línea de `/etc/fstab` y borra las
credenciales, así que no vuelve a montarse al reiniciar.

#### Paso 3 — desde la terminal

```bash
# Estado del disco montado (origen, punto, vídeos, fstab)
sudo tvlister-admin jellyfin mount

# NFS: host y carpeta exportada (punto de montaje opcional)
sudo tvlister-admin jellyfin mount nfs 192.168.1.50 /srv/media

# SMB: host, recurso, usuario y clave; con «-» la clave se pide por teclado
sudo tvlister-admin jellyfin mount smb 192.168.1.50 Media usuario -

# Probar sin dejar nada / desmontar / volver a montar
sudo tvlister-admin jellyfin mount test nfs 192.168.1.50 /srv/media
sudo tvlister-admin jellyfin mount umount
sudo tvlister-admin jellyfin mount remount

# Qué comparte el otro servidor (showmount -e) y cómo compartirlo
sudo tvlister-admin jellyfin mount exports 192.168.1.50
sudo tvlister-admin jellyfin mount share nfs /mnt/Storage1/movie   # comandos para el otro servidor
```

Al montar, la consola busca la equivalencia de rutas y la guarda; luego
`sudo tvlister-admin jellyfin import` crea los enlaces directamente.

#### Qué deja en el sistema

| Elemento | Valor |
| --- | --- |
| Punto de montaje | `/mnt/jellyfin-<host>` (o el que indiques) |
| Opciones NFS | `ro,hard,_netdev,nofail,nosuid,nodev,noexec` (+`vers=` si lo indicas) |
| Opciones SMB | `ro,_netdev,nofail,nosuid,nodev,noexec,iocharset=utf8,credentials=…` |
| `/etc/fstab` | una línea terminada en `# tvlister:jellyfin` (copia del original en `fstab.tvlister-bak`); `nofail` evita que el servidor se quede sin arrancar si el NAS no responde |
| Credenciales SMB | `/etc/tvlister-cifs-<host>.cred` con permisos **600** |

La contraseña de SMB **no** se guarda en `/etc/fstab` ni en la base de datos del panel.

#### Requisitos

- El panel debe correr como **root** (es el caso del servicio systemd). Si no, el panel lo avisa y el
  montaje se hace con `sudo tvlister-admin jellyfin mount …`.
- Clientes del sistema: `nfs-common` (NFS) o `cifs-utils` (SMB). Si faltan, el panel muestra el
  comando exacto (`sudo apt install -y cifs-utils`) — no instala nada por su cuenta.
- El servidor de archivos debe exportar/compartir la carpeta con permiso de lectura para el host del
  panel.

Si prefieres montarlo a mano, sigue siendo válido: monta donde quieras y escribe la equivalencia en
el campo de rutas (`/Media => /mnt/jellyfin`). Lo que aporta el panel es que monta, guarda la línea
de `fstab`, deduce la equivalencia y limpia todo al desmontar.

### Qué opción elegir

| | Servir desde Jellyfin | Montar el disco + Create Symlink |
| --- | --- | --- |
| Coste de CPU del panel | mínimo (sólo copia bytes) | mínimo |
| Ancho de banda del panel | **todo el vídeo pasa por él** | ninguno |
| Requiere montar nada | no | sí (NFS/SMB, se hace desde el panel) |
| Enlaces en la carpeta VOD | no | sí (como XUI.one) |
| Si Jellyfin se cae | el VOD deja de verse | sigue viéndose (archivo directo) |

---

## 4. Reproducción

El reproductor y las apps Xtream no cambian: `source_url` es la ruta del enlace dentro del servidor y
la reproducción pasa por las rutas ya existentes.

```bash
# Película (Xtream/VOD): 206 Partial Content sobre el archivo completo
curl -r 0-99 -D- "http://IP:8080/movie/USUARIO/CLAVE/1"

# Episodio
curl -r 0-49 -D- "http://IP:8080/series/USUARIO/CLAVE/1.mkv"
```

Se responde `Accept-Ranges: bytes` y `Content-Range: bytes 0-99/400000`, es decir, se hace *seek*
sobre el archivo real a través del enlace (no se copia a temporal).

---

## 5. Mantenimiento

### Desde el panel

- **Enlace individual** en la tarjeta de una película cuyo `source_url` es una ruta local y que aún no
  tiene `symlink_path` (icono de cadena).
- **Estado de enlaces**: `GET /api/vod/symlinks/status` devuelve carpeta, número de enlaces, enlaces
  rotos y espacio libre.
- Al **borrar** una película, un episodio o una serie completa, el panel borra también sus enlaces
  (`symlink_removed: true`). El archivo original no se toca.

### Desde la terminal

```bash
tvlister-admin jellyfin status      # configuración, bibliotecas, enlaces y rotos
tvlister-admin jellyfin test        # conexión + bibliotecas disponibles
tvlister-admin jellyfin import      # importa todas las bibliotecas configuradas
tvlister-admin jellyfin import lib-movies,lib-tv
tvlister-admin jellyfin symlinks    # rehace todos los enlaces (tras mover la carpeta)
tvlister-admin jellyfin mount       # estado del disco montado (NFS/SMB)
```

---

## 6. Rutas de la API del panel

Todas requieren sesión de administrador.

| Método y ruta | Uso |
|---|---|
| `GET /api/jellyfin/config` | Configuración actual (clave enmascarada) |
| `POST /api/jellyfin/config` | Guarda URL, clave, carpeta, mapa y respaldo directo. `testConnection: true` prueba la conexión |
| `POST /api/jellyfin/test` | Prueba la conexión y devuelve nombre/versión |
| `GET /api/jellyfin/libraries` | Bibliotecas con su `collectionType` y las seleccionadas |
| `POST /api/jellyfin/preview` | `{libraryIds, contentMode}` → cuántas películas/series/episodios, cuántos archivos son accesibles, por qué no lo son (`missing`/`forbidden`) y los prefijos sin ubicar |
| `POST /api/jellyfin/detect-paths` | `{libraryIds, extraRoots[], apply, maxSeconds}` → equivalencias encontradas con cuántos archivos resuelve cada una |
| `POST /api/jellyfin/import` | `{libraryIds, contentMode, createSymlink, symlinkDir, useLibraryAsCategory, autoTmdb, directFallback, fetchImages, autoDetectPaths, searchRoots[]}` |
| `POST /api/vod/:id/symlink` | Crea el enlace de una película ya existente |
| `POST /api/series/episodes/:epId/symlink` | Crea el enlace de un episodio |
| `GET /api/vod/symlinks/status` | Estado de la carpeta y enlaces rotos |
| `POST /api/vod/symlinks/rebuild` | Rehace todos los enlaces (`{dryRun:true}` para simular) |
| `GET /api/jellyfin/mount` | Estado del disco montado: `mounted`, `readable`, vídeos, si está en `fstab` y capacidades del sistema |
| `GET /api/jellyfin/mount/capabilities` | Si hay `mount.nfs`/`mount.cifs`, si corre como root y el comando de instalación que falta |
| `POST /api/jellyfin/mount/exports` | `{host}` → carpetas que ese servidor comparte por NFS (`showmount -e`) |
| `GET /api/jellyfin/mount/share` | `?protocol=nfs\|smb&path=/mnt/Storage1/movie&address=IP` → comandos para compartir la carpeta en el servidor de Jellyfin |
| `POST /api/jellyfin/mount/test` | `{protocol, host, remotePath, user, password}` → monta en temporal, cuenta vídeos y desmonta |
| `POST /api/jellyfin/mount` | Monta, deja la línea de `fstab`, guarda la configuración y detecta la equivalencia de rutas (`autoDetect:false` para no detectar) |
| `POST /api/jellyfin/mount/remount` | Vuelve a montar con la configuración guardada (NAS reiniciado) |
| `DELETE /api/jellyfin/mount` | Desmonta, quita su línea de `fstab` y borra las credenciales |

La API de Jellyfin que se usa: `/System/Info`, `/Library/MediaFolders`,
`/Items?ParentId=&Recursive=true&IncludeItemTypes=Movie|Series`, `/Shows/{id}/Episodes` y
`/Items/{id}/Images/{Primary|Backdrop}`. Autenticación por cabecera `X-Emby-Token` (también se
acepta `Authorization: MediaBrowser Token="…"`).

---

## 7. Problemas típicos

| Síntoma | Causa y solución |
|---|---|
| «Jellyfin rechazó la API Key (HTTP 401)» | Clave mal copiada o revocada: crear una nueva en Jellyfin |
| Todos los archivos «no accesibles» y Jellyfin está en otra máquina | Monta su disco desde el bloque **NFS / SMB** del modal (ver 3b) o marca **«Servir desde Jellyfin»** y vuelve a importar |
| Un vídeo da 502 al reproducir | El panel no alcanza Jellyfin en ese momento: comprueba `curl http://IP_JELLYFIN:8096/System/Info` desde el servidor del panel |
| «No se pudo conectar con Jellyfin» | URL, puerto (8096) o firewall; probar con `curl http://IP:8096/System/Info` |
| Vista previa con muchos «no accesibles» | Jellyfin usa otra ruta (Docker): pulsa **«Buscar la carpeta real»** o escribe la carpeta en *«Carpeta real de los vídeos»* |
| «sin permiso» en la vista previa | El panel no puede leer los archivos: `chown`/`chmod` con el usuario del servicio |
| `skippedNoFile` sube y no importa | Igual que arriba; o los archivos son de otra máquina (activar respaldo directo) |
| Un título no aparece en el panel | Ya estaba importado (se cuenta en `moviesExisting`), o su biblioteca no estaba marcada |
| El vídeo no arranca pero el título está | El archivo original se movió o se borró: el enlace queda roto. `jellyfin symlinks` lo informa |
| Se ve carátula rota | La imagen se descargó mal en su momento: borrar el registro de `data/jellyfin_images` y reimportar la carátula con TMDB |

---

## 8. Lo que esta integración **no** hace

- No copia ni mueve archivos de vídeo (eso es el «Create Symlink» de XUI.one, nada más).
- No transcodifica ni remuxea.
- No borra los originales al eliminar una película del panel.
- No sincroniza cambios posteriores sin volver a pulsar **Importar** (la importación es idempotente:
  lo que ya existe no se duplica).
