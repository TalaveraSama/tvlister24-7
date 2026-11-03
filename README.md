# Panel TVLister 24/7 — Servidor IPTV / OTT / VOD (v2.3 Producción Total)

Plataforma auto-hospedada para la gestión profesional de **Canales en Vivo**, **Canales Lineales 24/7 (Playout Continuo)**, **Películas y Series VOD**, **Importación Nativa desde Base de Datos XUI.one**, **Blindaje Stream Shield Proxy (TS + HLS)**, **Líneas M3U / Xtream API / MAG Stalker / Enigma2**, **Módulo de Resellers con Créditos**, **Salida UDP/CATV para moduladores WK2500 (modelos de 32, 64 y 125 canales)** y **Portal Cliente WebTV HTML5**.

📖 **[Manual Completo del Panel, Guía de Uso y Tecnología (`docs/DOCUMENTACION_SISTEMA.md`)](docs/DOCUMENTACION_SISTEMA.md)**

🎬 **Jellyfin → VOD con «Create Symlink»**: el panel importa tu catálogo de Jellyfin (películas, otros VOD y series con episodios) y, como XUI.one, **crea enlaces simbólicos** a los archivos que ya tienes en el disco: no copia, no mueve y no recodifica nada. Botón *Jellyfin* en **VOD y Series**; en terminal: `tvlister-admin jellyfin`. Guía: **[`docs/JELLYFIN_VOD.md`](docs/JELLYFIN_VOD.md)**.

🔌 **El panel usa los puertos estándar: `80` y `443` (v2.6.25)**: se entra por `http://TU_IP` y por
`https://TU_IP`, sin escribir puerto; el 443 se abre solo en cuanto hay certificado (Let's Encrypt,
acme.sh o `tvlister-admin tls <cert> <clave>`) y el 80 sigue sirviendo el panel mientras se emite.
Una instalación anterior conserva su puerto y, en un servidor con XUI.one, el panel se queda en el
interno (`8095`) para no pisar su nginx.

🎭 **El sincronizador separa las películas por género de TMDB (v2.6.24)**: al escanear una carpeta,
cada título entra en su categoría —**Acción, Comedia, Terror, Thriller, Románticas, Ciencia ficción…**—
según la ficha de TMDB, con prioridad y renombrado configurables (una comedia romántica puede ir a
«Románticas»). Para el catálogo que ya está importado hay **vista previa** (sin tocar nada) y un
botón **Aplicar** que lo recoloca por lotes, creando las categorías que falten. Si TMDB no encuentra
un título, se queda en la categoría que tenía y no se repite la consulta.

🗺️ **Reparto de canales entre nodos (v2.6.30)**: con varios balancers, el panel reparte **qué canales sirve cada
VPS** (ponderado por su NIC). Así cada nodo pide al maestro sólo sus canales y el 1 Gbps del maestro no se
multiplica por cada nodo. Si el nodo asignado se llena o se cae, el canal vuelve al reparto normal sin cortar
al cliente. Botón **Repartir automáticamente** en *Sistema → Nodos Edge Load Balancer*.

⚡ **Los balancers suman ancho de banda de verdad (v2.6.29)**: en *Sistema → Nodos Edge Load Balancer*
escribes la IP y la clave del VPS y **el panel lo instala solo** por SSH. Cada nodo **cachea los segmentos**
(100 clientes del mismo canal = 1 descarga) y sirve los bytes él mismo, así su 1 Gbps **se suma** al del
maestro. El reparto va por **Mbps reales**, no sólo CPU: un nodo al 95 % de su enlace deja de recibir
clientes y el panel toma el relevo (o al revés, con el umbral que elijas). Sirve para 1 o para 10 VPS.

🔑 **«Falta la API Key de TMDB» con la clave ya puesta (v2.6.28)**: la tarjeta de géneros perdía el
estado de la clave al guardar las reglas y no se refrescaba al guardarla en el modal, así que bloqueaba
**Vista Previa** y **Aplicar**. Ya no: el `POST` de reglas devuelve el mismo estado que el `GET` y la
tarjeta se refresca sola al guardar o importar la clave. Si tu clave está en XUI.one, el modal tiene
**Importar Clave desde XUI.one**.

🏷️ **Todo lo que entra por carpeta cae en la categoría maestra `Movies` (v2.6.27)**: la opción «por
carpeta del disco», que creaba una categoría por subcarpeta (`Ciencia Ficcion/`, `triller/`…), ya no se
ofrece. Al sincronizar una carpeta eliges **Categoría maestra · Movies** (las series van a `Series`) o
**Por género de TMDB**. `Movies` y `Series` no se pueden borrar, y las categorías viejas se limpian
desde la misma pantalla o con `tvlister-admin vod-cats master` + `vod-cats clean --all --move-to "Movies"`.

Y si al pasar a géneros
quedaron categorías «de carpeta» (<i>Ciencia Ficcion</i>, <i>triller</i>, <i>accion</i>…), el mismo
modal tiene **Categorías del catálogo: borrar las que sobran**: muestra cuánto tiene cada una, borra
las vacías y, si alguna conserva títulos, los mueve antes a la categoría que elijas (nunca queda una
película sin categoría). En terminal: `tvlister-admin vod-cats`.

🚦 **El aviso «tu cuenta ya está en uso en otro aparato» se acabó con la línea vacía (v2.6.23)**: el
cupo lo llenan **sólo las conexiones que están reproduciendo**. Los aparatos ya registrados (el
televisor apagado de ayer) no ocupan hueco: un equipo nuevo entra, se apunta y reproduce mientras
quede una conexión libre, y el rechazo sólo aparece cuando la línea tiene agotadas sus
`max_connections` conexiones activas. Además, las conexiones sin latido caducan a los **2 minutos**
(antes las MPEG-TS duraban 15) y al reiniciar el panel se borran las conexiones fantasma heredadas.
El panel muestra «N de M conexión(es) en uso» y `tvlister-admin devices` lo mismo.

🗄️ **Jellyfin en otro servidor: monta su disco y «Create Symlink» funciona de verdad (v2.6.22)**: si
Jellyfin no está en la máquina del panel no hay archivo que enlazar. El panel monta su carpeta por
**NFS o SMB** (desde el modal o con `tvlister-admin jellyfin mount`), deja la línea en `/etc/fstab`
para que sobreviva al reinicio y **detecta solo la equivalencia de rutas**. El vídeo sale del disco:
no pasa por Jellyfin. La contraseña de SMB queda en un archivo `600`, nunca en `fstab`. El bloque
también **genera los comandos para compartir la carpeta en el otro servidor** (export NFS con la IP
del panel, o el recurso Samba) y **lista lo que ese servidor ya comparte** con `showmount -e`.

🔐 **Protección sin cifrado — registro de aparatos por MAC**: el DRM se ha **retirado** (v2.6.15).
Cada aparato que se conecta se auto-registra con su MAC (o una huella estable si la app no la
envía; el reproductor interno no cuenta como aparato, así una línea de 5 conexiones admite 5 equipos), el panel identifica tipo, marca, modelo, sistema y reproductor, y la línea admite tantos
aparatos como conexiones tenga (`max_connections`, o un `device_limit` propio). El que sobra se
rechaza con `403` en modo *bloquear*; por defecto sólo se registra. Funciona con lista M3U, apps
Xtream/XUI, MAG/Stalker y Enigma2 **sin tocar la app**. En el panel: botón *aparatos* de cada línea;
en terminal: `tvlister-admin devices`. Guía: **[`docs/REGISTRO_APARATOS_MAC.md`](docs/REGISTRO_APARATOS_MAC.md)**.

---

## Instalación Rápida en VPS Ubuntu / Debian (Coexistencia Segura con XUI.one)

El instalador opera en **modo aislado** (`/opt/tvlister24-7/.runtime`): no ejecuta `apt-get` sobre librerías fijadas por XUI.one, no toca MariaDB ni Nginx. El panel usa los **puertos estándar: `80` (HTTP) y `443` (HTTPS)**, así que se abre como `http://TU_IP` y `https://TU_IP`, sin escribir puerto. En un servidor **con XUI.one** se queda en el puerto interno de siempre (`8095`) para no pisar su nginx, y si el `80` está ocupado por otro proceso también baja al siguiente libre.

El `443` necesita un certificado real (nunca se genera uno autofirmado). Con Let's Encrypt ya instalado se abre solo; si lo tienes en archivos:

```bash
sudo tvlister-admin tls /ruta/fullchain.pem /ruta/privkey.pem   # instala el par y abre el 443
sudo tvlister-admin tls                                        # estado del certificado y del 443
```

### Opción recomendada: instalador de release (versión fija y verificada)

Descarga el paquete oficial del release, comprueba su **SHA256** e instala sin clonar ramas:

```bash
# última versión publicada
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.30/scripts/install_release.sh \
  | sudo bash
```

Para fijar una versión concreta (recomendado en producción):

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.30/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.30
```

Esta vía no depende de que el release tenga el `.tar.gz` adjunto: si falta (o su descarga falla), el
instalador baja el árbol exacto del tag. También existe el atajo clásico
`https://github.com/TalaveraSama/tvlister24-7/releases/…/install.sh` cuando el release lleva adjuntos.

El puerto por defecto es el `80`; `--port <n>` sólo hace falta si quieres forzar otro.

También puedes instalarlo desde la consola del propio servidor:

```bash
tvlister-admin release            # última versión publicada
tvlister-admin release v2.3.0     # versión exacta
```

### Opción alternativa: instalador desde el código fuente (rama de trabajo)

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/arena/85cc9902-tvlister24-7/scripts/install_ubuntu.sh | sudo bash
```

Una vez instalado, administra todo desde SSH con:

```bash
tvlister-admin
```

Comandos principales:
- `tvlister-admin status` — Ver IP, puerto activo, estado del servicio y coexistencia XUI.one.
- `tvlister-admin doctor` — Auditoría en tiempo real de Producción Total.
- `tvlister-admin reset-admin NUEVA_CLAVE` — Cambiar la contraseña de `admin`.
- `tvlister-admin shield` — Activar Blindaje *Stream Shield Proxy* (oculta URLs de proveedor y resuelve IP-Lock).
- `tvlister-admin import-xui` — Importar Streams, VOD, Series, Bouquets y Usuarios desde XUI.one local (o pasando un `.sql` / `.sql.gz`).
- `tvlister-admin clean` — Dejar el panel 100% limpio para producción conservando `admin` y perfiles FFmpeg.
- `tvlister-admin enable-cron` — Programar backup diario automático a las 03:00 AM (retención 7 días).
- `tvlister-admin setup-ssl tv.midominio.com` — Configurar proxy inverso Nginx + HTTPS Let's Encrypt.
- `tvlister-admin set-port 8895` — Cambiar puerto TCP y abrir firewall (`UFW` + `iptables`).
- `tvlister-admin vod-cats` — Ver cuántas películas/series tiene cada categoría y borrar las que sobran (las que crearon las carpetas). `vod-cats master` crea `Movies`/`Series` y pasa a la maestra las carpetas en modo antiguo; `vod-cats clean` borra las vacías; `vod-cats clean --all --move-to "Movies"` mueve el contenido a la maestra y borra el resto.
- `tvlister-admin update` — Actualizar desde GitHub sin perder base de datos ni puerto.
- `tvlister-admin release [vX.Y.Z]` — Instalar/actualizar desde un release publicado (paquete con checksum).

---

## Salida UDP / CATV analógica (WK2500)

El módulo *UDP / CATV* genera un SPTS MPEG-TS por número de canal (2 al 125) y lo entrega por una NIC
dedicada a los moduladores **WK2500**. Soporta **uno o varios equipos**, cada uno con su modelo real:

| Modelo | Canales de salida | Ejemplo de rango |
| --- | --- | --- |
| WK2500-32 | 32 | CH 2–33 |
| WK2500-64 | 64 | CH 2–65 |
| WK2500-125 | 124 | CH 2–125 |

Con **4 equipos de 32 canales** el panel reparte la grilla completa en un clic: CH 2–33, 34–65, 66–97 y
98–125 (capacidad 128 para 124 canales), con su IP/puerto UDP y su NIC por equipo. La API rechaza rangos
que excedan la capacidad del modelo o que se solapen con otro equipo, y avisa si algún canal queda sin
modulador. Ver `docs/DOCUMENTACION_SISTEMA.md` §8.22.

Cada equipo se declara con **su marca y modelo** — `CATVSCOPE CSP-2500C` (32 en 1, el más común),
`Wolck WK-2500C`, `Softel SFT2500C`, `SKD1709B`, `CatCast`, `Ustarlink`, `Shineco` o **genérico** — y con
**estándar de TV** (`NTSC-M` por defecto en Nicaragua, más PAL B/G, D/K, I, N y M) y **transporte**
(UDP o UDP+RTP, datagramas de 1316 o 188 bytes). El plan de frecuencias cambia automáticamente con el
estándar y cualquier canal puede forzar su MHz (HRC/IRC). Ver §8.23.

---

## Instalación con Docker Compose

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
docker compose up -d --build
```
