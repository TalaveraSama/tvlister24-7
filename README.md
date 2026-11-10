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

🧭 **La página CATV, ordenada en dos pestañas (v2.6.49)**: **1 · Nativo TVLister** (moduladores de 32/64/125,
armado rápido, interfaz dedicada, nombres de las portadoras, grilla de canales y plantillas CSV) · **2 · Flussonic ·
quién emite** (enviar, verificar y volver sin dos emisores). La pestaña **«Flussonic UDP · push»** se retiró del
panel: el tema UDP/Flussonic queda para después y la página se queda con lo que hace falta hoy, las plantillas de
los WK2500.

🧪 **Si Flussonic sigue rechazando el cuerpo (v2.6.41)**: el panel prueba las formas conocidas de escritura
(`outputs`, `push`, stream completo; con objetos y con texto) y se queda con la que el servidor **acepta y
guarda** (lo comprueba releyendo). Si ninguna funciona, el aviso trae la respuesta exacta de cada intento y
el comando `tvlister-admin catv flussonic probe <stream>` para verlo todo y dejarlo como estaba. Si el
servidor tiene `config_external` (los streams los define un backend externo) el panel lo detecta y lo dice:
en ese modo Flussonic rechaza cualquier cambio por API.

🛠️ **La salida UDP se escribe bien en Flussonic 23.12 (v2.6.39 + v2.6.40)**: Flussonic actualiza con **PUT** y JSON merge
patch, y rechaza el cuerpo entero si le llegan `inputs` con sus campos de estado (`stats`, `id`). El panel
mandaba PATCH y, al fallar, reenviaba el stream entero: de ahí el `HTTP 400 · parsing_parameters` y los
canales «sin salida». Ahora manda **sólo** `{"outputs":[…]}` y **relee** el stream para confirmar que la
salida quedó puesta; si Flussonic no la guarda, el canal **no** se pasa a Flussonic y se avisa. Los que se
hayan quedado sin salida tienen un botón **Devolver a TVLister** (v2.6.40: también los que no tienen stream
mapeado; los que no tienen fuente local se avisan, no se arrancan en vacío).

⚡ **El panel no emite cuando manda Flussonic (v2.6.37)**: al guardar la salida UDP de un canal en Flussonic, el
canal pasa a Flussonic y **TVLister cierra su emisor** en ese mismo momento (cero datagramas, comprobado
midiendo). El panel sólo **escribe el texto de la salida** en Flussonic y vigila que siga puesta. Vale también
para canales cuya fuente vive sólo en Flussonic (sin stream local). `--keep-local` queda como excepción a
propósito, con aviso de dos emisores.

🔌 **El push UDP de Flussonic se retiró del panel (v2.6.49)**: la pantalla que escribía la salida UDP de cada canal
en Flussonic ya no está, ni su API (`/api/wk2500/flussonic-push…`), ni sus pruebas. Se queda el emparejamiento
automático de **quién emite** (pestaña 2) y la plantilla de los WK2500 (pestaña 1). El tema UDP/Flussonic se retoma
después; el diagnóstico `tvlister-admin catv flussonic probe <stream>` sigue disponible y no deja nada cambiado.

🔀 **Control de quién emite (v2.6.33)**: la tarjeta de control **detecta** qué stream de Flussonic corresponde a
cada canal, los **pasa a Flussonic** con un clic y muestra por canal si está **emitiendo**, si el stream está
**caído** o si **perdió la salida**. «Volver a TVLister» quita primero la salida de Flussonic, así nunca hay dos
emisores al mismo destino. También: `tvlister-admin catv flussonic status|map|apply|verify|local`.

📡 **El UDP nativo va como siempre (v2.6.33)**: el estabilizador de la v2.6.32 provocaba micro-tirones con vídeo
VBR (un I-frame grande esperaba en la cola), así que quedó **apagado por defecto**: la salida es la de siempre,
sin tocar el flujo. Sigue disponible con `TVLISTER_CATV_PACER=on` para orígenes CBR. La estabilización definitiva
se hará sobre el **muxer** (CBR/PCR), no troceando el socket.

🎭 **«Sólo sale Movies» al separar por género (v2.6.31)**: si juntaste todo en la categoría maestra, la
separación por género de TMDB no reconstruía Acción, Comedia, Terror… porque sólo miraba los títulos **sin**
género guardado. Ya no: mueve también los que **ya tienen el género** y sólo estaban en otra categoría, sin
gastar consultas de TMDB. Vista Previa → Aplicar y listo.

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
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.37/scripts/install_release.sh \
  | sudo bash
```

Para fijar una versión concreta (recomendado en producción):

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.37/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.37
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
- `tvlister-admin uninstall` — **Desinstalar completo** el panel de este servidor (servicio, comando, carpeta,
  caché, cron, nginx, certificados y reglas de firewall del panel). Guarda la base de datos en
  `/root/tvlister-backup-AAAAMMDD-HHMM`; con `--purge` se lo lleva todo y con `--dry-run` sólo enseña lo que haría.
  No toca `/home/xui`, ni los puertos 80/443 de nginx/firewall (salvo los bloques del propio panel).

---

## Canales 24/7 desde YouTube: directo, vídeo en bucle o lista completa

En **Canales 24/7 → Crear Canal 24/7** hay dos tipos de fuente: *Parrilla 24/7* (películas del catálogo) o
*Señal de YouTube*. En esta última vale cualquiera de estos enlaces y el panel elige solo cómo emitirlo:

| Enlace | Qué hace |
| --- | --- |
| `youtube.com/watch?v=…` · `youtu.be/…` · `/shorts/…` | **Vídeo en bucle**: el mismo vídeo, una y otra vez (`-re -stream_loop -1`) |
| `youtube.com/playlist?list=…` | **Lista completa**: sus vídeos en orden y, al terminar el último, vuelve al primero |
| `watch?v=…&list=…` (el del navegador) | Se trata como **lista completa**; la pantalla ofrece «Sólo ese vídeo» si quieres el vídeo suelto |
| `…/live/…` · `/@canal/live` · `/channel/UC…/live` | **Directo**, tal cual (se copia el HLS, sin recodificar) |

- **Copia exacta (copy/copy) en los directos**: el vídeo y el audio salen tal como llegan, sin recodificar (0 % de
  CPU de vídeo). Si YouTube da el audio en una **pista aparte**, el panel abre las dos y las une al copiar. Sólo el
  audio se recodifica si tienes encendido el **nivelador de audio global** (y aun así el vídeo se sigue copiando).
  La tarjeta de cada canal lo dice: `⧉ COPIA EXACTA`, `⧉ COPIA · AUDIO AAC` o `↻ RECODIFICA`.
- Se toman **hasta 30 vídeos** de una lista; los **directos** que haya dentro y los vídeos sin MP4 utilizable se
  omiten (la vista previa avisa de cuántos).
- **Sin recodificar** si todo es H.264 + AAC y mide lo mismo; si hay VP9/AV1/HEVC, más de 1080p o una lista con
  formatos mezclados, se pasa a **H.264 2500k + AAC 128k** para que ningún cliente se quede sin imagen.
- La URL firmada se renueva sola antes de caducar (guardia cada minuto); si el directo termina, el canal queda
  **SIN SEÑAL** sin borrar nada y se reengancha cuando vuelve.
- Si un vídeo **sólo ofrece DASH/HLS** (sin MP4 progresivo, cada vez más común), el panel lo **descarga una vez**
  (H.264 + AAC, hasta 1080p) y lo repite **desde el disco**: sin caducidad, sin renovar y sin volver a YouTube.
  Se marca con `⛁ DESDE EL DISCO` y vive en `.runtime/videos` (se conserva al actualizar).
- En modo **virtual** (sin motor) se entrega un directo o un vídeo con 302; una lista necesita el motor FFmpeg
  (responde 503 explicándolo).

Requisito: **yt-dlp** (se instala desde la propia pantalla, sin `apt`) y FFmpeg. El botón **Instalar yt-dlp**
baja el **binario autónomo** (`yt-dlp_linux`, ~39 MB), que lleva su propio Python y **no depende del python3
del servidor**; el zipapp normal necesita un python3 completo (`_ssl`, `sqlite3`) y en servidores recortados
fallaba al arrancar. El binario se prueba (`--version`) **antes** de instalarlo y la descarga va en segundo
plano con su paso a la vista. Si YouTube contesta «Requested format is not available», el panel reintenta con
otros clientes (`tv`, `web_safari`, `ios`) y avisa cuando la versión instalada de yt-dlp se ha quedado vieja
(botón **Actualizar yt-dlp**, que al terminar recomprueba el enlace solo). Si YouTube pide «confirma que no eres
un robot», hay un apartado para indicar un
archivo de cookies en formato Netscape: botón **Subir cookies (.txt)** en la propia pantalla (el panel lo valida,
lo guarda con permisos 600 en `.runtime/youtube-cookies.txt` y lo usa solo, también al renovar el enlace),
**«Probar cookies»** (las usa contra YouTube de verdad) y, cuando algo falla, **«Ver qué formatos ve yt-dlp»**
con el motivo exacto que da YouTube.

No hay inicio de sesión con usuario y contraseña porque **YouTube no lo permite** (Google bloquea el login
automático y yt-dlp lo rechaza: `Login with password is not supported for YouTube`). El `.txt` de cookies **es** la
sesión: el panel muestra hasta qué día vale y avisa cuando le quedan ≤ 3 días.

---

## Desinstalar (sin tocar XUI.one ni el resto del servidor)

```bash
sudo /opt/tvlister24-7/scripts/uninstall.sh          # o: tvlister-admin uninstall
```

Antes de borrar nada pregunta, y por defecto **guarda la base de datos y lo subido** en
`/root/tvlister-backup-AAAAMMDD-HHMM/` (si vuelves a instalar, copia esa carpeta en `data/` y todo sigue
donde estaba). Modos:

| Comando | Qué hace |
| --- | --- |
| `sudo bash scripts/uninstall.sh` | Desinstala **todo** y guarda los datos en `/root/tvlister-backup-…` |
| `sudo bash scripts/uninstall.sh --purge` | Desinstala y **borra todo**, sin copia (access codes, canales, VOD, respaldos viejos) |
| `sudo bash scripts/uninstall.sh --dry-run` | Sólo enseña lo que haría: no cambia nada |
| `sudo bash scripts/uninstall.sh --yes` | Sin preguntar (para scripts y SSH) |
| `--keep-data` / `--keep-certs` / `--keep-firewall` / `--keep-backups` | Se queda esa parte |

Quita: el servicio `tvlister24-7` y su unidad de systemd (con los ajustes de Cloudflare y cualquier drope-in), el
comando `tvlister-admin` (`/usr/local/bin`, `/usr/bin`…), la carpeta `/opt/tvlister24-7`, `/var/lib/tvlister24-7`
(HLS y playlists temporales), el cron del backup automático, **los bloques de nginx que puso el panel**
(`tvlister-panel.conf`, `tvlister-streams.conf`, `tvlister247-*.conf`, `tvlister-cloudflare-realip.conf`,
`/root/tvlister247_*.nginx.conf`) recargando nginx sin cortar nada, **los certificados de `/etc/tvlister`** y
**las reglas de firewall que abrió el instalador** (puerto del panel, 1935, 19350, 8554, 8890/udp) por `ufw delete`
y `iptables -D`.

**No toca nunca**: `/home/xui` (XUI.one y su nginx, con sus canales `a0*.conf`), los puertos **80/443** de nginx y
del firewall, ni archivos de otros programas. Los respaldos `/root/tvlister_backup_*.tar.gz` se conservan salvo
`--purge`.

### Desinstalar por SSH, desde tu PC (sin entrar al servidor)

```bash
# 1) el servidor tiene que aceptar tu clave (una sola vez)
ssh-copy-id root@192.168.200.8

# 2) desinstalar desde tu PC
bash scripts/uninstall_ssh.sh root@192.168.200.8
```

Pregunta aquí, envía el desinstalador por SSH y lo ejecuta allí con `--yes`; al final comprueba que no queda nada.
Opciones de este lanzador: `--puerto 2222`, `--clave ~/.ssh/id_ed25519`, `--descargar` (usa el último publicado en
GitHub en vez del script de tu PC) y `--tag v2.6.51`. Todo lo demás (`--purge`, `--dry-run`, `--keep-certs`…) se
pasa al desinstalador del servidor.

Si no puedes entrar sin contraseña, una sola línea desde tu PC o desde la consola del servidor:

```bash
ssh root@TU_IP 'curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/uninstall.sh | bash -s -- --yes'
```

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

### Salida UDP puesta por Flussonic (opt-in, por canal)

En *Canales* cada canal puede quedar **controlado por Flussonic**: el panel escribe la salida UDP con la API
(`PUT /streamer/api/v3/streams/<stream>`) y **deja de emitir** por su cuenta, así que nunca hay dos emisores en
el mismo grupo. La forma del cuerpo la dicta el propio servidor: si el `PUT` normal devuelve `400`, el panel lee
su OpenAPI (`GET /streamer/api/v3/schema`), escribe con el campo y el tipo que declara y, como última baza,
reenvía el stream del `GET` recortado a las propiedades que su esquema admite (`schema:full`). El cambio de
motor es seguro: primero se verifica la salida en Flussonic y sólo entonces TVLister suelta el canal.

Diagnóstico en el servidor: `sudo /opt/tvlister24-7/scripts/tvlister-admin.sh catv flussonic probe a0ed`
(deja el stream como estaba y enseña la respuesta exacta de cada intento).

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
