# Panel TVLister 24/7 — Servidor IPTV / OTT / VOD (v2.3 Producción Total)

Plataforma auto-hospedada para la gestión profesional de **Canales en Vivo**, **Canales Lineales 24/7 (Playout Continuo)**, **Películas y Series VOD**, **Importación Nativa desde Base de Datos XUI.one**, **Blindaje Stream Shield Proxy (TS + HLS)**, **Líneas M3U / Xtream API / MAG Stalker / Enigma2**, **Módulo de Resellers con Créditos**, **Salida UDP/CATV para moduladores WK2500 (modelos de 32, 64 y 125 canales)** y **Portal Cliente WebTV HTML5**.

📖 **[Manual Completo del Panel, Guía de Uso y Tecnología (`docs/DOCUMENTACION_SISTEMA.md`)](docs/DOCUMENTACION_SISTEMA.md)**

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
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.3.0/install.sh \
  | sudo bash -s -- --tag v2.3.0 --port 8095
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

---

## Instalación con Docker Compose

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
docker compose up -d --build
```
