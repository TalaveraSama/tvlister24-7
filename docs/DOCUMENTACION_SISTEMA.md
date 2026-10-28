# Manual Completo del Panel, Guía de Uso y Arquitectura Tecnológica
**Panel TVLister 24/7 — Servidor IPTV / OTT / VOD (Versión Producción Total v2.3)**

---

## Índice General
1. [¿Qué es TVLister 24/7 y para qué sirve?](#1-qué-es-tvlister-247-y-para-qué-sirve)
2. [Tecnología que Utiliza (Stack Técnico Completo)](#2-tecnología-que-utiliza-stack-técnico-completo)
3. [Arquitectura de Producción y Coexistencia con XUI.one](#3-arquitectura-de-producción-y-coexistencia-con-xuione)
4. [Qué Hace Cada Función del Panel y Cómo Utilizarla](#4-qué-hace-cada-función-del-panel-y-cómo-utilizarla)
   - 4.1. [Dashboard y Monitor en Tiempo Real](#41-dashboard-y-monitor-en-tiempo-real)
   - 4.2. [Canales en Vivo (Live Streams + Catchup DVR)](#42-canales-en-vivo-live-streams--catchup-dvr)
   - 4.3. [Estudio de Canales 24/7 (Playout Continuo)](#43-estudio-de-canales-247-playout-continuo)
   - 4.4. [Películas y Series VOD](#44-películas-y-series-vod)
   - 4.5. [Líneas, Dispositivos MAG y Enigma2](#45-líneas-dispositivos-mag-y-enigma2)
   - 4.6. [Bouquets y Categorías](#46-bouquets-y-categorías)
   - 4.7. [Resellers y Paquetes de Créditos](#47-resellers-y-paquetes-de-créditos)
   - 4.8. [EPG (Guía de TV), Mensajes OSD y Reportes](#48-epg-guía-de-tv-mensajes-osd-y-reportes)
   - 4.9. [Importar XUI.one (Migración Nativa de Base de Datos)](#49-importar-xuione-migración-nativa-de-base-de-datos)
   - 4.10. [Admin del Sistema, Seguridad, SSL y Backups](#410-admin-del-sistema-seguridad-ssl-y-backups)
   - 4.11. [Portal Reproductor WebTV HTML5 para Clientes](#411-portal-reproductor-webtv-html5-para-clientes)
5. [Cómo Conectan tus Clientes Finales (Apps, Smart TV, MAG, Web)](#5-cómo-conectan-tus-clientes-finales-apps-smart-tv-mag-web)
6. [Consola de Administración por Terminal SSH (`tvlister-admin`)](#6-consola-de-administración-por-terminal-ssh-tvlister-admin)
7. [Referencia Técnica de Endpoints y Base de Datos](#7-referencia-técnica-de-endpoints-y-base-de-datos)

---

## 1. ¿Qué es TVLister 24/7 y para qué sirve?

**Panel TVLister 24/7** es una plataforma auto-hospedada (*self-hosted*) de **gestión profesional IPTV / OTT / VOD y creación de Canales Lineales 24/7**, diseñada para servidores Linux Ubuntu/Debian en producción real.

Permite centralizar en un único panel limpio y ultrarrápido:
* **Distribución de Canales en Vivo, Películas VOD y Series completas** hacia cualquier aplicación comercial (*TiviMate, IPTV Smarters Pro, XCIPTV, Televizo, VLC, Kodi, cajas MAG Stalker, receptores Enigma2 y navegadores Web*).
* **Creación de Canales Propios 24/7** a partir de tu biblioteca de películas o enlaces MP4/HLS, con programación continua sincronizada al segundo y guía electrónica EPG generada automáticamente.
* **Migración directa desde XUI.one / Xtream UI**, leyendo canales, películas, series, categorías, bouquets, líneas y dispositivos MAG en modo 100% solo-lectura sin detener ni afectar tu XUI.one actual.
* **Blindaje de Proveedores (*Stream Shield Proxy*)**, ocultando las URLs y credenciales originales de tus fuentes y resolviendo bloqueos por IP (*IP-Lock*) de tus proveedores upstream.
* **Comercialización mediante Resellers**, con billetera de créditos, planes predefinidos y aislamiento total entre distribuidores.

---

## 2. Tecnología que Utiliza (Stack Técnico Completo)

El sistema está construido con tecnologías modernas, ligeras y sin dependencias pesadas del sistema operativo para garantizar máximo rendimiento y cero conflictos con otros paneles:

### Backend y Motor de Streaming
| Capa / Componente | Tecnología Utilizada | Función en el Panel |
| :--- | :--- | :--- |
| **Entorno de Ejecución** | **Node.js v22 LTS** (aislado en `.runtime/node`) | Motor asíncrono de alto rendimiento capaz de sostener miles de conexiones HTTP/streaming concurrentes con bajo consumo de RAM. |
| **Servidor HTTP / API** | **Express.js 4** + `http.Server` nativo | Enrutamiento REST para el panel administrativo, API Xtream Codes (`/player_api.php`, `/get.php`), Portal MAG Stalker (`/c/`) y entrega de video sin límite de *timeout*. |
| **Base de Datos Principal** | **SQLite 3 Nativa (`node:sqlite`) en modo WAL** | Base de datos transaccional ACID embebida en Node 22 (`data/tvlister.db`). El modo *Write-Ahead Logging (WAL)* permite lecturas y escrituras simultáneas ultrarrápidas sin servidor externo. |
| **Conector Migración XUI.one** | **`mysql2/promise`** + Parser SQL/GZIP (`node:zlib`) | Conecta en modo solo-lectura a MariaDB 10.6 / MySQL por socket Unix local (`/run/mysqld/mysqld.sock`), TCP remoto o archivos `mysqldump` `.sql` / `.sql.gz`. |
| **Transcodificación & DVR** | **FFmpeg** (`libx264`, `h264_nvenc`, `h264_qsv`, `copy`) | Supervisor de procesos con auto-reconexión automática para transcodificar canales, emitir canales 24/7 en HLS real y grabar segmentos **TV Archive / Catchup DVR**. |
| **Entrega VOD Local** | **Motor HTTP `206 Partial Content` (*Byte-Range*)** | Sirve películas/series locales (`.mp4`, `.mkv`, `.ts`, `.avi`) directamente desde el disco del servidor (incluyendo rutas `/home/xui/...`) permitiendo adelantar/retroceder instantáneamente en 4K. |
| **Seguridad y Criptografía** | **`node:crypto` (PBKDF2-SHA256 + HMAC-SHA256)** | Contraseñas de administradores con *salt* y 100,000 iteraciones PBKDF2; tokens de sesión y URLs del proxy HLS firmados con llave secreta HMAC de 256 bits anti-SSRF. |

### Frontend y Reproductor Integrado
| Capa / Componente | Tecnología Utilizada | Función en el Panel |
| :--- | :--- | :--- |
| **Interfaz Administrativa** | **React 18** + **Vite 6** | Aplicación SPA instantánea compilada en *chunks* optimizados (`dist/`) sin recargas de página. |
| **Diseño Visual** | **Tailwind CSS 3** + **Lucide Icons** | Interfaz oscura *TVLister Dark* responsiva (adaptable a PC, tablet y móvil) diseñada para centros de monitoreo NOC 24/7. |
| **Motor de Video Web** | **`hls.js`** + **HTML5 `<video>`** | Reproducción nativa de flujos HLS `.m3u8` (con ABR multi-bitrate) y contenedores MP4 tanto en la vista previa del administrador como en el **Portal Cliente WebTV**. |

### Infraestructura Linux y Despliegue
| Componente | Tecnología Utilizada | Función en el Panel |
| :--- | :--- | :--- |
| **Servicio Demonio** | **`systemd`** (`tvlister24-7.service`) | Arranque automático con el VPS, auto-reinicio en 3 segundos ante fallos y límite ampliado a `LimitNOFILE=524288` descriptores de red. |
| **Consola Operativa** | **Bash CLI (`tvlister-admin`)** | Herramienta en `/usr/local/bin/tvlister-admin` para auditoría (`doctor`), actualizaciones en caliente, SSL, puertos, firewall y backups. |
| **Balanceo Multi-Servidor** | **Agente Edge Node.js (`scripts/edge-agent.js`)** | Nodos secundarios de distribución por **Menor Carga**, **GeoIP por País** o **Afinidad de ISP**. |

---

## 3. Arquitectura de Producción y Coexistencia con XUI.one

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                      Clientes y Dispositivos IPTV                          │
│   • TiviMate / IPTV Smarters / XCIPTV     • Cajas MAG (Stalker /c/)        │
│   • VLC / Kodi / Receptores Enigma2       • Portal Cliente WebTV (HTML5)   │
└──────────────┬────────────────────────┬────────────────────────┬───────────┘
               │ /get.php • /enigma2    │ /player_api.php        │ /xmltv.php
               │ /live • /movie • /c/   │ /panel_api.php         │ /xmltv.xml.gz
               ▼                        ▼                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│            TVLister 24/7 — Motor Central Node.js 22 (Puerto 8095)          │
│  • Firewall IP/User-Agent en Caché + Rate-Limit compatible con CGNAT       │
│  • Control Estricto de Expiración, Conexiones Simultáneas y Bouquets       │
│  • Stream Shield Proxy: Reescribe HLS (.m3u8) con HMAC y enruta MPEG-TS    │
└───────┬──────────────────────────┬──────────────────────────┬──────────────┘
        │                          │                          │
        ▼                          ▼                          ▼
┌───────────────────┐   ┌──────────────────────┐   ┌─────────────────────────┐
│ SQLite 3 (WAL)    │   │ Motor FFmpeg & DVR   │   │ Importador XUI.one      │
│ data/tvlister.db  │   │ • Canales 24/7 HLS   │   │ (Solo-Lectura Segura)   │
│ • Streams / VOD   │   │ • Auto-Wake OnDemand │   │ • Socket MariaDB /xui   │
│ • Líneas / Créd.  │   │ • Catchup Timeshift  │   │ • MySQL Remoto / .sql   │
└───────────────────┘   └──────────────────────┘   └─────────────────────────┘
```

### ¿Cómo convive con XUI.one en el mismo VPS sin romper nada?
1. **Cero uso de `apt-get`:** No actualiza ni toca paquetes del sistema Ubuntu, respetando los repositorios de MariaDB 10.6, PHP compilado y librerías fijadas por XUI.one.
2. **Directorio 100% aislado:** Todo vive en `/opt/tvlister24-7` con su propio Node.js aislado.
3. **Puertos separados:** Mientras XUI.one usa los puertos `80`/`8080`, TVLister corre en el puerto `8095` (o el que elijas con `tvlister-admin set-port`).
4. **Lectura limpia:** Tanto el binario `ffmpeg` como la base de datos `xui` se consultan únicamente en **modo solo-lectura**.

---

## 4. Qué Hace Cada Función del Panel y Cómo Utilizarla

Al iniciar sesión en `http://TU_IP:8095` con tu usuario `admin`, encontrarás en la barra lateral izquierda todos los módulos operativos:

---

### 4.1. Dashboard y Monitor en Tiempo Real
**¿Qué hace?**
Es tu centro de control en vivo (se actualiza automáticamente cada 6 segundos). Muestra:
* **4 Tarjetas KPI:** Conexiones activas en este instante, canales en vivo online, canales 24/7 al aire y total de líneas/catálogo VOD.
* **Estado del Nodo Maestro y Balanceadores:** Uso real de CPU, RAM, tiempo encendido (*uptime*), estado de FFmpeg y nodos Edge conectados.
* **Parrilla "Canales 24/7 Al Aire Ahora":** Indica exactamente qué película o bloque se está transmitiendo en este segundo, barra de progreso y botón de vista previa.
* **Tabla de Conexiones Activas:** Muestra qué cliente está viendo qué canal, desde qué IP, con qué aplicación (*User-Agent*) y protocolo (`HLS`, `MPEG-TS`, `VOD`, `WebTV`).

**¿Cómo utilizarlo?**
* Si el panel está recién instalado y limpio, usa el botón verde **«Importar desde XUI.one»** para traer tu base de datos en 1 clic, o **«Agregar Canal»** / **«Crear Línea»**.
* Para desconectar a un espectador en vivo, pulsa el ícono de papelera roja (**Kick**) en la fila de su conexión.

---

### 4.2. Canales en Vivo (`Canales en Vivo`)
**¿Qué hace?**
Administra todas tus señales de televisión lineal en vivo (`HLS .m3u8`, `MPEG-TS .ts`, `RTMP`, `RTSP` o archivos locales).

**Funciones incluidas:**
1. **3 Modos de Operación por Canal:**
   * **Direct Stream:** Entrega ultrarrápida sin recodificar video (`0% CPU` de transcodificación). Si el *Stream Shield* está activo, pasa por el proxy del VPS ocultando la URL original; si no, redirige por `302`.
   * **On-Demand:** El canal permanece en reposo (`ondemand_idle`). Cuando el primer cliente lo sintoniza, se activa automáticamente; cuando lleva **3 minutos sin espectadores**, vuelve a reposo solo para ahorrar recursos.
   * **Transcode (FFmpeg):** Recodifica el canal en vivo con el perfil elegido (`CPU H.264`, `NVIDIA NVENC`, `Intel QSV`) generando segmentos HLS propios.
2. **URL de Respaldo (*Failover*):** Si la fuente principal cae o da error, el proxy conmuta automáticamente a la `URL de Respaldo`.
3. **Grabación TV Archive / Catchup DVR:** El botón **REC / DVR** graba segmentos en disco durante los días configurados (`tv_archive_days`) para que usuarios en TiviMate o Smarters puedan retroceder programas pasados.
4. **Importador M3U Rápido:** Permite pegar texto `#EXTM3U` o una URL M3U externa para cargar listas masivas.

**¿Cómo utilizarlo?**
1. Haz clic en **«Nuevo Canal»** (o **«Importar M3U»** / **«Importar BD XUI.one»**).
2. Completa Nombre, Categoría, URL Principal (`http://...m3u8` o `.ts`), URL Backup opcional, Logo y ID de EPG (ej. `espn.latam`).
3. Usa el botón **▶ (Play)** de la tabla para previsualizar la señal directamente en el navegador, o el ícono **`>_`** para inspeccionar el comando exacto de FFmpeg.

---

### 4.3. Estudio de Canales 24/7 (`Canales 24/7 Studio`)
**¿Qué hace?**
Te permite crear tus propios canales temáticos continuos (por ejemplo: *Cine Acción 24/7*, *Comedia 24/7*, *Infantil 24/7*) armando una lista de reproducción con películas VOD o enlaces MP4/HLS.

**Dos motores disponibles por canal 24/7:**
1. **Modo Reloj Virtual (`0% CPU`):** Calcula matemáticamente por *epoch Unix* qué película toca en este instante y en qué minuto exacto va, generando además su programación EPG automática.
2. **Modo Worker FFmpeg Continuo (`Auto-Start`):** Lanza un proceso `ffmpeg -re -stream_loop -1 -f concat` persistente que une todos los videos en un flujo HLS `.m3u8` continuo real compatible con cualquier televisor o caja STB. Si el servidor se reinicia, vuelve a arrancar automáticamente.

**¿Cómo utilizarlo?**
1. Haz clic en **«Crear Canal 24/7»**, define nombre, categoría, logo y marca de agua opcional (`Watermark`).
2. Agrega películas desde tu catálogo VOD o pega enlaces MP4/HLS con su duración en segundos, y ordénalos con las flechas `↑` / `↓`.
3. Elige entre **Reloj Virtual** o **FFmpeg HLS Continuo** y guarda. El canal aparecerá automáticamente en las listas M3U, API Xtream y WebTV con su guía de programación calculada al minuto.

---

### 4.4. Películas y Series VOD (`Películas & Series VOD`)
**¿Qué hace?**
Gestiona todo el catálogo bajo demanda dividido en dos pestañas: **Películas (Movies)** y **Series con Temporadas y Episodios**.
* Soporta enlaces remotos (`http://` / `https://`) y **rutas de archivos locales en el disco del VPS** (ej. `/home/xui/content/movies/pelicula.mkv` o `/mnt/vod/pelicula.mp4`) con soporte nativo `HTTP 206 Byte-Range` para adelantar o retroceder sin espera.

**¿Cómo utilizarlo?**
* **Para Películas:** En la pestaña *Películas*, pulsa **«Agregar Película»**, ingresa título, categoría VOD, URL o ruta local, póster, sinopsis, año, género, calificación y extensión (`mp4` / `mkv`).
* **Para Series:** Cambia a la pestaña *Series TV*, crea la serie principal y luego pulsa **«Gestionar Episodios»** para añadir capítulos indicando Temporada (`1, 2...`), Episodio (`1, 2...`) y su fuente de video.

---

### 4.5. Líneas, Dispositivos MAG y Enigma2 (`Líneas, MAG & Enigma2`)
**¿Qué hace?**
Administra las cuentas de acceso de tus suscriptores finales.
* Controla fecha de vencimiento (o sin vencimiento / *Ilimitado*), estado (`Activa` / `Suspendida`), límite estricto de **conexiones simultáneas** (`max_connections`), **Bouquets permitidos** y filtro opcional de **IPs autorizadas**.
* Soporta 3 tipos de cliente:
  1. **M3U / Xtream Codes:** Usuario y contraseña para TiviMate, IPTV Smarters, XCIPTV, VLC, WebTV.
  2. **Dispositivo MAG (Stalker Portal):** Vincula la dirección MAC (`00:1A:79:XX:XX:XX`) para cajas MAG/STB conectadas a `http://TU_IP:8095/c/`.
  3. **Receptor Enigma2:** Compatible con listas M3U y el endpoint dedicado `/enigma2.php`.

**¿Cómo utilizarlo?**
1. Haz clic en **«Nueva Línea M3U»** o **«Agregar MAG»**.
2. Define usuario y contraseña (o déjalos autogenerados), fecha de expiración, conexiones simultáneas y selecciona qué **Bouquets** tendrá habilitados.
3. En la tabla de líneas, haz clic en el botón **«Enlaces / API»** (ícono de cadena) para copiar en 1 clic:
   * URL M3U Plus HLS y MPEG-TS.
   * Datos de acceso **Xtream Codes API** (`Host`, `Usuario`, `Contraseña`).
   * URL del Portal MAG (`/c/`) y Guía EPG (`/xmltv.php`).

---

### 4.6. Bouquets y Categorías (`Bouquets & Categorías`)
**¿Qué hace?**
Organiza tu catálogo comercial:
* **Categorías:** Clasifican el contenido dentro de las apps de tus clientes (*Deportes*, *Cine*, *Noticias*, *Estrenos VOD*, *Series*).
* **Bouquets (Paquetes):** Determinan a qué canales en vivo, canales 24/7, películas y series tiene derecho cada línea. El servidor bloquea con `403 Forbidden` cualquier intento de reproducir un canal que no esté dentro del Bouquet asignado al usuario.

**¿Cómo utilizarlo?**
1. Crea primero tus categorías (`Live`, `24/7`, `VOD`, `Series`).
2. Crea o edita un Bouquet (ej. *Plan Básico*, *Plan Total Premium*), marca las casillas de los canales/películas/series incluidos y guarda.

---

### 4.7. Resellers y Paquetes de Créditos (`Resellers & Paquetes`)
**¿Qué hace?**
Permite delegar ventas a distribuidores (*Resellers*) sin darles acceso a la configuración de tu servidor ni a tus fuentes:
* Cada Reseller inicia sesión en la misma URL del panel pero ve únicamente **su propio panel restringido** (sus créditos disponibles, sus propias líneas creadas y sus conexiones activas).
* **Paquetes Comerciales:** Defines cuánto cuesta crear o renovar una línea (ej. *Prueba 24h = 0 créditos*, *1 Mes = 1 crédito*, *3 Meses = 3 créditos*, *1 Año = 10 créditos*). Cada vez que el reseller genera una línea, el sistema descuenta los créditos automáticamente y guarda el movimiento en el historial auditable.

**¿Cómo utilizarlo?**
1. Crea tus planes en la sección **Paquetes para Resellers**.
2. Crea una cuenta en **Nuevo Reseller** y usa el botón **«+ / - Créditos»** para recargar o ajustar su saldo.

---

### 4.8. EPG (Guía de TV), Mensajes OSD y Reportes (`EPG, OSD & Reportes`)
**¿Qué hace?**
Reúne tres herramientas de experiencia al cliente:
1. **Fuentes EPG XMLTV Automáticas:** Descarga y descomprime guías externas `.xml` o `.xml.gz` (sincronizándolas cada 12 horas automáticamente) y las combina con la guía interna de tus canales 24/7 en `/xmltv.php` y `/xmltv.xml.gz`.
2. **Mensajes en Pantalla (OSD):** Envía avisos emergentes o cintillos informativos en tiempo real (ej. *"Mantenimiento programado"* o *"Tu suscripción vence mañana"*) a todos los espectadores en WebTV/MAG o a un cliente específico.
3. **Bandeja de Reportes (Claims):** Muestra los reportes de falla enviados por los propios clientes cuando un canal presenta *buffering* o caída.

---

### 4.9. Importar XUI.one (`Importar XUI.one`)
**¿Qué hace?**
Conecta con tu base de datos de **XUI.one 1.5.x** o **Xtream UI** para traer tu operación completa sin duplicar registros ni tocar el servicio de XUI.one.

**Ofrece 3 métodos de conexión:**
1. **XUI.one Local Automático (1 Clic):** Detecta `/home/xui` y entra automáticamente al MariaDB local (`xui`) por socket Unix `root`, `/root/credentials.txt` o `/etc/mysql/debian.cnf`.
2. **Conexión MySQL / MariaDB Manual:** Para conectarte indicando IP/Host, puerto (`3306` o `7999`), usuario, contraseña y nombre de base de datos.
3. **Archivo Respaldo `.sql` / `.sql.gz`:** Sube un archivo `mysqldump` desde tu computadora (hasta 250 MB, incluso comprimido en `.gz`) o selecciona un backup existente en `/home/xui/backups/`.

**¿Cómo utilizarlo?**
1. Elige el método (en tu VPS con XUI.one basta el **Modo 1 Automático**) y pulsa **«Conectar y Previsualizar»**.
2. Verás el conteo exacto de canales en vivo, líneas de usuarios, cajas MAG (con decodificación automática de MACs en Base64), películas VOD, series, categorías, bouquets y resellers.
3. Marca las casillas de lo que deseas traer y pulsa **«Importar Streams y Usuarios Ahora»**.
   * *Nota:* Si vuelves a ejecutarlo semanas después, el sistema actualiza por `xui_id` sin duplicar canales ni usuarios existentes.

---

### 4.10. Admin del Sistema, Seguridad, SSL y Backups (`Admin del Sistema`)
**¿Qué hace?**
Se divide en tres sub-pestañas de nivel infraestructura:
1. **Admin del Sistema, SSL & Producción:**
   * **Auditoría de Producción en Tiempo Real (9 puntos):** Revisa clave `admin`, estado del **Blindaje Stream Shield**, catálogo activo, snapshots, SSL, FFmpeg, firma HMAC, SQLite WAL y compilación `dist/`. Incluye el botón **«Activar Blindaje Producción Total (1 Clic)»**.
   * **Ajustes Globales:** Nombre del panel, formato por defecto (`HLS` o `MPEG-TS`), selector de **Stream Shield Proxy Activo vs. Redirección 302**, algoritmo de balanceo y límite anti-flood.
   * **Configurador HTTPS / SSL:** Genera la configuración Nginx + Let's Encrypt lista para tu dominio.
   * **Gestión de Administradores:** Cambio de contraseña `admin` y alta de co-administradores.
2. **Nodos Edge Load Balancer & FFmpeg:**
   * Alta de servidores secundarios Edge con comando de instalación automática en 1 clic (`edge-agent.js`) y creación de perfiles personalizados de transcodificación FFmpeg.
3. **Firewall, Stalker MAG & Snapshots:**
   * Bloqueo inmediato de direcciones IP o *User-Agents* maliciosos.
   * Regeneración de llave de seguridad Stalker y gestión de **Snapshots completos** en servidor (crear, descargar JSON o restaurar en 1 clic).

---

### 4.11. Portal Reproductor WebTV HTML5 para Clientes
**¿Qué hace?**
Es una aplicación de televisión web lista para tus clientes finales (accesible desde el botón **«Abrir WebTV Player»**).
* El cliente inicia sesión con el **Usuario y Contraseña de su Línea** (no con credenciales de admin).
* Incluye canales en vivo, canales 24/7 sincronizados al segundo actual, catálogo de películas y series, buscador instantáneo, sección de **Favoritos**, visualización de **Mensajes OSD**, **Test de Velocidad** contra tu servidor y botón para **Reportar Falla**.

---

## 5. Cómo Conectan tus Clientes Finales (Apps, Smart TV, MAG, Web)

Suponiendo que tu servidor responde en `http://TU_IP:8095` (o `https://tv.tudominio.com`):

| Aplicación / Dispositivo | Cómo configurarlo en el dispositivo del cliente |
| :--- | :--- |
| **TiviMate / IPTV Smarters / XCIPTV / Televizo** | Elegir **Xtream Codes Login**:<br>• **URL del Servidor:** `http://TU_IP:8095`<br>• **Usuario:** *(usuario de la línea)*<br>• **Contraseña:** *(clave de la línea)* |
| **VLC / Kodi / Smart IPTV / OttPlayer (Lista M3U)** | Usar URL M3U Plus:<br>`http://TU_IP:8095/get.php?username=USUARIO&password=CLAVE&type=m3u_plus&output=hls`<br>*(Cambia `output=ts` si prefieres flujo MPEG-TS).* |
| **Guía de Programación EPG (XMLTV)** | Normal: `http://TU_IP:8095/xmltv.php?username=USUARIO&password=CLAVE`<br>Comprimida GZIP: `http://TU_IP:8095/xmltv.xml.gz` |
| **Cajas MAG (250 / 254 / 322 / 420 / Formuler Stalker)** | 1. Registra la MAC `00:1A:79:...` en **Líneas → Agregar MAG**.<br>2. En la caja MAG configura Portal URL:<br>`http://TU_IP:8095/c/` *(o `http://TU_IP:8095/stalker_portal/c/`)*. |
| **Decodificadores Enigma2** | Endpoint XML Bouquet:<br>`http://TU_IP:8095/enigma2.php?username=USUARIO&password=CLAVE` |
| **Navegador Web (PC / Móvil / Smart TV)** | Abrir `http://TU_IP:8095` → pulsar **«Abrir Portal Reproductor WebTV para Clientes»** e ingresar usuario y clave de la línea. |

---

## 6. Consola de Administración por Terminal SSH (`tvlister-admin`)

Cuando entras por SSH como `root` a tu servidor Ubuntu, dispones del comando global **`tvlister-admin`**.

* Ejecutar solo `tvlister-admin` abre el **menú interactivo numerado `[1-14]`**.
* También puedes ejecutar cada acción directamente:

```bash
# Ver IP, puerto activo, estado de systemd y coexistencia con XUI.one
tvlister-admin status

# Auditoría completa de Producción Total (indica qué está OK y qué falta)
tvlister-admin doctor

# Cambiar la contraseña del Super Admin 'admin'
tvlister-admin reset-admin TU_NUEVA_CLAVE_SEGURA

# Activar Blindaje Stream Shield Proxy (TS + HLS), Anti-Restreaming y modo CGNAT
tvlister-admin shield

# Importar Streams, VOD, Series, Bouquets y Usuarios desde XUI.one local (/home/xui)
tvlister-admin import-xui

# Importar desde un archivo de respaldo SQL o SQL.GZ específico
tvlister-admin import-xui /home/xui/backups/respaldo.sql.gz

# Dejar el panel 100% limpio (borra catálogo y líneas, conserva Super Admin y FFmpeg)
tvlister-admin clean

# Programar respaldo automático todos los días a las 03:00 AM en /root (retención 7 días)
tvlister-admin enable-cron

# Crear respaldo inmediato de la base de datos SQLite en /root
tvlister-admin backup

# Cambiar el puerto TCP del panel (ej. a 8895) y abrirlo en UFW + iptables
tvlister-admin set-port 8895

# Configurar proxy inverso Nginx + certificado HTTPS Let's Encrypt
tvlister-admin setup-ssl tv.tudominio.com correo@tudominio.com

# Agregar o quitar puertos adicionales simultáneos (ej. 8880, 25461) sin apagar el principal
tvlister-admin add-port 8880
tvlister-admin remove-port 8880
tvlister-admin list-ports

# Instalar y activar el Servidor de Ingesta RTMP (:1935) + SRT (:8890 UDP) + RTSP (:8554) (Zero-Apt)
tvlister-admin install-ingest

# Actualizar el panel a la última versión de GitHub sin perder base de datos ni puerto
tvlister-admin update

# Reiniciar el motor o ver logs en vivo
tvlister-admin restart
tvlister-admin logs
```

---

## 7. Referencia Técnica de Endpoints y Base de Datos

### 7.1. Endpoints Públicos y de Reproducción
| Método y Ruta | Descripción Técnica |
| :--- | :--- |
| `GET /api/health` | Sonda JSON de salud del motor (`status`, versión, estado WAL, FFmpeg, streams y conexiones). |
| `GET /get.php` | Generador `#EXTM3U` (`output=hls`, `output=ts` o `output=mnf`) con `tvg-id`, `tvg-logo` y `catchup-source`. |
| `GET/POST /player_api.php` | API completa Xtream Codes (`get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg`). |
| `GET /live/:u/:p/:id.m3u8` o `.ts` | Entrega autenticada de canales en vivo y canales 24/7 (`10000 + id`), incluyendo fuentes Flussonic `m4f://` y trunking `mnf://`. |
| `GET /mnf/:u/:p/:id.mnf` | Streaming binario en vivo **MNF v1 (*TVLister Media NanoFrame*)** con overhead `< 0.25%` y ráfaga GOP Keyframe `< 35 ms`. |
| `WS /ws/mnf/:u/:p/:id` | Transporte WebSocket binario en tiempo real del protocolo **MNF v1** para reproductores de ultrabaja latencia. |
| `GET /hls_proxy/:u/:p/:streamId` | Proxy *Stream Shield* de manifiestos HLS y CMAF fMP4 (`#EXT-X-MAP`) firmados con HMAC-SHA256. |
| `GET /hls_out/:u/:p/:key/:file` | Servidor de segmentos `.ts` locales generados por workers de transcodificación FFmpeg. |
| `GET /movie/:u/:p/:id.ext` | Entrega de películas VOD (redirección CDN o streaming local `HTTP 206 Byte-Range`). |
| `GET /series/:u/:p/:epId.ext` | Entrega de episodios de series VOD (redirección CDN o streaming local `HTTP 206 Byte-Range`). |
| `GET /timeshift/:u/:p/:dur/:start/:id.m3u8` | Reproducción diferida *Catchup / TV Archive* a partir de segmentos grabados por epoch. |
| `GET/POST /server/load.php` y `/c/` | Middleware emulador Stalker / Ministra para cajas STB MAG autenticadas por MAC. |

### 7.2. Esquema Principal en SQLite (`data/tvlister.db`)
* **`users`**: Cuentas `admin` y `reseller`, hash PBKDF2, saldo de créditos y `xui_id`.
* **`lines`**: Suscriptores finales, clave, expiración ISO-8601, `max_connections`, tipo (`m3u`, `mag`, `enigma2`), `mac_address`, `bouquet_ids_json`, `allowed_ips` y `xui_id`.
* **`categories`** y **`bouquets`**: Clasificación y paquetes de acceso para canales, 24/7, VOD y series.
* **`streams`**: Canales en vivo, URL primaria y backup (`http`, `m4f://`, `tshttp://`, `mnf://`), modo (`direct`, `ondemand`, `transcode`), perfil FFmpeg, archivo DVR y `xui_id`.
* **`ingest_endpoints`**: Claves de publicación (`stream_key`) para el servidor propio RTMP, SRT y RTSP vinculadas automáticamente a `streams`.
* **`channels_247`**: Canales continuos 24/7, `playlist_json`, `engine_mode` (`virtual` o `ffmpeg`), marca de agua y ancla de tiempo.
* **`vod_items`**, **`series`** y **`series_episodes`**: Biblioteca completa de cine y series con temporadas y capítulos.
* **`active_connections`**: Sesiones en tiempo real para control de simultaneidad y monitoreo en el Dashboard.
* **`transcode_profiles`**, **`servers`**, **`packages`**, **`credit_logs`**, **`epg_sources`**, **`epg_programs`**, **`osd_messages`**, **`client_claims`**, **`firewall_rules`**, **`settings`**.

---

## 8. Módulo Avanzado: Ingesta RTMP/SRT/RTSP, Flussonic M4F, Multi-Puertos y Protocolo MNF v1

Desde el menú lateral **Ingesta, Flussonic & MNF**, el **Panel TVLister 24/7** incluye cuatro pestañas operativas de nivel carrier:

### 8.1. Pestaña 1 — Protocolo Propio Ultraligero MNF v1 (*TVLister Media NanoFrame*)
**¿Para qué sirve?**
* Sustituye las celdas fijas de 188 bytes de MPEG-TS (`.ts`), eliminando paquetes nulos CBR (`0x1FFF`), repetición continua de tablas PSI (`PAT`/`PMT`) y cabeceras PES redundantes.
* Usa una cabecera única de sesión de **12 bytes** (`MNF\x01`) + **9 bytes por cuadro completo** (`< 0.25%` de overhead frente al `10%–18%` de `.ts`), logrando **12% a 18% de ahorro neto de ancho de banda** y **zapping instantáneo `< 35 ms`** gracias a su caché GOP Keyframe en RAM.

**¿Cómo utilizarlo paso a paso?**
1. **Para enlazar dos servidores TVLister ahorrando ancho de banda (*Trunking Inter-VPS*)**:
   * En el **Servidor A (Origen)** crea una línea de enlace (ej. `trunk01` / `clave01`).
   * En el **Servidor B (Borde/Reventa)** ve a **Canales en Vivo → Nuevo Canal** y coloca como URL principal:
     `mnf://IP_SERVIDOR_A:8095/mnf/trunk01/clave01/ID_CANAL.mnf`
   * Entre ambos VPS viajará en binario ultraligero **MNF v1**, y cuando un cliente Smart TV o TiviMate pida `.ts` o `.m3u8` al Servidor B, TVLister lo convierte al vuelo sin gastar CPU en recodificación.
2. **Para exportar una lista M3U completa en protocolo MNF**:
   * Usa `http://TU_IP:8095/get.php?username=USUARIO&password=CLAVE&type=m3u_plus&output=mnf`.
3. **Para medir el ahorro real**:
   * Entra a **Laboratorio de Benchmark en Vivo**, pega opcionalmente cualquier URL `.ts` y pulsa **«Ejecutar Benchmark Ahora»**.

---

### 8.2. Pestaña 2 — Servidor de Ingesta en Vivo (RTMP / SRT / RTSP)
**¿Para qué sirve?**
Convierte tu VPS en un servidor receptor de transmisiones en vivo desde **OBS Studio**, **vMix**, **Larix Broadcaster (móvil)**, encoders **Haivision/Kiloview** o cámaras IP, sin instalar paquetes `apt` del sistema.

**¿Cómo recibir una señal en vivo paso a paso?**
1. Entra a **Ingesta, Flussonic & MNF → Servidor RTMP / SRT / RTSP**.
2. Verifica que el indicador superior diga **EN EJECUCIÓN** (si deseas instalar el binario estático MediaMTX v1.21.3 para empaquetado CMAF `fmp4`, pulsa **«Activar e Instalar Motor RTMP/SRT/RTSP»** o ejecuta `tvlister-admin install-ingest`).
3. En **Crear Nueva Clave de Transmisión**, escribe:
   * **Nombre del Canal / Evento**: Ej. `Evento Deportivo PPV 1`
   * **Stream Key**: Ej. `evento_ppv_01` (y opcionalmente una *Passphrase*)
   * Pulsa **«Crear Punto de Ingesta»**. *(Esto crea automáticamente el canal en **Canales en Vivo**).*
4. Copia la URL según tu transmisor:
   * **En OBS Studio**: Ve a *Ajustes → Emisión → Servicio: Personalizado*:
     * **Servidor**: `rtmp://TU_IP:1935/live` *(o el puerto libre asignado si XUI.one ocupa 1935)*
     * **Clave de transmisión**: `evento_ppv_01`
   * **En vMix / Larix Broadcaster (SRT)**:
     * `srt://TU_IP:8890?streamid=publish:live/evento_ppv_01&pkt_size=1316`
   * **En FFmpeg / Encoder RTSP**:
     * `rtsp://TU_IP:8554/live/evento_ppv_01`
5. Inicia transmisión en OBS/vMix: el punto pasará a verde brillante y todos tus clientes abonados podrán verlo al instante.

---

### 8.3. Pestaña 3 — Importador Flussonic Media Server y Lector `m4f://`
**¿Cómo importar canales desde Flussonic paso a paso?**
1. Entra a **Ingesta, Flussonic & MNF → Importar Flussonic & M4F**.
2. Elige uno de los dos modos:
   * **Conectar por API / URL**: Ingresa `http://IP_FLUSSONIC:8080`, usuario y contraseña de Flussonic.
   * **Pegar `flussonic.conf`**: Pega el contenido de `/etc/flussonic/flussonic.conf`.
3. Selecciona el **Protocolo de Lectura Preferido** (`m4f:// Nativo` recomendado: negocia CMAF `/index.fmp4.m3u8` con failover automático a HLS `/index.m3u8` y `/mpegts`).
4. Pulsa **«Analizar Streams»** y luego **«Importar»**.
5. *Uso directo individual*: También puedes pegar cualquier enlace `m4f://ip:puerto/nombre_canal` directamente en **Canales en Vivo → Nuevo Canal**.

---

### 8.4. Pestaña 4 — Multi-Puertos HTTP / Streaming Dinámicos
**¿Cómo abrir más puertos simultáneos sin apagar el principal (`8095`)?**
* **Desde el Panel Web**: Entra a **Ingesta, Flussonic & MNF → Multi-Puertos HTTP**, escribe el puerto deseado (ej. `8880` o `25461`, o pulsa uno de los botones rápidos ISP) y haz clic en **«Abrir Puerto Ahora»**.
* **Desde SSH (abre además UFW + `iptables` automáticamente)**:
  ```bash
  tvlister-admin add-port 8880
  ```
Tus clientes podrán conectarse indistintamente por `http://TU_IP:8095` o `http://TU_IP:8880` con las mismas credenciales.

---

### 8.5. Motor FFmpeg Eficiente (Alto Rendimiento & Bajo Consumo CPU/RAM)
**¿Cómo lograr 100–300 canales en un solo servidor sin que FFmpeg se coma la CPU?**

Entra a **Servidores / Seguridad → Optimización FFmpeg (Motor de Streaming Masivo)**. Ahí verás en tiempo real:
procesos FFmpeg activos, hilos totales abiertos, RAM total consumida, RAM promedio por canal y si el HLS está
en **RAMDisk (`/dev/shm`)** o en disco.

**Valores por defecto (ya activos, no hay que configurar nada):**

| Perfil del canal | Hilos del proceso | RAM por canal | CPU por canal | Salida |
|---|---|---|---|---|
| `Copy / Copy (Bitrate Original)` | **1** | **~14–16 MB** | **~0.1–0.5 %** | HLS nativo en RAMDisk |
| `Copy Video + Audio Nivelado` | 1 (+1 filtro) | ~20 MB | ~1–2 % | HLS nativo en RAMDisk |
| `Transcode libx264` (720p) | 2 (+1 filtro) | ~65 MB | ~14 % (medido en 2 vCPU) | HLS nativo en RAMDisk |
| Troncal Flussonic (`tshttp://`) | 1 | ~20 MB | ~0.5 % | `-f tee`: HLS + MPEG-TS continuo |
| ProLiant Audio Leveler (`-ram_mpegts_only`) | 1 | ~20 MB | ~0.75–2 % | MPEG-TS puro en RAM (`pipe:1`) |

**Optimizaciones aplicadas automáticamente por TVLister:**

1. **HLS nativo en RAMDisk (`/dev/shm`) con `temp_file` atómico**: 0 IOPS de disco y stdout cerrado
   (`stdio: ignore`), por lo que Node.js no copia ni un byte de vídeo (0 % de carga en el event loop).
2. **`Copy/Copy` Zero-CPU**: 1 hilo del sistema operativo, `-probesize 1000000 -analyzeduration 1000000`,
   `-dn -sn` (descarta subtítulos/DVB) y `-avoid_negative_ts make_zero`. Nunca agrega `-b:v`, `-maxrate` ni
   `-bufsize`: **el bitrate original del stream se mantiene intacto**.
3. **Tope de hilos por encoder (`-threads 2 -filter_threads 1 -filter_complex_threads 1`)**: sin esto FFmpeg
   abre `1.5 × núcleos` por canal (24–72 hilos por canal en un Xeon) y satura la caché L3.
   Medición real en 2 vCPU, 720p: **22.3 % → 13.7 % de CPU y 12 → 6 hilos (−38 % CPU, −50 % hilos)**.
4. **`-x264-params rc-lookahead=0:sync-lookahead=0:ref=1:bframes=0:me=dia:subme=1:trellis=0`** en `ultrafast`
   (≈35–45 % menos CPU en vídeo que el preset por defecto).
5. **`-aac_coder fast`**: 60–75 % menos CPU de audio que el codificador psicoacústico `twoloop`.
6. **`dynaudnorm` acoplado (`n=0`) + `filter_size=8` sin remuestreo** en modo `ultra_200ch` (50 % menos DSP).
7. **Ring buffer circular de 94 KB pre-asignado y zero-copy** para los canales troncales MPEG-TS (sin
   `Buffer.concat` por paquete, sin GC por canal).
8. **Backoff progresivo anti-tormentas** (2.5 s → 5 s → 10 s → 20 s) cuando el proveedor cae, en lugar de
   relanzar FFmpeg 3.5 s después en bucle y multiplicar procesos.
9. **HLS en `/dev/shm` desde 2 GB de RAM** (antes exigía 4 GB), para que VPS pequeños también eviten el disco.

**Interruptores avanzados (se aplican al instante y reinician el motor escalonado cada 60 ms):**

* **Salida MPEG-TS continua (`pipe:1`)**:
  * `Auto` *(recomendado)* — solo los canales troncales Flussonic abren el pipe MPEG-TS.
  * `Siempre` — todos los canales abren `-f tee` (máxima compatibilidad con apps `.ts`, consume más CPU).
  * `Nunca` — 100 % HLS en RAMDisk (máximo ahorro de CPU y RAM).
* **Tope de hilos por encoder H.264**: `1` (máximo ahorro, 200+ canales), `2` (equilibrado, por defecto),
  `4` u `8` (más calidad/FPS para pocos canales 4K).

**API para scripts / automatización:**
```bash
# Consultar métricas reales del motor (procesos, hilos, RAM por canal, prefijo HLS)
curl -s -H "Authorization: Bearer $TOKEN" http://TU_IP:8095/api/system/ffmpeg-efficiency

# Cambiar política (ej. máximo ahorro: sin pipe TS y 1 hilo H.264)
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"tsPipeMode":"never","h264Threads":1}' \
  http://TU_IP:8095/api/system/ffmpeg-efficiency
```
---

### 8.6. Diagnóstico de "Pegones" / Inestabilidad en Canales HD (Corregido)

**Síntoma reportado:** con 145 canales HD recibidos por HLS desde un Flussonic, los clientes veían cortes,
congelamientos y saltos, sobre todo en HD.

**Causas encontradas y corregidas en el motor:**

1. **Bucles de segmentos duplicados para clientes `.ts`** *(causa principal de los "pegones")*.
   Cuando un canal corría en modo HLS nativo, los clientes MPEG-TS (`.ts`) recibían el **último segmento
   completo repetido cada 1 segundo**: el reproductor recibía segmentos repetidos, fuera de orden y con
   huecos de 1 s. En HD (2–3 MB por segmento) eso se traduce en congelamientos y saltos.
   *Ahora* hay un **tailer de segmentos ordenado y deduplicado por `EXT-X-MEDIA-SEQUENCE`**: cada segmento se
   envía **exactamente una vez** y en orden, con lectura en streaming de 64 KB.
   Verificado: 3 clientes `.ts` simultáneos → 100 % de paquetes alineados a 188 bytes y bitrate igual al del origen.

2. **RAMDisk `/dev/shm` sin control de capacidad (ENOSPC)**. Con 145 canales HD la ventana HLS
   (segmento × 6) puede pedir **2–4 GB** de tmpfs; al llenarse, FFmpeg muere y el canal se queda congelado.
   *Ahora* el sistema calcula la necesidad real (`estimateHlsFootprintBytes`) y:
   - sólo usa `/dev/shm` si hay espacio suficiente para **todos** los canales,
   - deriva automáticamente el canal a disco si el RAMDisk baja de **384 MB libres**,
   - muestra en el panel `RAMDisk Libre` vs `Necesario` y avisa en amarillo.

3. **Sonda de entrada demasiado pequeña para HD**. Con `-probesize 1 MB` FFmpeg perdía el SPS/PPS del
   primer segmento en canales de 8–12 Mbps y arrancaba tarde o entrecortado. *Ahora* para fuentes HTTP/HLS
   usa `-probesize 5 MB -analyzeduration 4 s`.

4. **`-avoid_negative_ts make_zero` aplicado también a HLS puro** (micropausas de PTS). Ahora sólo se usa
   cuando de verdad se emite MPEG-TS continuo (`pipe:1`).

5. **Diagnóstico por canal en el panel** (`Servidores → Optimización FFmpeg`): PID, antigüedad del manifiesto
   HLS (si supera 20 s el canal está congelado), reinicios de FFmpeg, suscriptores `.ts` y última línea de
   error real de FFmpeg (capturada con límite de 4 lecturas/s para no gastar CPU).

6. **Botones de reparación inmediata** (*no cortan a todos los usuarios*):
   - **Reparar Canales Congelados**: reinicia sólo los canales con PID caído o HLS detenido (>20 s), escalonado cada 80 ms.
   - **Reiniciar Motor Live & 24/7**: ahora reinicia **de verdad** los procesos FFmpeg (antes sólo actualizaba la fecha).
   - **Copy/Copy sin nivelador → Relay Directo (0 % CPU)**: para 100+ canales HD que **no** necesitan
     ecualización, deja de re-multiplexar en local y los sirve por Relay Directo (Stream Shield).
     Con 145 canales HD esto libera toda la CPU/RAM/pipes del servidor y es la configuración más estable.

7. **Servido de segmentos HLS más robusto**: `Content-Length`, `Cache-Control: public, max-age=10, immutable`
   para segmentos (el reproductor ya no los re-descarga), `Retry-After: 1` en 404 y cierre limpio si el
   segmento rota mientras se envía.

**Recomendación para 145 canales HD desde un solo Flussonic:**
- Si **no** necesitas ecualizar audio, usa **Relay Directo** (0 % FFmpeg) o `Copy/Copy` sólo en los canales
  que realmente lo requieran.
- Mantén `tsPipeMode = Auto` y `h264Threads = 2` (valores por defecto) salvo que tengas pocos canales 4K.
- Vigila `RAMDisk Libre` vs `Necesario`; si el aviso amarillo aparece, amplía `/dev/shm`
  (`mount -o remount,size=8G /dev/shm`) o reduce canales en transcodificación.

### 8.8. Cambio Masivo de IP / Puerto de Origen (migración de proveedor)

Cuando el proveedor cambia de IP o de puerto (por ejemplo un panel/Flussonic que pasa de
`38.226.161.148:8080` a otra IP:puerto), **no hay que editar canal por canal**:

`Streams` → botón **Cambiar IP / Puerto** (barra superior).

1. **IP actual (a buscar)** — la IP vieja, ej. `38.226.161.148`.
2. **Puerto actual (opcional)** — si lo dejas vacío se reescribe la URL en *cualquier* puerto.
3. **IP / dominio nuevo** y **Puerto nuevo** (si lo dejas vacío se conserva el puerto de cada URL).
4. **Alcance**: todos los canales, sólo los seleccionados o la categoría del filtro actual.
5. **Incluir URL de respaldo** / **Incluir URL original-Astra-WK2500** (opcional).
6. **1. Previsualizar** → muestra la URL antes y después de cada canal; **2. Aplicar** → guarda y reinicia
   escalonado sólo los canales que estaban corriendo.

Qué se reescribe exactamente (el resto de la URL **no** se toca):

| Tabla | Columna |
|---|---|
| `streams` | `source_url`, `backup_url` |
| `streams` | `original_source_url`, `astra_local_url` (si se incluye) |
| `wk2500_channels` | `custom_source_url` (si se incluye) |
| `mnf_trunks` | `origin_url` (si se incluye) |

Se conservan esquema, `usuario:clave@`, ruta y query string:

```
http://user:pass@38.226.161.148:8080/live/espn/index.m3u8?token=abc
   -> http://user:pass@45.10.20.30:2095/live/espn/index.m3u8?token=abc
```

Validaciones: la IP/dominio nuevo no admite `http://` ni caracteres raros y el puerto debe estar entre
1 y 65535 (si no, responde `400`). Las fuentes `udp://`, `rtmp://` sólo se tocan si se desactiva
“Sólo fuentes HTTP / HLS”.

Equivalente por API (útil para automatizar):

```bash
curl -s -X POST http://127.0.0.1:8095/api/streams/bulk-replace-host \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"scope":"all","oldHost":"38.226.161.148","newHost":"NUEVA_IP","newPort":"2095","apply":false}'
# Cuando el preview sea correcto, repetir con "apply": true
```

### 8.9. Nota: el panel estilo XUI.one fue retirado (motor FFmpeg original)

La tarjeta **"Segmentación HLS / FFmpeg (Estilo XUI.one)"** (Segment Duration, LList Size, Delete Threshold,
Max Segment Wait, Analysis/Probe, `-f segment`, Show Warnings, Ignore Keyframes, DTS v4, Loopback, Restart on
Audio Loss, Priority Backup) **se eliminó** junto con su API (`/api/system/segments`,
`/api/streams/:id/segments`, `/api/streams/:id/detect-audio`) y el vigilante `streamHealth`.

**Motivo:** priorizar el motor que ya venía funcionando estable y rápido (descrito en §8.5 y §8.6).
El motor actual vuelve a usar valores fijos y probados, sin parámetros experimentales:

```
-probesize 5000000 -analyzeduration 4000000
-fflags +genpts+igndts+nobuffer+discardcorrupt -flags low_delay
-map 0:v:0 -map 0:a:0? -c:v copy -c:a copy
-f hls -hls_time 2 -hls_list_size 6
-hls_flags delete_segments+independent_segments+omit_endlist
```

- Un solo hilo (`-threads 1`) en Copy/Copy, RAMDisk nativo y tailer ordenado de segmentos (§8.6).
- No se aplica `-hls_delete_threshold` ni `split_by_time` ni selección automática de pista de audio:
  se publica la primera pista disponible (`0:a:0?`), igual que antes.
- Las secciones §8.5 (motor eficiente), §8.6 (diagnóstico de pegones) y §8.8 (cambio masivo de IP/puerto)
  siguen vigentes.
