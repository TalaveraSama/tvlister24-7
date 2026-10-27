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
- `tvlister-admin backup` — Crear copia de seguridad de SQLite en `/root/`.
- `tvlister-admin update` — Actualizar desde GitHub sin perder datos.

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
2. **Canales en Vivo + Importador M3U / XUI.one**: Modos *Direct Stream*, *On-Demand* y *Transcodificación FFmpeg* (`NVENC`, `QSV`, `CPU`) + *failover* a URL de respaldo.
3. **Estudio de Canales 24/7**: Parrillas continuas desde VOD o URLs externas, reloj en vivo sincronizado, worker HLS FFmpeg 24/7, marca de agua OSD y guía **EPG XMLTV automática**.
4. **Biblioteca VOD**: Gestión de películas MP4/MKV/M3U8.
5. **Líneas, MAG & Enigma2**: Control de expiración, conexiones simultáneas, bloqueo por IP y generador automático de `/get.php` (M3U), `/xmltv.php` y `/player_api.php` (TiviMate, IPTV Smarters, VLC, XCIPTV).
6. **Bouquets & Categorías**: Paquetes de contenido personalizables.
7. **Resellers & Créditos**: Subcuentas para distribuidores con descuento automático por plan y bitácora de movimientos.
8. **EPG, Mensajería OSD & Reportes**: Banners en tiempo real para clientes y bandeja de soporte.
9. **Admin del Sistema, Firewall & Backups**: Auditoría de producción en vivo, gestión de Super Admins, Firewall IPv4/IPv6 + Anti-Scanners y respaldos JSON transaccionales.
10. **Portal Cliente WebTV HTML5**: Reproductor web integrado con `hls.js`, favoritos, test de velocidad y envío de reportes.
