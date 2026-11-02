# Panel TVLister 24/7 — Servidor IPTV / OTT / VOD (v2.3 Producción Total)

Plataforma auto-hospedada para la gestión profesional de **Canales en Vivo**, **Canales Lineales 24/7 (Playout Continuo)**, **Películas y Series VOD**, **Importación Nativa desde Base de Datos XUI.one**, **Blindaje Stream Shield Proxy (TS + HLS)**, **Líneas M3U / Xtream API / MAG Stalker / Enigma2**, **Módulo de Resellers con Créditos**, **Salida UDP/CATV para moduladores WK2500 (modelos de 32, 64 y 125 canales)** y **Portal Cliente WebTV HTML5**.

📖 **[Manual Completo del Panel, Guía de Uso y Tecnología (`docs/DOCUMENTACION_SISTEMA.md`)](docs/DOCUMENTACION_SISTEMA.md)**

🎬 **Jellyfin → VOD con «Create Symlink»**: el panel importa tu catálogo de Jellyfin (películas, otros VOD y series con episodios) y, como XUI.one, **crea enlaces simbólicos** a los archivos que ya tienes en el disco: no copia, no mueve y no recodifica nada. Botón *Jellyfin* en **VOD y Series**; en terminal: `tvlister-admin jellyfin`. Guía: **[`docs/JELLYFIN_VOD.md`](docs/JELLYFIN_VOD.md)**.

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

El instalador opera en **modo aislado** (`/opt/tvlister24-7/.runtime`): no ejecuta `apt-get` sobre librerías fijadas por XUI.one, no toca MariaDB ni Nginx, y elige automáticamente un puerto libre (`8095`).

### Opción recomendada: instalador de release (versión fija y verificada)

Descarga el paquete oficial del release, comprueba su **SHA256** e instala sin clonar ramas:

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash
```

Para fijar una versión concreta (recomendado en producción) y el puerto:

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.22/install.sh \
  | sudo bash -s -- --tag v2.6.22 --port 8095
```

Si un release no tiene el paquete adjunto (o su descarga falla), el instalador usa el árbol del tag:

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.22/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.22
```

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
