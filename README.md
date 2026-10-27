# TVLister 24/7 — Midnight Streamer OTT/VOD Panel

Plataforma auto-hospedada de código abierto para la gestión integral de **Canales en Vivo**, **Canales Dinámicos 24/7 (Playout Continuo)**, **Biblioteca VOD (Películas)**, **Líneas M3U / Xtream API / MAG / Enigma2**, **Módulo de Resellers con Créditos**, **Admin del Sistema** y **Reproductor Cliente WebTV HTML5**.

📖 **[Leer la Documentación Técnica, Operativa y Roadmap Completo (`docs/DOCUMENTACION_SISTEMA.md`)](docs/DOCUMENTACION_SISTEMA.md)**

---

## Instalación Rápida en VPS Ubuntu / Debian (Compatible con XUI.one)

El instalador opera en **modo aislado** (`/opt/tvlister24-7/.runtime`): no modifica paquetes `apt` del sistema, ni MariaDB, ni Nginx, y elige automáticamente un puerto libre (`8095`) si detecta **XUI.one**.

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/arena/85cc9902-tvlister24-7/scripts/install_ubuntu.sh | sudo bash
```

Una vez instalado, administra el sistema desde SSH con:

```bash
tvlister-admin
```

Comandos rápidos:
- `tvlister-admin status` — Ver IP, puerto activo y estado del servicio.
- `tvlister-admin reset-admin NUEVA_CLAVE` — Cambiar la contraseña de `admin`.
- `tvlister-admin set-port 8895` — Cambiar puerto TCP y abrir firewall.
- `tvlister-admin purge-demo` — Purgar datos de demostración y dejar listo para producción limpia.
- `tvlister-admin setup-ssl tv.midominio.com` — Configurar proxy inverso Nginx + HTTPS Let's Encrypt sin afectar XUI.one.
- `tvlister-admin enable-cron` — Programar backup diario automático a las 03:00 AM (retención 7 días).
- `tvlister-admin backup` — Crear copia de seguridad de SQLite en `/root/`.
- `tvlister-admin update` — Actualizar desde GitHub sin perder datos (con migración automática de esquema SQLite).

---

## Instalación con Docker Compose

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
docker compose up -d --build
```

---

## Resumen de Módulos Incluidos

1. **Dashboard & Telemetría en Vivo**: CPU, RAM, conexiones activas con botón *Kick* y monitor de emisión 24/7.
2. **Canales en Vivo + Catchup DVR + Importador M3U / XUI.one**: Modos *Direct Stream*, *On-Demand*, *Transcodificación FFmpeg* (`NVENC`, `QSV`, `CPU`) + grabador **TV Archive / Timeshift DVR** (`/timeshift/...`) y *failover* automático.
3. **Estudio de Canales 24/7**: Parrillas continuas desde VOD o URLs externas, reloj virtual o **Worker FFmpeg HLS 24/7 con Auto-Start**, marca de agua OSD y guía **EPG XMLTV automática**.
4. **Biblioteca VOD & Series Completas**: Gestión de películas y **Series con Temporadas y Episodios** compatibles con TiviMate, IPTV Smarters, M3U y WebTV.
5. **Líneas, Portal Nativo MAG Stalker (`/c/`) & Enigma2**: Control de expiración, conexiones simultáneas, bloqueo por IP, middleware `/stalker_portal/server/load.php` por MAC y API Xtream completa.
6. **Bouquets & Categorías**: Paquetes de contenido personalizables (Live, 24/7, Películas y Series).
7. **Resellers & Créditos**: Subcuentas para distribuidores con descuento automático por plan y bitácora de movimientos.
8. **Importador Automático XMLTV (`.xml` / `.xml.gz`), Mensajería OSD & Reportes**: Auto-sincronización cada 12h de guías externas comprimidas, banners OSD en tiempo real y soporte técnico.
9. **Clúster Edge Load Balancer Real, SSL, Firewall & Snapshots**: Agente Edge (`scripts/edge-agent.js`) instalable en 1 clic con balanceo por Carga/GeoIP/ISP, generador HTTPS Nginx, Firewall IPv4/IPv6 y snapshots diarios automáticos.
10. **Portal Cliente WebTV HTML5**: Reproductor web integrado con `hls.js`, favoritos, test de velocidad y envío de reportes.
