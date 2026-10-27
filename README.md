# TVLister 24/7 — Midnight Streamer OTT/VOD Panel (v2.2 Producción Total)

Plataforma auto-hospedada para la gestión profesional de **Canales en Vivo**, **Canales Lineales 24/7 (Playout Continuo)**, **Películas y Series VOD**, **Importación Nativa desde Base de Datos XUI.one**, **Blindaje Stream Shield Proxy (TS + HLS)**, **Líneas M3U / Xtream API / MAG Stalker / Enigma2**, **Módulo de Resellers con Créditos** y **Portal Cliente WebTV HTML5**.

📖 **[Manual Completo del Panel, Guía de Uso y Tecnología (`docs/DOCUMENTACION_SISTEMA.md`)](docs/DOCUMENTACION_SISTEMA.md)**

---

## Instalación Rápida en VPS Ubuntu / Debian (Coexistencia Segura con XUI.one)

El instalador opera en **modo aislado** (`/opt/tvlister24-7/.runtime`): no ejecuta `apt-get` sobre librerías fijadas por XUI.one, no toca MariaDB ni Nginx, y elige automáticamente un puerto libre (`8095`).

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

---

## Instalación con Docker Compose

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
docker compose up -d --build
```
