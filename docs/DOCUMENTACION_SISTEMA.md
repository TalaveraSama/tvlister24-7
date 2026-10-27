# Documentación Técnica y Operativa — TVLister 24/7 (Midnight Edition)

## 1. Resumen Ejecutivo: ¿Qué es y qué hace el sistema?

**TVLister 24/7 (Midnight Edition)** es un panel auto-hospedado (*self-hosted*) de gestión **OTT / IPTV / VOD y Playout de Canales Lineales 24/7**, diseñado para operar en servidores Linux (Ubuntu/Debian) ya sea de forma dedicada o **coexistiendo de forma aislada junto a paneles existentes como XUI.one**.

Su objetivo principal es permitir a un operador o administrador:
1. **Crear y transmitir Canales Lineales 24/7** a partir de videos VOD o flujos externos, calculando en tiempo real la programación en vivo y su guía EPG sin necesidad de unir archivos gigantes en disco.
2. **Gestionar Canales en Vivo (Live TV) y Catálogo VOD**, con soporte para *Direct Stream*, *On-Demand*, *Proxy MPEG-TS con Failover* y transcodificación con **FFmpeg** (CPU `libx264`, `NVIDIA NVENC`, `Intel QSV`).
3. **Administrar Clientes (Líneas M3U / Xtream, STB MAG y Enigma2)** y **Distribuidores (Resellers con sistema de créditos)**.
4. **Entregar señal estándar compatible con todas las aplicaciones comerciales** (*TiviMate, IPTV Smarters Pro, XCIPTV, Televizo, VLC, Kodi*) además de incluir su propio **Reproductor WebTV HTML5 integrado**.

---

## 2. Arquitectura del Sistema

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                    Clientes / Reproductores Finales                     │
│  • TiviMate / IPTV Smarters / XCIPTV  • VLC / Kodi / Enigma2 / MAG      │
│  • Navegador HTML5 (Portal WebTV Integrado con hls.js)                  │
└───────────────┬──────────────────────┬──────────────────────┬───────────┘
                │ /get.php (M3U)       │ /player_api.php      │ /xmltv.php
                │ /live/... (.m3u8/ts) │ /panel_api.php       │ (Guía EPG)
                ▼                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│               Servidor Central Node.js 22 + Express (0.0.0.0)           │
│  • Firewall de Aplicación (IPv4/IPv6, User-Agent, Anti-Scanners)        │
│  • Anti-Flood & Rate Limiting por IP + Autenticación HMAC-SHA256        │
│  • Enrutador OTT/Xtream (server/iptvApi.js) + API Admin (server/index)  │
└───────────────┬─────────────────────────────────────┬───────────────────┘
                │                                     │
                ▼                                     ▼
┌──────────────────────────────────┐  ┌───────────────────────────────────┐
│   Base de Datos SQLite 3 (WAL)   │  │   Motor de Streaming & 24/7       │
│  data/midnight_tvlister.db       │  │  • Reloj Virtual 24/7 + Auto-EPG  │
│  • 16 tablas relacionales ACID   │  │  • Supervisor FFmpeg Auto-Restart │
│  • Backups JSON transaccionales  │  │  • Segmentador HLS (/hls_out/...) │
└──────────────────────────────────┘  └───────────────────────────────────┘
```

### Modo de Coexistencia Aislada (Servidores con XUI.one)
Cuando se instala en un servidor que ya ejecuta **XUI.one**:
- Vive íntegramente dentro de `/opt/tvlister24-7` con su propio binario oficial de **Node.js v22.23.4** en `/opt/tvlister24-7/.runtime/node`.
- **No ejecuta `apt-get`** sobre librerías del sistema ni modifica MariaDB, PHP o Nginx de XUI.one.
- Reutiliza en modo solo-lectura el binario `ffmpeg` de XUI.one (`/home/xui/bin/ffmpeg`) o uno estático aislado.
- Elige automáticamente un puerto libre (por defecto **`8095`**) para nunca colisionar con los puertos `80` / `8080` de XUI.one.

---

## 3. ¿Qué hace cada módulo del Panel Web?

### 3.1. Dashboard & Monitor en Tiempo Real
- Muestra KPIs operativos: conexiones activas en vivo, canales online, canales 24/7 al aire y líneas activas.
- Telemetría real del servidor Linux: porcentaje de **CPU**, uso de **RAM**, *uptime* y estado de nodos balanceadores.
- **Franja "Emisión Continua 24/7 — En el Aire Ahora"**: indica qué película/programa va al aire en cada canal 24/7, porcentaje transcurrido, minutos restantes y botón **Ver Señal**.
- **Monitor de Conexiones Activas**: lista en tiempo real cada cliente conectado (usuario, canal sintonizado, IP, país, reproductor/User-Agent, protocolo) con botón **Kick** para desconectar sesiones.

### 3.2. Canales en Vivo (`Live Streams`)
- Alta, edición, inicio, parada y reinicio de canales en vivo (`HLS .m3u8`, `MPEG-TS .ts`, `RTMP`, `RTSP`, `UDP`).
- **Importador M3U / XUI.one**: permite pegar una lista `#EXTM3U` o una URL M3U (por ejemplo exportada desde XUI.one) para crear categorías y cargar cientos de canales en un clic.
- **3 Modos de Transmisión**:
  1. `Direct Stream`: redirige o hace proxy ligero sin recodificar (zapping `< 0.1s`, mínimo uso de CPU).
  2. `On-Demand`: mantiene el canal en reposo y lo activa automáticamente cuando entra el primer espectador.
  3. `Transcodificación Activa`: lanza un proceso `ffmpeg` supervisado en el servidor generando segmentos HLS propios (`/hls_out/...`) usando el perfil asignado (`CPU libx264`, `NVIDIA NVENC`, `Intel QSV`).
- Soporte para **URL de Respaldo (`backup_url`)** con *failover* automático en modo proxy.

### 3.3. Estudio de Canales Personalizados 24/7 (`Canales 24/7 Studio`)
- Permite armar canales de TV continua (ej. *Cine Acción 24/7*, * Infantil 24/7*) seleccionando videos del catálogo VOD o URLs externas MP4/HLS.
- Reordenamiento en caliente (`↑` / `↓`) sin necesidad de concatenar archivos gigantes en disco.
- **Dos modos de emisión**:
  1. **Reloj Dinámico Virtual**: calcula matemáticamente qué programa corresponde al segundo actual del día y sincroniza automáticamente el reproductor WebTV y la guía EPG.
  2. **Worker FFmpeg 24/7 en Servidor**: genera un flujo HLS continuo real (`ffmpeg -re -stream_loop -1 -f concat ...`) servido desde `/hls_out/...` para compatibilidad continua 24/7 en cualquier Smart TV o STB externo.
- **Guía EPG Automática**: calcula y publica automáticamente los horarios de inicio y fin de cada bloque en `/xmltv.php` y `/player_api.php`.
- **Marca de Agua (Watermark OSD)**: texto superpuesto configurable por canal.

### 3.4. Biblioteca VOD (Películas y Series)
- Gestión de catálogo bajo demanda con título, póster, sinopsis, género, año, calificación, duración y contenedor (`mp4`, `m3u8`, `mkv`).
- Disponible automáticamente en listas M3U, apps Xtream Codes, Portal WebTV y en el armador de Canales 24/7.

### 3.5. Líneas, Dispositivos MAG & Enigma2
- Creación y edición de suscriptores con usuario, contraseña, fecha de expiración, límite estricto de **conexiones simultáneas** y bloqueo opcional por IP (`allowed_ips`).
- Soporte para perfiles de dispositivo `M3U / Xtream`, `MAG (MAC 00:1A:79:...)` y `Enigma2`.
- Modal **M3U / API** por cada línea con enlaces listos para copiar:
  - M3U Plus en HLS (`output=hls`) y MPEG-TS (`output=ts`).
  - Guía EPG XMLTV personalizada.
  - Credenciales Host / Usuario / Contraseña para login Xtream Codes.

### 3.6. Bouquets & Categorías
- Agrupa canales en vivo, canales 24/7 y películas VOD en paquetes comerciales (*Bouquets*, ej. *Plan Básico*, *Plan VIP*, *Hotel TV*) para controlar exactamente qué contenido ve cada línea o paquete reseller.

### 3.7. Módulo de Resellers & Paquetes de Créditos
- Creación de cuentas con rol `reseller` y billetera de créditos.
- Definición de planes comerciales (ej. *Demo 24h = 0 créditos*, *1 Mes = 1 crédito*, *1 Año = 10 créditos*).
- Cuando un Reseller inicia sesión en el panel, **solo ve sus propias líneas y conexiones**, y al crear una línea el sistema descuenta automáticamente los créditos correspondientes dejando registro en la bitácora de auditoría.

### 3.8. EPG Personalizado, Mensajes OSD & Reportes de Clientes
- Publicación manual de eventos EPG adicionales y enlace directo al archivo XMLTV global.
- **Emisor OSD / Watermark**: envía mensajes informativos o alertas en pantalla en tiempo real a todos los clientes conectados en WebTV o a una línea específica.
- **Bandeja de Reportes (Claims)**: recibe avisos de fallas enviados por los usuarios desde su reproductor y permite marcarlos como resueltos.

### 3.9. Admin del Sistema, Firewall & Backups
- **Auditoría de Producción en Tiempo Real**: verifica estado de contraseña `admin`, llave HMAC de 256 bits, SQLite WAL, protecciones anti-fuerza bruta, FFmpeg y compilación de producción.
- Gestión de cuentas **Super Admin**, cambio de contraseñas, ajustes globales y mantenimiento rápido (*Sincronizar Motor*, *Purgar Conexiones Fantasma*, *VACUUM SQLite*).
- **Firewall de Aplicación**: bloqueo instantáneo por dirección IPv4/IPv6 o *User-Agent*, más filtro automático contra escáneres (`masscan`, `zgrab`, `nmap`, `sqlmap`).
- **Backups Transaccionales**: descarga completa en JSON y restauración atómica con `ROLLBACK` automático ante errores.

### 3.10. Portal Cliente WebTV HTML5 Integrado
- Accesible desde el botón **Portal Cliente WebTV** sin instalar nada en el navegador.
- Soporta reproducción HLS (`hls.js`) y MP4, sincronización automática al minuto exacto de los canales 24/7, buscador, filtro por categorías, lista de **Favoritos**, **Test de Velocidad** contra el servidor y formulario para **Reportar Canal**.

---

## 4. Referencia de Endpoints y Comandos CLI

### 4.1. Endpoints Estándar para Reproductores IPTV

| Ruta | Propósito | Ejemplo de Parámetros |
| :--- | :--- | :--- |
| `GET /get.php` | Descarga de lista M3U / M3U Plus | `?username=U&password=P&type=m3u_plus&output=hls` |
| `GET /xmltv.php` | Guía electrónica de programación XMLTV | `?username=U&password=P` |
| `GET/POST /player_api.php` | API Xtream Codes (TiviMate, Smarters, etc.) | `?username=U&password=P&action=get_live_streams` |
| `GET/POST /panel_api.php` | Alias de compatibilidad para apps IPTV legacy | `?username=U&password=P` |
| `GET /live/:u/:p/:id.m3u8` | Entrega de canal en vivo o canal 24/7 (`10000+id`) | `/live/demo/demo123/1.m3u8` |
| `GET /:u/:p/:id.ts` | Ruta corta Xtream para STBs y VLC | `/demo/demo123/1.ts` |
| `GET /hls_out/:u/:p/:key/:seg` | Entrega autenticada de segmentos `.ts` locales FFmpeg | Generada internamente en el manifiesto HLS |
| `GET /movie/:u/:p/:id.mp4` | Entrega autenticada de películas VOD | `/movie/demo/demo123/1.mp4` |

### 4.2. Consola CLI para el Administrador Linux (`tvlister-admin`)

En el servidor VPS como `root`:

```bash
tvlister-admin                  # Abre el menú interactivo [1-8]
tvlister-admin status           # Muestra IP, puerto activo, estado systemd y coexistencia XUI
tvlister-admin reset-admin CLV  # Cambia la contraseña del usuario 'admin' directamente en SQLite
tvlister-admin set-port 8895    # Cambia el puerto TCP del panel, abre firewall y reinicia
tvlister-admin open-firewall    # Abre el puerto actual en UFW e iptables
tvlister-admin backup           # Guarda copia de midnight_tvlister.db en /root/
tvlister-admin update           # Actualiza desde GitHub sin perder base de datos ni puerto
tvlister-admin logs             # Muestra logs del servicio en tiempo real
```

---

## 5. ¿Qué falta ahora mismo? (Checklist Operativo vs. Roadmap Futuro)

### 5.1. Checklist Operativo Inmediato (Lo que te falta configurar para lanzar con tus clientes)

1. **Limpiar los datos de demostración iniciales:**
   - Eliminar o cambiar la contraseña de la línea `demo / demo123` y la cuenta reseller `reseller_latam`.
   - Eliminar los 4 canales y 4 cortos abiertos de prueba (Blender) cuando cargues tu contenido propio o importes tu lista M3U desde XUI.one.
2. **Activar Worker FFmpeg en tus Canales 24/7 para apps externas (TiviMate / Smart TV):**
   - En el módulo **Canales 24/7 Studio**, abre el ícono de terminal (`>_`) de cada canal 24/7 y pulsa **"Iniciar Worker FFmpeg 24/7 en Servidor"**. Así FFmpeg generará un flujo HLS continuo ininterrumpido para televisores externos (no solo en WebTV).
3. **Configurar HTTPS / Dominio con Nginx o Cloudflare (Recomendado):**
   - Actualmente tu servidor responde por HTTP en `http://TU_IP:8095`. Si vas a entregar WebTV o listas HLS a navegadores/Smart TVs que exigen SSL, apunta un subdominio (ej. `panel.tudominio.com`) mediante Cloudflare o un bloque `proxy_pass http://127.0.0.1:8095;` con Let's Encrypt.
4. **Programar Backups Automáticos Diarios en Linux (`cron`):**
   - Ejecuta `crontab -e` como `root` y añade:
     ```cron
## 5. Nuevos Módulos Enterprise v2.0 (Partes A y B Implementadas)

### 5.1. Automatización Operativa de Producción (Parte A — 100% Activa)
1. **Modo Producción Limpio (`Purgar Datos Demo`):**
   - Desde **Admin Sistema & Seguridad → Purgar Datos Demo (Modo Limpio)** o por SSH con `sudo tvlister-admin purge-demo`.
   - Elimina todos los canales/VOD/series/líneas de prueba y marca `demo_purged=true` para que nunca se vuelvan a sembrar al reiniciar, conservando intactos tu Super Admin, categorías y perfiles FFmpeg.
2. **Motor FFmpeg HLS 24/7 Persistente (`Auto-Start`):**
   - Cada canal en **Canales 24/7** permite elegir entre **Reloj Virtual (0% CPU)** o **FFmpeg HLS Continuo (`Auto-Start`)**; los canales en modo FFmpeg levantan automáticamente su proceso supervisor al reiniciar el servidor Linux.
3. **Configurador Automático Dominio Nginx + SSL Let's Encrypt (Compatible XUI.one):**
   - Generador integrado en **Admin Sistema & Seguridad** y comando directo `sudo tvlister-admin setup-ssl tv.midominio.com admin@midominio.com`.
4. **Snapshots y Backups Diarios Automáticos:**
   - Planificador interno cada 24h en `data/backups/` con retención automática (creación, descarga y restauración en 1 clic desde la UI) + `sudo tvlister-admin enable-cron` para respaldo diario en `/root` a las 03:00 AM.

---

### 5.2. Módulos Enterprise Avanzados (Parte B — 100% Activa)

| Módulo / Función | Estado en v2.0 | Detalles Técnicos y Rutas |
| :--- | :--- | :--- |
| **Agente Edge Load Balancer Remoto Real** | **ACTIVO** | `scripts/edge-agent.js` + instalador 1-clic `/api/lb/install.sh`. Reporta CPU/RAM/Conexiones cada 10s a `/api/lb/heartbeat` y enruta clientes reales por **Menor Carga, GeoIP o ISP** con failover automático al Master. |
| **Series con Temporadas y Episodios** | **ACTIVO** | Tablas `series` y `series_episodes`, pestaña dedicada en **Películas & Series**, WebTV Series, M3U y Xtream API completa (`get_series_categories`, `get_series`, `get_series_info`, `/series/:u/:p/:id.mp4`). |
| **TV Archive / Catchup & Timeshift DVR** | **ACTIVO** | Grabador FFmpeg de segmentos MPEG-TS por epoch (`streams_runtime/archive/`), botón **REC DVR** en vivo, limpieza automática por días y rutas `/timeshift/:u/:p/:dur/:start/:id.m3u8` + `/streaming/timeshift.php`. |
| **Importador Automático XMLTV (`.xml` y `.xml.gz`)** | **ACTIVO** | Descompresor GZIP nativo (`node:zlib`) + parser XMLTV (`server/epgSync.js`) con auto-sincronización cada 12h y botón **Sincronizar Ahora**. |
| **Portal Middleware Stalker / Ministra (`/c/`)** | **ACTIVO** | Emulador nativo MAG STB en `/c/`, `/stalker_portal/c/`, `/server/load.php` y `/stalker_portal/server/load.php` con autenticación por dirección MAC, géneros ITV, canales, VOD y mensajes OSD. |

