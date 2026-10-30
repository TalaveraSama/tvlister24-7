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

* Ejecutar solo `tvlister-admin` abre el **menú interactivo numerado `[1-16]`**.
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

# Motor FFmpeg: ver binario en uso, versión y las 8 rutas candidatas (XUI.one incluido)
tvlister-admin ffmpeg status

# Fijar el binario: auto | xui | xui44 | xui43 | xui40 | xuilegacy | runtime | bundled | system
tvlister-admin ffmpeg use xui44

# Descargar un FFmpeg estático moderno en /opt/tvlister24-7/.runtime/bin (zero-apt, con respaldo)
tvlister-admin ffmpeg install

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

### 8.10. Corrección de Tirones en el Reproductor (clientes HLS y .ts)

Cinco causas reales encontradas y corregidas, todas fuera del encoder (el motor FFmpeg se dejó igual):

1. **Escrituras SQLite por cada segmento** (`server/iptvApi.js`).
   `recordConnection()` hacía `DELETE` de conexiones viejas + `UPDATE ... datetime('now')` en **cada**
   petición de segmento. Con 145 canales y varios clientes eso son cientos/miles de escrituras por minuto
   en un SQLite síncrono: bloquea el *event loop* de Node y produce microcortes.
   *Ahora*: limpieza cada 30 s y "toque" de conexión cada 20 s por cliente (cache en memoria).
   Se añadieron además los índices `idx_active_conn_line_ip` y `idx_active_conn_ping`.

2. **Caché "immutable" de segmentos** (`/hls_out/.../*.ts`).
   Con `Cache-Control: public, max-age=10, immutable`, al reiniciarse un canal FFmpeg vuelve a escribir
   `index0.ts`, `index1.ts`… y el reproductor **reutilizaba el segmento viejo de su caché** (salto/repetición).
   *Ahora*: `Cache-Control: no-cache` + `ETag` (size-mtime) y `304 Not Modified`: nunca sirve contenido viejo
   y sigue ahorrando re-descargas.

3. **Tailer de segmentos (conversión HLS→MPEG-TS) podía quedarse congelado para siempre**.
   - Si `EXT-X-MEDIA-SEQUENCE` retrocedía (reinicio de FFmpeg), el tailer creía haber enviado todo y el canal
     quedaba mudo hasta que el cliente reconectara. Ahora **se reengancha** solo.
   - Si una lectura no terminaba (archivo reemplazado a media lectura), quedaba bloqueado. Ahora hay
     **watchdog de 20 s** por segmento.
   - Con la cola llena se adelantaba la secuencia y **se perdían segmentos** (huecos). Ahora sólo avanza hasta
     lo realmente encolado.
4. **`.ts` que arrancaba a mitad de segmento**: el reproductor recibía un TS sin PAT/PMT ni keyframe y arrancaba
   a tirones. Ahora el cliente se engancha **en la frontera del siguiente segmento** (o a los 6 s como red de
   seguridad), así el primer paquete siempre incluye PAT/PMT.
5. **Clientes `.ts` que morían al reiniciar el canal**: la suscripción se perdía con el worker viejo.
   Ahora `subscribeWorkerMpegTsAuto()` **reengancha automáticamente** cada 2 s si el canal se reinicia;
   el reproductor ya no necesita reconectar.

**Diagnóstico nuevo** en `GET /api/system/ffmpeg-efficiency` (panel *Optimización FFmpeg*):

| Campo | Qué significa |
|---|---|
| `segmentMisses.total` | segmentos pedidos por el reproductor que aún no existían (cada uno = un hueco visible) |
| `workers[].segmentsProduced` | segmentos generados por el canal desde que arrancó |
| `workers[].tailer` | estado del tailer: `queued`, `reading`, `lastSentSeq`, `sent` |
| `workers[].segmentOpen` | si el tailer está a mitad de segmento (entradas nuevas esperan frontera) |

Si `segmentMisses` sube en un canal, ese canal está produciendo segmentos más lento que su bitrate
(CPU del servidor, red del proveedor o disco del RAMDisk) y ahí es donde el cliente ve el tirón.

**Nota sobre el reparto del flujo `.ts`:** el motor entrega el contenido de cada segmento en cuanto FFmpeg lo
cierra, así que el tráfico va "a golpes" de un segmento (p. ej. 780 KB cada 2 s) en lugar de un chorro continuo.
Es el comportamiento normal de HLS→TS y los reproductores lo amortiguan con su buffer; el bitrate medio es el
del canal (verificado: 465 KB/s ≈ 3,7 Mbps en un canal de 3 Mbps + audio).

### 8.11. Sección "Motor FFmpeg" (ajustes del motor de TVLister)

Menú lateral → **Motor FFmpeg** (`activity`). Es la sección donde se afinan los parámetros reales del motor,
sin depender de perfiles por canal. Todo se guarda en `settings` y se aplica **reiniciando los canales uno por
uno** (80 ms de separación), nunca a la vez.

**API**

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/api/system/ffmpeg-engine` | Configuración efectiva, presets, límites, estado (canales activos/congelados, RAMDisk, segmentos faltantes) y **comando real de FFmpeg** |
| `PUT` | `/api/system/ffmpeg-engine` | Guarda y aplica. Acepta `preset` (`masivo`, `equilibrado`, `calidad`, `latencia`) o campos sueltos |

**Parámetros**

| Ajuste | Clave | Rango | Por defecto |
|---|---|---|---|
| Probe Size HTTP/HLS | `ffmpeg_probe_http` | 1–20 MB | 5 000 000 |
| Analysis Duration HTTP/HLS | `ffmpeg_analyze_http` | 1–20 MB (µs) | 4 000 000 |
| Probe Size local/UDP | `ffmpeg_probe_local` | 0,2–8 MB | 1 500 000 |
| Analysis Duration local/UDP | `ffmpeg_analyze_local` | 0,2–8 MB (µs) | 1 500 000 |
| Duración de segmento HLS | `ffmpeg_hls_time` | 1–10 s | 2 |
| Segmentos en el manifiesto | `ffmpeg_hls_list_size` | 3–12 | 6 |
| Reserva de RAMDisk | `ffmpeg_ram_reserve_mb` | 64–4096 MB | 384 |
| Hilos H.264 | `ffmpeg_h264_threads` | 1–16 | 2 |
| Nivel de log | `ffmpeg_log_level` | `warning` \| `error` | `warning` |
| Intervalo del tailer | `ffmpeg_tailer_interval_ms` | 80–500 ms | 160 |
| Segmentos iniciales del tailer | `ffmpeg_tailer_burst` | 1–4 | 2 |
| Entrar en frontera de segmento | `ffmpeg_ts_join_segment` | bool | `true` |
| Salida MPEG-TS continua | `ffmpeg_ts_pipe_mode` | `auto` \| `always` \| `never` | `auto` |

**Presets**

- **200+ canales · ahorro extremo**: TS `never`, 1 hilo, log `error`, tailer 200 ms.
- **Equilibrado (recomendado)**: lo que viene por defecto (TS `auto`, 2 hilos, log `warning`).
- **Máxima calidad**: 4 hilos, segmento de 4 s.
- **Baja latencia**: segmento de 1 s, lista 4, tailer 100 ms, 1 segmento inicial.

**Qué toca cada ajuste en la línea de comandos**

```
-probesize <probeHttp> -analyzeduration <analyzeHttp>   (HTTP/HLS)
-probesize <probeLocal> -analyzeduration <analyzeLocal> (UDP/RTMP/archivo)
-loglevel <warning|error>
-hls_time <hlsTime> -hls_list_size <hlsListSize>
-threads 1 (copy) | -threads <h264Threads> (libx264)
```

Además, sin reiniciar nada: la **reserva de RAMDisk** decide cuándo un canal nuevo se escribe en `/dev/shm` o pasa
a disco, y el **tailer** usa el intervalo/burst configurados para convertir HLS a MPEG-TS.

**Verificado:** con `hlsTime=3`, `hlsListSize=5`, `logLevel=error`, `probeHttp=6000000` se comprobó en
`/proc/<pid>/cmdline` que el worker real arranca con `-loglevel error -probesize 6000000 -analyzeduration 5000000
-hls_time 3 -hls_list_size 5`, y la API rechaza valores fuera de rango con `400`.

### 8.12. Sección UDP / CATV analógico (WK2500, canales 2–125)

Módulo `server/wk2500Manager.js` + página `src/pages/Wk2500CatvPage.jsx`. Convierte los canales del panel
(HLS/TS/M4F/MNF) en **un SPTS MPEG-TS por canal** y lo entrega por UDP al modulador IP→analógico WK2500.

**Grilla y direccionamiento**

- 124 slots fijos: **CH 2 al 125**, con frecuencia y audio estándar NTSC calculados por canal.
- Los slots se reparten entre **uno o varios moduladores** según el modelo de cada equipo (32, 64 o 125
  canales). Ver §8.22.
- Dirección por defecto en multicast: `239.25.0.<canal>` puerto `5000 + canal`, TTL 16.
- TTL, Service ID, host/puerto, perfil y NIC de salida son editables **por canal**.
- Trailer NIT/SDT: el `service_id` del canal viaja en la SDT y en el PAT (`Program = catv_ch`), con
  `-mpegts_pmt_start_pid 0x0100` y video en `0x101` / audio en `0x102`. Así cada canal se identifica solo en el modulador.

**Dos motores de salida (eligen solos)**

| Motor | Cuándo se usa | Qué hace |
|---|---|---|
| `direct_dgram_1316` (Node) | `direct_spts` sin `muxrate` y origen MNF/TS por HTTP | Descarga el TS y lo reempaqueta en datagramas de **1316 bytes** (7×188) con `Ts1316Packetizer`; bind a la NIC dedicada, `setMulticastTTL/Interface`, buffer de envío 1 MB |
| `ffmpeg_spts_1316` | HLS, M4F, `muxrate`, perfiles con audio nivelado o NTSC | FFmpeg muxea a `udp://host:puerto?pkt_size=1316&ttl=..&localaddr=<NIC>` |

**Perfiles de salida**

- `direct_spts` — copia video y audio sin tocar nada (mínimo CPU).
- `copy_mp2_leveled` — video copiado + audio **nivelado** a MP2 192k (lo que espera la mayoría de moduladores).
- `copy_aac_leveled` — video copiado + audio nivelado AAC 128k.
- `ntsc_sd_wk2500` — transcode seguro: yadif → 720×480 @ 29.97, H.264 Main L3.1 ultrafast zerolatency 1800k, MP2 192k.
- `muxrate_kbps > 0` fuerza **CBR** (relleno de null packets) para canales de ancho fijo.

**Validaciones añadidas (2026-10)**

Antes el panel aceptaba cualquier cosa y el canal quedaba mudo o, peor, dos canales escribían al mismo
`grupo:puerto` mezclando dos TS en el modulador. Ahora la API responde `400/409` con el motivo:

- IPv4 destino válida y puerto entero 1–65535.
- **Destino `host:puerto` único**: si otro canal ya lo usa → `409` indicando qué canal lo tiene.
- `output_mode` sólo entre los cuatro perfiles soportados.
- `local_interface_ip` debe existir en el servidor (se listan las IPs disponibles).
- `service_id` 1–65535 y `ttl` 1–255.
- `bulk-configure`: puerto base válido, rango sin salirse de 65535, IP de grupo para multicast (y unicast
  rechaza grupos), sin colisiones dentro del rango ni contra otros canales.
- `dedicated-interface`: no deja aplicar una IP que no exista en el servidor (eso rompía el bind de todos los canales).

**Telemetría por canal**

El motor FFmpeg se lanza con `-progress pipe:1` y el worker lee `total_size` para calcular los **Mbps y paquetes
realmente enviados** al WK2500 (antes mostraba un valor fijo de 2600 kbps y 0 paquetes cuando el flujo iba por FFmpeg).
El plan refresca cada 4 s: estado (`connecting`/`streaming`/`reconnecting`), motor, kbps, paquetes, uptime y último error.

**Verificado en laboratorio (loopback + NIC real)**

- `direct_spts` por FFmpeg: 3.2–3.5 Mbps, 100 % de paquetes alineados a 188 bytes, 0 errores de continuidad.
- Nivelador MP2: entra AAC, sale MP2 192k (PID `0x102`), video intacto.
- `ntsc_sd_wk2500`: 720×480 @ 29.97, 2.1 Mbps, MP2 192k — perfil aceptado por el WK2500.
- `muxrate 4000`: salida medida **4002 kbps** constante con null packets `0x1FFF`.
- Multicast real (`239.25.0.4/5` por `eth0`): 2.5 y 1.9 Mbps, `Program/Service_id = canal`, 100 % sync.
- `-progress`: `3447 kbps / 5083 paquetes` en el panel, creciendo en tiempo real.

### 8.13. Bucle de respaldo global retirado (respaldo sólo por canal)

Antes, si un canal se caía, el panel reproducía una imagen o video en bucle **en todos los canales** desde un
único ajuste global (`/api/slates/config`, botón "Bucle Sin Stream"). Eso ya no existe.

**Qué cambió**

- Se eliminó el ajuste global y su modal. Los endpoints `GET/PUT /api/slates/config` ya no responden
  (sólo queda `GET /api/slates/files` para listar los archivos subidos y poder elegirlos por canal).
- `resolveEffectiveSlateForStream()` sólo devuelve un respaldo si el **propio canal** tiene
  `offline_slate_mode = custom_image | custom_video` y una URL. Cualquier otro valor (`global`, `builtin`,
  vacío, `disabled`) significa **sin respaldo**.
- El valor por defecto al crear un canal es `disabled`, y una migración convierte los canales existentes
  con `global`/`builtin` a `disabled` al arrancar.
- Si el archivo local del respaldo se borra, el canal se considera sin respaldo (no queda en negro).
- Los presets masivos (Copy/Copy, Zero Latency, Directo) ya no activan ningún bucle.

**Cómo queda el comportamiento**

| Ajuste del canal | Si el origen falla |
|---|---|
| Sin respaldo (`disabled`, valor por defecto) | El reproductor recibe el `503` real del canal |
| Imagen propia en bucle | Se sirve el HLS del bucle (header `X-TVLister-Fallback: offline-slate-loop`) |
| Video propio en bucle | Igual, con el video en loop |

**Verificado:** canal con origen roto y modo `disabled` → `HTTP 503` sin bucle; el mismo canal con
`custom_image` y un PNG subido por `/api/slates/upload` → `HTTP 200` con el manifiesto del bucle;
`modo global/builtin` resuelve a sin respaldo; canal nuevo creado por API nace en `disabled`.

### 8.14. SOURCE 2: dormido por defecto, con conmutación automática opcional

Cada canal tiene **un source activo**. Opcionalmente el administrador puede **agregar un segundo source**
a ese canal concreto; se guarda **dormido**: no se abre, no se sondea y no consume ancho de banda.

Desde esta versión el canal puede activar **“Conmutar solo si SOURCE 1 cae”** (ver 8.19). Si no se
activa, el comportamiento es el histórico: el source 2 sólo entra cuando el operador pulsa **⇄**.

**Cómo se agrega**

En **Canales en Vivo → Editar canal**, debajo de *“URL Fuente Principal”* hay un botón
**“+ Agregar Source”**. Al pulsarlo aparece el campo *“Source 2 (manual)”* con su botón **Quitar**.
Se guarda en `streams.backup_url` (se aplica `trim`, un valor vacío significa “sin source 2”).

**Qué hace el motor**

| Situación | Comportamiento |
|---|---|
| El canal tiene source 2 guardado | El worker **sigue emitiendo el source original**; el 2 no se abre, no se sondea y no consume ancho de banda |
| El source original se cae **sin** conmutación automática | El canal queda caído. **No** salta al source 2. NO hay reintentos hacia el source 2 |
| El source original se cae **con** conmutación automática activada | Tras ~30 s sin señal el canal pasa solo al source 2 (mismo mecanismo que ⇄); el source 2 sólo se abre en ese momento |
| El operador quiere usar el source 2 | Pulsa **⇄** en la fila del canal: se intercambian las URL y el worker se reinicia (~120 ms). Otra pulsación lo regresa |

Se eliminaron por completo: el interruptor global `failover_enabled`, el failover automático
(`resolveStreamInputForAttempt`), la sonda de recuperación de 60 s y el scheduler asociado.

**API**

- `POST /api/streams/:id/switch-source` `{ target: "backup" | "primary" }` — cambio manual de source.
- `POST /api/streams/switch-source-bulk` — el mismo cambio para varios canales (sólo API, sin botón en la UI).
- La columna `streams.failover_active` sólo indica que el canal está emitiendo su source 2 de forma manual.

**Verificado**

- Con el source original sano: 6 peticiones servidas por el original y **0 peticiones al source 2**.
- Con el source original caído: `0/5` peticiones servidas y el source 2 recibió **0 peticiones** (no entra solo).
- Tras pulsar ⇄: las peticiones pasan al source 2 (`{40272: 3}`), y el source original queda guardado como 2.
- Todos los intentos de FFmpeg (`attempt 0,1,2,5,9`) usan la misma URL del source activo; nunca el 2.
- Canal CATV del modulador: el proceso arranca con la URL del source activo, no con el 2.

### 8.15. Auditoría de fuentes y limpieza de SOURCE 2 (evitar sesiones duplicadas)

En **Canales en Vivo → botón “Fuentes”** hay un resumen de **de quién jala cada canal**:

- Tabla por host con dos columnas: **como principal** y **como respaldo**.
- Contadores: canales totales, canales con segundo origen y canales donde el respaldo apunta al
  **mismo host** que el principal (esos no aportan nada y generan una conexión extra).
- Botón **“Quitar respaldos de este host”** por fila y **“Quitar TODOS los respaldos”** al pie.
  Nunca toca el origen principal del canal; sólo vacía `backup_url` (y `failover_active`).

**Por qué importa (caso Astra):** cuando el respaldo de los 145 canales apuntaba al Astra local, el
servidor de Astra mostraba **dos sesiones por canal** — la del `TVLister/2.3` (panel pidiendo el respaldo) y
la del `Streamer 23.12` (Flussonic local jalando del Astra). Como el SOURCE 2 es manual (8.14) el panel
ya no abre esa sesión por su cuenta; y con esta auditoría puedes borrar esos sources viejos de una sola vez.

**API**

- `GET /api/streams/source-audit` — hosts con conteo de principal/respaldo, nombres de ejemplo y
  `sameHostPrimaryAndBackup`.
- `POST /api/streams/purge-second-sources` — `{ host?: "192.168.88.10", dry_run?: true, only_same_host?: true }`.
  Acepta la IP con o sin puerto y devuelve cuántos canales se limpiarían o se limpiaron.

**Verificado** con 7 canales de prueba (6 con Flussonic nube como principal, 5 con respaldo Astra, 1 con
respaldo de otro proveedor y 1 repetido): la auditoría reportó `principal:6 / respaldo:5` para cada host,
el `dry_run` avisó `wouldClear: 5` sin escribir, “redundantes” limpió 1, el borrado por host limpió 4 y
dejó intacto el respaldo del otro proveedor.

### 8.16. Skin de la lista de canales (estructura UI tomada de XUI.one)

La pantalla **Canales en Vivo** usa ahora la misma estructura de UI que el panel de XUI.one
(`page-title-box` + card + filtros colapsables + tabla densa con menú de acciones por fila +
selector de "entries" y paginación), adaptada a la paleta oscura de TVLister. **No cambia ninguna
regla de emisión**: sigue sin failover y el SOURCE 2 sigue siendo manual (8.14).

Componentes nuevos en `src/components/StreamsSkin.jsx` (sólo presentación, sin lógica de datos):

- `StatusPill` — píldora de estado (`Online` / `On-demand` / `Detenido`) con **uptime** `up 3d 04h`
  calculado desde `uptime_started_at`, refrescado cada 30 s.
- `Chip` — insignias compactas (SOURCE 2, COPY/COPY, AUDIO IGUAL, PROLIANT, FHD/HD/SD, respaldo).
- `IconAction` / `RowMenu` — botones de acción por canal y menú **⋯** (medir resolución, comando
  FFmpeg, cambiar de source, ordenar en la parrilla, eliminar). El menú se dibuja en un **portal**
  con posición `fixed`, así no lo recorta el scroll horizontal de la tabla.
- `Segmented` — filtro rápido Todos / Online / Detenidos / SOURCE 2.
- `Pager` — "Mostrar 25/50/100/250 canales" + `Página N / M`.
- `Dropdown` — menú **Herramientas** del encabezado, donde se agruparon los 12 botones sueltos que
  antes ocupaban dos filas (Ordenar canales, Auto-Resolución, Audio Igual, Copy/Copy masivo,
  Edición masiva, Cambiar IP/Puerto, Fuentes, Perfiles FFmpeg, Borrar masivo, BD XUI.one, M3U).
  Toda la funcionalidad se conserva; sólo cambió de sitio.

Estructura de columnas de la tabla (equivalente a la de XUI `ID · Icon · Name · Source · Servers ·
Clients · Uptime · Actions`):

| Columna | Contenido |
|---|---|
| `#` | Orden de parrilla + flechas de subir/bajar, con `ID` real debajo |
| Canal | Logo 32 px, nombre, insignia SOURCE 2 y categoría · servidor |
| Fuente | Host del source activo (URL completa en el tooltip) y botón `Usar SOURCE 2` / `Volver a SOURCE 1` |
| Modo & Perfil | `direct`/`ondemand`/`transcode`, COPY/COPY, AUDIO IGUAL, PROLIANT, resolución + perfil y bitrate |
| DVR / Respaldo | Botón REC (catchup), segmentos/MB y estado del respaldo por canal |
| Estado | Píldora de estado + uptime |
| Acciones | Previsualizar, Iniciar/Detener, Editar y menú ⋯ |

Extras de la vista:

- **Vista agrupada por categoría** (equivalente a `streams_grouped` de XUI): cabecera por categoría
  con el número de canales; al activarla se ordena por categoría (no pagina) y el pie ofrece
  "Volver a lista paginada".
- La paginación se reinicia a la página 1 al cambiar búsqueda, categoría, resolución, estado u orden.
- El buscador y los filtros se aplican sobre el catálogo completo; "Seleccionar todos" sigue
  marcando los canales filtrados (no sólo la página visible).

### 8.17. Paridad con XUI.one ampliada: clientes, EPG, notas y ficha del canal

Todo lo que XUI.one muestra en su tabla de streams (`ID · Icon · Name · Source · Servers · Clients ·
Uptime · Actions` + columna EPG) y en su página `stream_view`, portado a TVLister sin tocar la lógica
de emisión (sigue sin failover; SOURCE 2 sigue siendo manual, ver 8.14).

**Backend**

| Cambio | Detalle |
|---|---|
| `GET /api/streams` (enriquecido) | Cada canal trae ahora `clients` (sesiones activas en `active_connections` con `target_type='live'`), `clients_by_protocol` (`{HLS:2, TS:1}`), `epg_now`, `epg_next`, `epg_now_end`, `epg_next_start` y `epg_progress` (0–100 % del programa en curso). Ejecuta `pruneStaleConnections()` antes de contar, así el número es real. |
| `streams.notes` | Columna nueva (`TEXT`), migrada con `ensureColumn`; aceptada en `POST /api/streams` y `PUT /api/streams/:id` (máx. 2000 caracteres). |
| `GET /api/epg` | Acepta `channel_id` (epg_channel_id), `hours_back`, `hours_ahead` y `limit`. Sin `channel_id` responde igual que antes (compatible). |
| Formatos de fecha EPG | TVLister guarda la EPG en ISO (`toISOString()`); otros importadores usan `datetime('now')`. Ambas se normalizan en SQL con `substr(replace(campo,'T',' '),1,19)` antes de comparar. |

**UI (Canales en Vivo)**

- Columna **EPG · Ahora**: programa en curso, barra de progreso y "Después: …"; si no hay EPG avisa
  `sin EPG` / `Sin EPG cargado`.
- Columna **Clientes**: número de sesiones viendo el canal (verde si > 0) y desglose por protocolo.
- **Notas internas**: se editan en el modal del canal, se buscan desde el buscador, se marcan con un
  ícono en la fila y se leen completas en la ficha.
- **Vistas rápidas**: `Todo el catálogo`, `Sin señal`, `Sin clientes`, `Sin SOURCE 2`, `Sin logo`,
  `Sin EPG`, `Sin clasificar`, `Con notas` — cada una con su conteo.
- **Menú Vista**: densidad de filas (compacta / normal / cómoda), qué columnas se ven y
  auto-actualización cada 15 s (los contadores de clientes y el avance del EPG se refrescan solos,
  sólo si la pestaña está visible).
- **Ficha del canal** (`src/components/StreamDrawer.jsx`), equivalente a `stream_view` de XUI, con
  panel lateral y pestañas: **Resumen** (estado, uptime, perfil, bitrate, resolución, DVR, respaldo,
  notas y "ahora en pantalla"), **Fuentes** (SOURCE 1 y SOURCE 2 con host y URL completa + botón de
  cambio manual), **Clientes** (línea, IP, país, protocolo y hora de conexión, sólo de ese canal),
  **EPG** (programación del canal) y **FFmpeg** (comando real del motor estable, con botón copiar).
  Se abre pulsando el nombre del canal o "Ver ficha del canal" en el menú ⋯.
- **Atajos**: `/` enfoca el buscador; `Esc` limpia la búsqueda o cierra la ficha.

### 8.18. Capa de entrega estilo XUI.one: binarios FFmpeg versionados y prebuffer

Lo único que se toma del *pipeline* de XUI.one es la **entrega al cliente**, nunca la línea de
argumentos del motor (que sigue estable, ver 8.11). Se aplica en `server/streamEngine.js`,
`server/iptvApi.js`, `server/index.js` y en la página **Motor FFmpeg**.

**a) Registro de binarios FFmpeg (paridad con `ffmpeg_cpu` de XUI.one)**

XUI.one instala tres compilaciones (`/home/xui/bin/ffmpeg_bin/{4.4,4.3,4.0}/ffmpeg`) y elige
según `ffmpeg_cpu`, usando 4.0 para GPU/NVENC y audio AC3/DTS heredado. TVLister ahora las detecta
y las reutiliza tal cual (zero-apt: no descarga ni instala nada).

| Binario | Ruta | Cuándo aparece |
|---|---|---|
| `env` | `$FFMPEG_PATH` | Si el servicio define la variable |
| `runtime` | `/opt/tvlister24-7/.runtime/bin/ffmpeg` | Instalación zero-apt de TVLister |
| `xui44` | `/home/xui/bin/ffmpeg_bin/4.4/ffmpeg` | XUI.one 1.5.x (valor por defecto de `ffmpeg_cpu`) |
| `xui43` | `/home/xui/bin/ffmpeg_bin/4.3/ffmpeg` | XUI.one con `ffmpeg_cpu=4.3` |
| `xui40` | `/home/xui/bin/ffmpeg_bin/4.0/ffmpeg` | GPU/NVENC y fuentes AC3/DTS |
| `xuilegacy` | `/home/xui/bin/ffmpeg/ffmpeg` | Instalaciones antiguas de XUI.one |
| `bundled` | `node_modules/@ffmpeg-installer/...` | Último recurso del paquete |
| `system` | `ffmpeg` del `PATH` | Servidor con FFmpeg del sistema |

- `getFfmpegBin()` resuelve la preferencia guardada en `settings.ffmpeg_bin_preference`
  (`auto` = orden histórico del motor: `env → runtime → 4.4 → 4.3 → 4.0 → bin/ffmpeg → empaquetado → PATH`).
  Si el binario elegido desaparece, **cae solo al orden automático**: un canal nunca se queda sin FFmpeg.
- `LD_LIBRARY_PATH` se compone automáticamente para los binarios de XUI (`/home/xui/bin/ffmpeg`,
  `/home/xui/lib` y el directorio de la versión).
- `GET /api/system/ffmpeg-engine` devuelve `binInfo` (binario en uso, versión real, idioma de origen)
  y `binaries` (las 8 rutas con `ok`, `version`, `sizeMb` y motivo del fallo).
- `PUT /api/system/ffmpeg-engine` acepta `binPreference`; cambiarlo invalida la caché y reinicia los
  canales de forma escalonada. `POST /api/system/ffmpeg-binaries/scan` fuerza una re-detección
  (útil después de actualizar XUI.one o `.runtime`).
- La línea de argumentos **no** cambia: el binario sólo sustituye el ejecutable.

**b) Prebuffer de entrega (`X-XUI-Prebuffer`)**

XUI.one, al servir `/admin/live`, manda primero los segmentos ya escritos para que el decodificador
arranque con imagen. TVLister replica el efecto sin duplicar datos en vivo:

| Ajuste | Rango | Por defecto | Efecto |
|---|---|---|---|
| `prebufferSegments` (`ffmpeg_prebuffer_segments`) | 0–6 | `0` (apagado) | Segmentos mínimos antes de entregar el manifiesto y tamaño del burst inicial del tailer MPEG-TS |
| `prebufferWaitMs` (`ffmpeg_prebuffer_wait_ms`) | 500–15000 | `3000` | Tope de espera cuando el canal acaba de arrancar |

- El reproductor puede pedirlo por su cuenta: cabecera `X-XUI-Prebuffer: 1` (usa el valor
  configurado, o 3 si está en 0) o `?prebuffer=3` (1–6). Sin cabecera ni parámetro se respeta el
  ajuste del motor, así que con `0` el comportamiento es exactamente el validado.
- Respuesta del manifiesto: `X-TVLister-Prebuffer`, `X-TVLister-Prebuffer-Wait` (ms reales) y
  `X-TVLister-Prebuffer-State: ready|timeout`. Si se agota la espera se sirve lo que haya: nunca se
  deja al reproductor sin respuesta.
- En MPEG-TS el prebuffer se traduce al **burst inicial del tailer** (`max(tailerBurst,
  prebufferSegments)`), que entra en frontera de segmento: no hay paquetes duplicados ni saltos.
- Las respuestas `.ts` llevan `X-Accel-Buffering: no` (no acumular búfer si hay nginx delante).
- Estadísticas de los últimos 5 minutos en `GET /api/system/ffmpeg-efficiency` → `prebuffer`
  (`waits`, `satisfied`, `timedOut`, `avgMs`) y en las tarjetas de la página **Motor FFmpeg**.

**c) Administración desde SSH (`tvlister-admin ffmpeg`)**

| Comando | Qué hace |
|---|---|
| `tvlister-admin ffmpeg status` | Binario en uso, versión, procedencia, preferencia y tabla de las 8 rutas candidatas con su versión real |
| `tvlister-admin ffmpeg use <id\|auto\|xui>` | Guarda `ffmpeg_bin_preference` en la base de datos (`xui` elige la mejor compilación de XUI.one disponible) |
| `tvlister-admin ffmpeg install` | Descarga un FFmpeg estático (GitHub 6.1.1 → johnvansickle → paquete npm como espejos), lo deja en `.runtime/bin/ffmpeg`, respalda el anterior y fija la preferencia `runtime` |

El instalador (`install_ubuntu.sh`) ya no se queda con `bin/ffmpeg` de XUI.one: detecta
`ffmpeg_bin/4.4`, `4.3` y `4.0` y genera un **wrapper auto-reparable** en `.runtime/bin/ffmpeg` que
vuelve a elegir el binario en cada ejecución (si XUI.one cambia de versión, sigue funcionando).

**Verificado** con un origen HLS real en el sandbox: `?prebuffer=6` con la ventana llena →
`Wait: 0 / ready`; canal frío con `prebufferWaitMs=3000` → `Wait: 3014 / timeout` sirviendo los
segmentos disponibles; canal frío con `prebufferWaitMs=12000` → `Wait: 4060 / ready` con 3 segmentos;
binario elegido inexistente → sigue emitiendo con el automático.

### 8.19. Bouquets en la ficha del canal y conmutación automática a SOURCE 2

**a) Bouquets / Paquetes en el modal del canal**

La tabla `bouquets` guarda los canales como array de ids (`stream_ids_json`). El modal **Editar Canal**
ahora tiene la sección **Bouquets / Paquetes**: un chip por bouquet con su conteo de canales; se marca
o desmarca y el canal queda incluido/excluido al guardar.

- `GET /api/bouquets` alimenta la lista (se recarga junto con el catálogo).
- El formulario envía `bouquet_ids: [1,2]`; `POST /api/streams` y `PUT /api/streams/:id` llaman a
  `applyStreamBouquets()`, que **sólo** reescribe los bouquets cuyo estado cambia (el resto ni se toca).
- En alta, si no se envía `bouquet_ids` se mantiene el comportamiento anterior (entra al primer bouquet).
- Una línea sin bouquet asignado sigue viendo el catálogo completo (regla existente de `isItemAllowedForLine`).

**b) Conmutación automática (SOURCE 2 dormido)**

Campo nuevo `streams.auto_failover` (0/1, migrado con `ensureColumn`) y toggle en el bloque *Source 2*
del modal: **“Conmutar solo si SOURCE 1 cae”**. El resto del tiempo el respaldo está dormido.

Monitor `server/autoFailover.js` (revisión cada 10 s, sólo canales con `auto_failover=1`, `status='running'`
y `backup_url` no vacío):

| Tipo de canal | Cómo se detecta la caída | Coste de red |
|---|---|---|
| `transcode` (worker propio) | PID ausente o manifiesto HLS congelado > 25 s | **cero** (sólo estado del motor) |
| `direct` / proxy | Sonda HTTP mínima al origen **activo** (2 KB, `Range: bytes=0-2047`, cada 30 s) | ~2 KB por minuto |
| Fuentes no HTTP (udp/rtmp/mnf) | No se sondean: se asumen vivas para no conmutar en falso | cero |

Secuencia: 3 revisiones seguidas con caída (≈30 s) → se ejecuta **el mismo cambio que el botón ⇄**
(intercambio de URL + `failover_active` + reinicio del worker). Entre cambios hay un **enfriamiento de
120 s** y, si se acumulan **3 conmutaciones en 15 minutos** (los dos orígenes están fallando), el monitor
**se bloquea** con el estado `ERROR` y el motivo en el panel hasta que la ventana se vacíe: así no se
reinicia el canal en bucle. Si el respaldo también falla estando activo, el monitor **regresa al origen
original** (nunca se queda atrapado en un respaldo muerto); la vuelta por recuperación del principal es
manual. El respaldo **nunca** se sondea mientras está dormido.

UI: en la columna *Fuente* aparece el badge **AUTO** con semáforo y estado (`VIGILANDO`, `CAÍDO`,
`CONMUTADO`, `ERROR`); el chip del nombre cambia a **SOURCE 2 ACTIVO** mientras emite el respaldo.
`GET /api/streams` expone `auto_failover` y `failover_health` (`state`, `reason`, `switchedTo`,
`lastSwitchAt`) por canal.

**Verificado de punta a punta** con dos orígenes HLS reales: el respaldo recibió **0 peticiones a
`index.m3u8`** mientras el principal emitía; al matar el principal el canal conmutó en ~24–50 s (nuevo
worker, HLS fresco, `failover_active=1`); al morir el respaldo volvió solo al principal en ~24 s. El
bloqueo anti-rebote se probó con un tick acelerado: 2 conmutaciones y luego `ERROR` con
“conmutaciones repetidas”, liberándose al vaciarse la ventana. Bouquets: asignar `[1,2]` y luego `[2]` actualizó ambos sin
tocar el resto del catálogo.

### 8.20. Diagnóstico de reproducción por canal (origen → motor → entrega)

Cuando un canal “no se ve”, el panel ya no se limita a decir *“La fuente de origen no respondió”*:
prueba el recorrido completo **desde el servidor** y devuelve dónde se corta.

**Cómo se usa:** en *Canales en Vivo*, menú **⋯ → Diagnosticar origen** (o el botón **Diagnosticar
origen** dentro del Monitor en Vivo cuando falla). El reporte se puede **Copiar** para enviarlo al
proveedor.

**Qué prueba cada paso**

| Paso | Qué hace | Qué reporta |
| --- | --- | --- |
| 1. Origen (proveedor) | Descarga la URL activa con el User-Agent del canal y sondea **4 KB del primer segmento** | HTTP real, ms, content-type, presencia de `#EXTM3U`, nº de segmentos, `ECONNREFUSED`, `ECONNRESET`, DNS, timeout 8 s, 401/403/404 |
| 2. Motor local | `getWorkerDiagnostics()` + frescura del manifiesto en `/dev/shm` (≤18 s) | PID de FFmpeg, segmentos, edad del manifiesto, rutas RAM/disco |
| 3. Entrega (URL de línea) | Pide `/live/<user>/<pass>/<id>.m3u8` de la primera línea activa y un segmento | 403 (bouquet/IP), 404 (id), 503 (canal detenido), manifiesto y bytes del segmento real |

La **Source 2 dormida** también se sondea, pero **sólo como informe** (`inactive`): nunca altera el
veredicto porque el panel no la está reproduciendo.

**Veredictos**

- `ORIGEN_CAIDO` — el proveedor no entrega: afecta al panel **y** a IPTV Smarters/decos/VLC por igual.
- `SOURCE2_DISPONIBLE` — Source 1 caída pero la Source 2 (dormida) responde: conviene conmutar a mano o
  activar el respaldo automático del canal.
- `MOTOR_CAIDO` — el origen responde pero FFmpeg no produce HLS local.
- `ENTREGA_FALLA` — origen y motor bien, pero la URL de línea/bouquet falla.
- `OK` — todo el recorrido responde (si además no hay líneas activas, la entrega queda **Omitida**).

**Endpoint:** `POST /api/streams/:id/diagnose` (admin) →
`{ ok, stream{source_url enmascarada, backup_url, failover_active, auto_failover}, steps[origin|engine|delivery], verdict{code,title,text,hints}, elapsedMs, checkedAt }`.
Los tokens de las URLs se enmascaran (`token=abc1***`) para poder pegar el reporte sin filtrar credenciales.
El error `502 UPSTREAM_ERROR` del Monitor en Vivo ahora incluye `detail{url,status,reason,tried}` y un
`hint` que remite a este diagnóstico.

### 8.21. Instalación desde releases publicados (`install.sh`)

Además del instalador por rama de git, el panel se publica como **release versionado** en GitHub con
un paquete verificado:

| Artefacto | Contenido |
| --- | --- |
| `tvlister24-7-vX.Y.Z.tar.gz` | Código del panel (sin `node_modules`, `data` ni `.runtime`) |
| `install.sh` | Bootstrap: resuelve la versión, descarga el paquete, comprueba **SHA256** y lanza el instalador aislado |
| `SHA256SUMS` | Checksums de ambos archivos |

```bash
# última versión
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash

# versión exacta y puerto fijo
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.3.0/install.sh \
  | sudo bash -s -- --tag v2.3.0 --port 8095
```

Opciones del bootstrap: `--tag vX.Y.Z`, `--port N`, `--dir RUTA` (por defecto `/opt/tvlister24-7`),
`--no-verify` y `--help`. El instalador recibe el paquete vía `TVLISTER_SOURCE_DIR` y **no clona git**:
si el release dejara de estar accesible, cae al clon de GitHub y, en último caso, reutiliza el código ya
instalado (nunca borra `data/` ni `.runtime/`).

Desde el servidor: `tvlister-admin release` (última) o `tvlister-admin release v2.3.0`.

La versión se lee de `package.json` (`server/version.js`) y se expone en `GET /api/health` →
`{"status":"ok","version":"2.3.0",…}`, útil para monitorización externa.

**Publicar una versión nueva:** subir el `version` de `package.json`, crear
`docs/RELEASE_NOTES_vX.Y.Z.md` y empujar el tag:

```bash
git tag v2.3.1 && git push origin v2.3.1      # .github/workflows/release.yml compila, empaqueta y publica
```

En local, sin CI: `bash scripts/build_release.sh v2.3.1` genera `release/` con los tres artefactos y el
comando `gh release create` listo para ejecutar.

### 8.22. Modelos de WK2500 (32 / 64 / 125 canales) y varios equipos en la misma grilla

Los moduladores WK2500 no tienen todos la misma capacidad: existen de **32, 64 y 125 canales** de salida.
El panel ya no asume un único equipo de 125: cada modulador se registra con su modelo, su rango de canales
y su propia salida UDP.

**Qué cambió**

- Tabla `wk2500_units`: `model_channels` (32/64/125), `ch_start`–`ch_end`, `ip_mode`, `dest_ip`,
  `base_port`, `local_interface_ip`, `ttl`, `default_output_mode`, `enabled` y notas.
- Cada canal de la grilla guarda su `unit_id`, así que la tabla muestra qué equipo entrega cada número.
- **Validación de capacidad**: un WK2500 de 32 canales no puede tener un rango de 59 números; la API
  responde `400` explicando la capacidad real del modelo.
- **Sin solapes**: dos equipos no pueden generar el mismo número de canal (se pisarían en el combinador
  RF); la API responde `409` indicando con qué equipo choca.
- **Cobertura visible**: el panel calcula cuántos de los 124 canales tienen modulador, qué rangos quedan
  sin cubrir (`CH 34–125`, por ejemplo) y avisa si hay streams asignados a números fuera de cobertura.
- **Sin modulador no hay RF**: activar un canal fuera de la cobertura de todos los equipos se rechaza con
  `400`; el "Activar asignados" sólo enciende los números cubiertos y reporta `skippedUncovered`.

**Armado rápido (el caso de 4 equipos de 32 canales)**

En la sección *UDP / CATV (WK2500)* → **Armado rápido de equipos**:

| Campo | Ejemplo |
| --- | --- |
| Modelo | 32 canales |
| Cantidad | 4 |
| Desde CH | 2 |
| Salida UDP | Unicast (IP por equipo) |
| IP base | `192.168.25.10` (el panel suma +1 por equipo) |
| Puerto base | 5000 (puerto = base + canal) |

Resultado:

| Equipo | Rango RF | Capacidad usada | Destino UDP |
| --- | --- | --- | --- |
| WK2500 1 | CH 2–33 | 32/32 | `192.168.25.10:5002 … :5033` |
| WK2500 2 | CH 34–65 | 32/32 | `192.168.25.11:5034 … :5065` |
| WK2500 3 | CH 66–97 | 32/32 | `192.168.25.12:5066 … :5097` |
| WK2500 4 | CH 98–125 | 28/32 | `192.168.25.13:5098 … :5125` |

124 canales con 128 de capacidad: los 4 números sobrantes del último equipo quedan libres por si el
proveedor agrega canales. En multicast el panel avanza la **tercera octeta** por equipo
(`239.25.0.0`, `239.25.1.0`, `239.25.2.0`, …) y el último octeto sigue siendo el número de canal.

**Endpoints nuevos**

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/wk2500/units` | Equipos, modelos disponibles y cobertura |
| `POST` | `/api/wk2500/units` | Crea un equipo y reescribe su rango en la grilla |
| `PUT` | `/api/wk2500/units/:id` | Edita modelo, rango, UDP, NIC, TTL o perfil |
| `DELETE` | `/api/wk2500/units/:id` | Elimina el equipo y **desactiva** sus canales (sin modulador no hay RF) |
| `POST` | `/api/wk2500/units/:id/apply` | Reaplica el direccionamiento UDP a su rango sin reiniciar el panel |
| `POST` | `/api/wk2500/units/auto-distribute` | Reparte rangos contiguos desde CH 2 según la capacidad de cada modelo |
| `POST` | `/api/wk2500/units/quick-setup` | Crea N equipos del mismo modelo con rangos consecutivos (ej. 4 × 32) |

`GET /api/wk2500/plan` ahora devuelve además `models`, `coverage` (`total_capacity`, `covered_channels`,
`uncovered_ranges`, `orphan_assigned_channels`) y, por equipo, `capacity`, `span`, `fill_percent`,
`assigned_channels`, `streaming_channels` y su primer/último destino UDP.

**UI**: tarjetas por equipo con barra de capacidad usada, destino UDP, NIC y accesos *Aplicar / Editar /
Eliminar*; filtro de la grilla por equipo; badge con el nombre del equipo en cada canal y la etiqueta
`sin modulador` en los números que ningún equipo cubre.

### 8.23. Perfiles de modulador: CSP-2500C, WK-2500C y clones (marca, estándar y transporte)

Los moduladores IP→analógico **no tienen protocolo propietario**: reciben MPEG-TS sobre UDP (o UDP/RTP) y
modulan a RF. Por eso el panel sirve igual con el **CATVSCOPE CSP-2500C**, el **Wolck WK-2500C**, el
**Softel SFT2500C**, el **SKD1709B**, **CatCast**, **Ustarlink**, **Shineco** o cualquier clon genérico.
Lo que sí cambia entre ellos es la **capacidad**, el **estándar de TV** y el **transporte** aceptado; ahora
cada equipo se declara con su perfil.

**Ficha del CSP-2500C** (la que usa este panel por defecto para ese modelo)

| Dato | Valor |
| --- | --- |
| Entrada | 2 puertos GE, máx. 64 entradas IP, 840 Mbps por puerto |
| Transporte | **UDP / UDP-RTP**, unicast y multicast, IGMP v2/v3, **1–7 paquetes por datagrama**, SPTS/MPTS, 188/204 bytes |
| Salidas RF | **32 portadoras** ágiles, 75 Ω F, 47–862 MHz, hasta 112 dBµV |
| Estándares | **NTSC M/J/4.43, PAL B/G/D/K/M/N** (SECAM en desarrollo) |
| Gestión | puerto **NMS** 100 Base-T independiente de los GE de datos (web) |

**Perfil por equipo (`wk2500_units`)**

| Campo | Valores | Para qué sirve |
| --- | --- | --- |
| `brand_model` | `csp_2500c`, `wolck_wk2500c`, `softel_sft2500c`, `skd1709b`, `catcast_2500`, `ustarlink_ws_m64`, `shineco_snk6388c`, `generic_2500` | Trae valores por defecto y documenta el equipo |
| `tv_standard` | `ntsc_m` (Nicaragua), `ntsc_j`, `pal_m`, `pal_n`, `pal_bg`, `pal_dk`, `pal_i` | Define **frecuencia exacta del canal** y **separación de audio** |
| `pkt_size` | `1316` (7×188, el clásico) o `188` (1×188) | Tamaño del datagrama UDP |
| `rtp` | `0` / `1` | Envuelve el TS en RTP (muxer `rtp_mpegts`, PT 33) |

**Plan de frecuencias por estándar** (`server/catvPlan.js`)

- `ntsc_m`, `ntsc_j`, `pal_m`, `pal_n` → plan **EIA-542 STD cable** (6 MHz, video = borde + 1.25,
  audio +4.5 MHz). CH 2 = 55.25 MHz, CH 125 = 799.25 MHz.
- `pal_bg`, `pal_dk`, `pal_i` → plan **CCIR/CENELEC** (E2–E4, S1–S10, E5–E12, S11–S20, E21–E69;
  audio +5.5 / +6.5 / +6.0 MHz). CH 2 = 48.25 MHz … CH 81 = 855.25 MHz; por encima de 81 la API avisa.
- Cualquier canal puede **forzar su frecuencia** (HRC/IRC o ajuste fino): se edita el MHz en la columna
  *Frecuencia RF* y queda marcado en ámbar; el botón **↺** vuelve al plan del estándar.

**Transporte verificado en laboratorio**

| Modo | Comprobación |
| --- | --- |
| UDP `pkt_size=1316` | Datagramas de 1316 bytes exactos, 0x47 al inicio |
| UDP `pkt_size=188` | Un paquete TS por datagrama (188 bytes) |
| UDP+RTP | Cabecera RTP v2, **payload type 33 (MPEG-TS)**, TS sincronizado en el byte 12 |

El motor directo en Node (sin FFmpeg) emite `pkt_size` 188 o 1316; cuando el equipo pide RTP el canal pasa
automáticamente por FFmpeg con `-f rtp_mpegts` para llevar timestamps correctos.

**Puesta en marcha del CSP-2500C (paso a paso)**

1. Conecta el puerto **GE de datos** del modulador al mismo switch que la NIC dedicada del panel.
2. En la web del modulador (puerto **NMS**), asigna IP/red al GE y define el **estándar NTSC-M** y el nivel
   de salida RF.
3. En el panel: *UDP / CATV* → **Armado rápido** → marca `CATVSCOPE CSP-2500C`, estándar `NTSC M`, modelo
   32, cantidad = número de equipos, IP base = IP del primer modulador.
4. En la web del modulador crea una entrada por canal: `udp://IP:PUERTO` → número de canal RF y
   frecuencia (el CSV del panel trae canal, MHz de video, MHz de audio, UDP y transporte listos para copiar).
5. Asigna en el panel qué canal va en cada número y pulsa **Activar asignados**.
6. Verifica en el panel los Mbps reales por canal y, en el modulador, que cada entrada esté *online*.

**Diagnóstico rápido de "no modula"**

| Síntoma | Causa habitual | Solución |
| --- | --- | --- |
| Canal online en el panel pero TV sin imagen | En el modulador la entrada UDP apunta a otro puerto/canal | Revisa `udp://host:puerto` en la web del equipo (puerto = base + canal) |
| Imagen con nieve o sin color | Estándar distinto (PAL vs NTSC) o frecuencia desviada | Pon el mismo estándar en panel y modulador; ajusta MHz si usas HRC/IRC |
| Se ve pero sin audio | Separación de audio del estándar (+4.5 / +5.5 / +6.5) | Usa el perfil `copy_mp2_leveled` y el estándar correcto |
| El modulador marca la entrada como *offline* | Datagramas de tamaño no soportado o RTP no esperado | Cambia `pkt_size` a 1316/188 o activa/desactiva RTP según el equipo |
| Dos canales se pisan | Dos números RF iguales en equipos distintos | El panel ya lo bloquea (409); corrige los rangos |

### 8.24. Motor FFmpeg simplificado (opciones estáticas y cambios visibles)

La sección **Motor FFmpeg** se reorganizó para que se entienda de un vistazo y no se toque el motor por accidente.

**Cómo funciona ahora**

1. **Todo está bloqueado por defecto.** Cada opción es un recuadro con su valor actual, su valor de fábrica y
   una etiqueta `Por defecto` o `Modificado`. Para tocar algo hay que pulsar **Permitir cambios**; sin eso los
   campos son de sólo lectura.
2. **La descripción nunca cambia.** El texto explicativo de cada opción es fijo (qué hace y por qué ese valor),
   no se reescribe solo ni depende de otros campos.
3. **Todo cambio queda plasmado en su recuadro.** Al modificar una opción, su recuadro pasa a ámbar y escribe
   literalmente *«Cambiado de X a Y»*, además de la etiqueta `Sin guardar` mientras no se aplique. El botón ↺
   devuelve esa opción a su valor de fábrica.
4. **Dos niveles.** Se ven 6 opciones básicas (segmento, segmentos en el manifiesto, hilos H.264, reserva de
   RAMDisk, registro y salida MPEG-TS). El resto (sondas HTTP/UDP, tailer, prebuffer) queda tras
   **Mostrar opciones avanzadas**, junto a las estadísticas del prebuffer.
5. **Perfiles rápidos** (Estable, Baja latencia, etc.) sólo rellenan valores en el formulario: no aplican nada
   hasta pulsar **Guardar y reiniciar escalonado**.
6. El **Comando real que ejecuta FFmpeg** y el selector de binario quedan plegados, para que no dominen la página.

**Regla de oro:** los argumentos del motor no cambiaron. Esta sección sólo cambia *cómo se edita* la misma
configuración de siempre; con todo en `Por defecto` la línea de FFmpeg es idéntica a la validada en producción.

### 8.25. Bloques de canales no contiguos por equipo (lista por portadora)

Un equipo IP→analógico no tiene por qué generar un rango corrido de canales: sus **portadoras son ágiles** y
cada una se sintoniza en cualquier frecuencia. Por eso el panel permite **declarar la lista exacta de canales
de cada equipo, en el orden de sus portadoras RF**.

**Formato del campo «Canales del equipo»**

- `95, 2-28, 96-99` → la **portadora 1** del equipo emite el canal 95, la 2 el canal 2, … y la última el 99.
- Rangos con `-`, `–`, `..` o `a`; separadores `,` o `;`; se admite `P1:95` (el prefijo se ignora).
- Se conserva **el orden escrito**: la primera entrada siempre es la portadora 1.
- **Vacío = rango contiguo** (del canal inicial al final), como antes.

**Ejemplo real: 4 × 32 canales, 124 canales, con los canales de FM agrupados**

| Equipo | Lista | Portadoras | Canales |
| --- | --- | --- | --- |
| U1 | `95, 2-28, 96-99` | 32/32 | 95, 2–28, 96–99 |
| U2 | `29-60` | 32/32 | 29–60 |
| U3 | `61-92` | 32/32 | 61–92 |
| U4 | `93-94, 100-125` | 28/32 | 93–94, 100–125 |

**Reglas que aplica el panel**

1. Un número de canal **sólo puede vivir en un equipo**; si se repite, `409` con el nombre del equipo que lo
   tiene. La comparación es canal por canal (los bloques ya no son rangos).
2. La lista no puede exceder la capacidad del modelo (`32/64/125`) ni el máximo canal del estándar (81 en PAL).
3. Casilla **«quitar esos canales al otro equipo»**: al guardar, el panel recorta la lista del equipo anterior
   en lugar de rechazar el cambio. Evita tener que reordenar los equipos a mano.
4. Los canales que salen de una lista **dejan de pertenecer al equipo** pero no se apagan ni pierden su stream.

**Exportación CSV en orden de programación**

El CSV trae ahora `Equipo, Portadora, Canal_CATV, …` y las filas van **equipo por equipo y, dentro de cada uno,
en el orden de sus portadoras**: la primera fila es la portadora 1. Así se teclea o se importa en la web del
modulador de arriba abajo, sin reordenar nada.

**Frecuencias: nunca se mueven**

La lista cambia **dónde se sienta** cada canal dentro del equipo, no su frecuencia. El canal 95 sigue siendo
91.25 MHz (+4.5 de audio) aunque esté en la portadora 1. La frecuencia la dicta el estándar de TV, no la posición.

**Aviso de campo:** los canales 95–99 (91.25–115.25 MHz) caen en la banda de FM y los 14–22 en la aeronáutica.
Si aparece ruido en esos canales, se ajusta en el equipo (`Aeronautical Radio Offset`), no en el panel.

### 8.26. Zapping rápido (cambio de canal) y binario FFmpeg dentro del panel

**Por qué el zapeo se sentía lento.** El motor escribe 6 segmentos de 2 s en el manifiesto interno. El panel
entregaba ese mismo manifiesto al reproductor, y los reproductores (hls.js, ExoPlayer/TiviMate, VLC) precargan
unos 3 segmentos antes de mostrar imagen: **6 a 12 s de espera por canal**, con audio primero y vídeo apareciendo
después. En canales `ondemand` se sumaba el arranque en frío de FFmpeg (sonda + primer segmento).

**Lo que se cambió (sin tocar la línea estable de argumentos salvo lo indicado)**

| Palanca | Qué hace | Ajuste |
| --- | --- | --- |
| Ventana al reproductor | Sirve sólo los últimos N segmentos + `#EXT-X-START:TIME-OFFSET=-1` | `playerWindowSegments` (por defecto **2**) |
| Precarga de vecinos | Al abrir el canal N arranca N-1 y N+1 en segundo plano | `zapPrewarm` + `zapPrewarmCount` (1) |
| Segmento completo | `+temp_file` en `-hls_flags`: se escribe en `.tmp` y se renombra | `hlsTempFile` (activado) |
| Keyframe por segmento | `-force_key_frames expr:gte(t,n_forced*2)` sólo si TVLister re-codifica | `keyframeAlign` (activado) |

`-force_key_frames` **no** se añade en perfiles Copy/Copy (el vídeo no se toca). El resto de la línea de
argumentos es idéntico.

Además, la espera del primer manifiesto en frío pasó de 4.2 s a 7 s: antes expiraba y el reproductor recibía un
404 y volvía a pedir (**"queda cargando"**); ahora entrega el manifiesto en el primer intento.

**Medición real (canal HLS de prueba, panel local)**

| Ventana entregada | Datos antes de la primera imagen | Medios descargados |
| --- | --- | --- |
| 6 (antes) | 2.53 MB | 10 s |
| 3 | 1.51 MB | 6 s |
| **2 (nuevo)** | **1.00 MB** | **4 s** |

La precarga se verificó con un canal `ondemand_idle` sin worker: al abrir su vecino, el canal apareció con
proceso FFmpeg propio en menos de 6 s, de modo que el siguiente zapeo no paga arranque.

**Binario FFmpeg dentro de la carpeta del panel**

`tvlister-admin ffmpeg import-xui` copia el FFmpeg de XUI.one a `/opt/tvlister24-7/.runtime/bin/ffmpeg`
(probando 4.4 → 4.3 → 4.0 → rutas antiguas), copia a `.runtime/lib` las librerías que falten, verifica que
ejecute `-version` y fija la preferencia en `runtime`. El instalador hace lo mismo automáticamente si detecta
XUI.one y todavía no hay binario en el panel. El motor añade `.runtime/lib` a `LD_LIBRARY_PATH` cuando usa el
binario copiado, así que **el panel ya no depende de que /home/xui exista**.

### 8.27. Un CSV por modulador (en vez de un solo archivo de 124 canales)

Con 4 moduladores, un CSV único no sirve: en la web de cada equipo sólo deben entrar **sus** portadoras.
El panel genera ahora un archivo por equipo, con las filas en el orden real de sus portadoras.

**Cómo se obtiene**

- En **UDP / CATV → tarjeta del equipo → `CSV`** (o `Import` para el formato compacto, o `M3U`).
- Botón **«CSV por modulador (N)»** en la cabecera: descarga los N archivos seguidos (uno por equipo).
- **«CSV plan completo»** sigue existiendo para revisión o respaldo: 124 filas.

**API**

| Llamada | Devuelve |
| --- | --- |
| `GET /api/wk2500/export-table?format=csv&unit_id=<id>` | CSV completo del equipo (14 columnas) |
| `GET /api/wk2500/export-table?format=csv-min&unit_id=<id>` | CSV compacto de 6 columnas para la ventana de importación |
| `GET /api/wk2500/export-table?format=m3u&unit_id=<id>` | M3U con sólo las portadoras del equipo |
| `GET /api/wk2500/export-units` | Índice: un renglón por equipo con sus tres URLs |

Sin `unit_id` (o con `unit_id=all`) se obtiene el plan completo, igual que antes.

**Nombre de archivo**

`<equipo>_P1-CH<canal de la portadora 1>_<n>port.csv`

Ejemplos con el reparto real de 4 × 32:

| Equipo | Archivo | Portadoras |
| --- | --- | --- |
| CSP-2500C #1 | `CSP_2500C_1_P1-CH95_32port.csv` | 32 |
| CSP-2500C #2 | `CSP_2500C_2_P1-CH29_32port.csv` | 32 |
| CSP-2500C #3 | `CSP_2500C_3_P1-CH61_32port.csv` | 32 |
| CSP-2500C #4 | `CSP_2500C_4_P1-CH93_28port.csv` | 28 |

**Formato compacto (`Import`)**

```
Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,IP_Destino_UDP,Puerto_UDP
1,95,91.25,95.75,192.168.25.10,5095
2,2,55.25,59.75,192.168.25.10,5002
```

Sin comillas ni columnas de relleno: es el que se pega en la carga masiva de estos moduladores. La
**portadora 1 siempre es la primera fila** y el canal coincide con el que tiene el equipo en su P1.

### 8.28. Reversión del "zapping rápido" (v2.5.3) — entrega original restaurada

**Qué pasó.** En v2.5.1 se entregaba al reproductor una ventana de sólo 2 segmentos con `#EXT-X-START` para que
abriera en el borde del directo. El efecto secundario fue peor que el problema: al empezar en el último segmento,
si ese segmento no arranca en un keyframe (canales en Copy, que no se re-codifican), **el audio decodifica y el
vídeo se queda congelado**. Además, con una ventana tan corta un reproductor lento pierde segmentos que ya se
borraron (`delete_segments`) y se queda esperando.

**Qué se hizo (v2.5.3).** Se restauró el comportamiento validado en producción:

| Pieza | Estado |
| --- | --- |
| Manifiesto entregado | El que escribe FFmpeg, **tal cual** (con `hls_list_size` completo) |
| `#EXT-X-START` | Eliminado |
| Ventana corta (`?window=`) | Eliminada |
| `+temp_file` en `-hls_flags` | Eliminado |
| `-force_key_frames` | Eliminado |
| Precarga de canales vecinos | Eliminada |
| Espera del primer manifiesto | 4.2 s (valor original) |

Se eliminó el módulo `server/zapFast.js` y la sección **Zapping** de *Motor FFmpeg*. La línea de argumentos de
FFmpeg vuelve a ser byte a byte la de la versión estable:

```
-threads 1 -probesize 5000000 -analyzeduration 4000000
-fflags +genpts+igndts+nobuffer+discardcorrupt -flags low_delay
-c:v copy -max_muxing_queue_size 2048 -c:a copy
-f hls -hls_time 2 -hls_list_size 6
-hls_flags delete_segments+independent_segments+omit_endlist
```

**Lo que se conserva de v2.5.1** (no toca la reproducción): `tvlister-admin ffmpeg import-xui`, que copia el
binario de XUI.one a `.runtime/bin` con sus librerías en `.runtime/lib`.

**Comprobación** (canal real servido por el panel): el manifiesto entregado coincide segmento por segmento con
el que escribe FFmpeg, sin `EXT-X-START`, sin cabeceras de zapping y sin workers de vecinos.

**Si algún día se quiere reintentar el zapeo**, la única vía segura es forzar keyframe en cada segmento
(`-force_key_frames`) **antes** de acortar la ventana; nunca al revés.

### 8.29. Configuración recomendada según el hardware (v2.5.4)

El panel calcula **por sí mismo** cuál es la mejor configuración del motor para la máquina donde está
instalado. No inventa opciones ni toca la línea de argumentos de FFmpeg: **sólo escribe valores de los
ajustes que ya existen** en *Motor FFmpeg*.

**Qué mide**

| Dato | De dónde sale | Para qué se usa |
| --- | --- | --- |
| Núcleos de CPU | `os.cpus()` | Hilos de x264 / decodificación |
| RAM total | `/proc/meminfo` | Reserva de RAM del sistema |
| `/dev/shm` (total y libre) | `statfs /dev/shm` | Ventana HLS en memoria y reserva |
| Canales en el motor | `streams` + perfil asignado | Copy vs re-codificación, nivel de log |
| Moduladores / portadoras | `wk2500_units`, `wk2500_channels` | Perfil de cabecera |

Con eso estima el **espacio de la ventana HLS** (`hls_time × hls_list_size` por canal) y avisa cuando la
ventana completa no cabe en la RAMDisk.

**Cómo se ejecuta**

```bash
tvlister-admin tune            # muestra el cuadro comparativo (no escribe nada)
tvlister-admin tune apply      # escribe sólo lo que difiere
```

También en el panel: **Motor FFmpeg → «Recomendado para este servidor»**, con el botón *Aplicar N ajuste(s)*.
La tarjeta desaparece del camino cuando todo ya está aplicado (*Ya está aplicada*).

**API**

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/api/system/tune` | `{hardware, workload, items[], warnings[], summary}` (sólo admin) |
| `POST` | `/api/system/tune/apply` | Aplica todo, o sólo las claves enviadas: `{"only":["h264Threads"]}` |

**Valores que recomienda** (todos son ajustes existentes)

| Ajuste | Recomendación |
| --- | --- |
| Segmento HLS | 2 s, manifiesto de 6 (12 s de ventana) |
| Sondas | HTTP/HLS 5 MB, 4 s · local 1.5 MB, 1.5 s |
| Modo de tubería TS | `auto` con `join_on_segment` |
| Hilos x264 | 1 si ≤ 2 núcleos · 2 por defecto · 4 si ≥ 16 núcleos y ≤ 4 canales re-codificando |
| Nivel de log | `error` con ≥ 100 canales · `warning` por debajo |
| Lector de segmentos | cada 160 ms, ráfaga 2 |
| Reserva de RAM | 10 % de `/dev/shm`, entre 128 y 2048 MB |
| Prebuffer | 0 segmentos, 3000 ms de espera |
| Binario FFmpeg | sin cambios (respeta el que ya esté seleccionado) |

**Aplicar no reinicia nada.** Escribe en SQLite y devuelve el mensaje con los ajustes aplicados; para que
todos los canales tomen el valor nuevo hay que pulsar *Guardar y reiniciar escalonado* (o
`tvlister-admin restart`). Es intencional: un reinicio masivo tira los canales de los moduladores.

**Ejemplo real** (servidor de 2 núcleos, 3.9 GB de RAM, `/dev/shm` de 1.9 GB, 145 canales en Copy): el cuadro
recomienda `h264_threads 1`, `log_level error` y `ram_reserve 197 MB`, y advierte que la ventana completa
(~4.6 GB) no cabe en la RAMDisk: los canales que exceden la RAM bajan solos a disco, y la sugerencia es
llevar `/dev/shm` a ~7 GB si se quiere todo en memoria.

### 8.30. Formulario del motor que no se borra + prebuffer de estabilidad (v2.5.5)

**El fallo.** Al modificar una opción y bajar hasta *Guardar*, los valores volvían a los de fábrica. La causa no
era el guardado sino la **actualización automática**: el panel refresca *Motor FFmpeg* cada 15 s, y la función de
refresco se registra una sola vez al abrir la página. Leía el estado `dirty` *capturado en ese primer instante*
(`false`), así que en la siguiente pasada **sobrescribía el formulario con lo que había guardado en el servidor**
y borraba lo que el administrador estaba escribiendo. Ocurría a los ~15 s de empezar a editar, justo cuando ya se
está bajando a Guardar.

**La solución.** El estado «hay cambios sin guardar» pasa a un `useRef` (`dirtyRef`), que siempre devuelve el
valor real, y se añade `savingRef` para no pisar el formulario mientras se envía el guardado:

```js
if (!dirtyRef.current && !savingRef.current) setForm(res.config);
```

Además:

| Cambio | Para qué |
| --- | --- |
| Barra flotante de guardado (`sticky`) | *N cambios sin guardar* + **Guardar y reiniciar escalonado** + **Descartar**, siempre a la vista sin bajar al final |
| Botón **Descartar cambios** | Vuelve a lo que está guardado sin reiniciar nada |
| El refresco sigue activo | Los contadores (canales, RAMDisk, prebuffer, segmentos faltantes) se actualizan, pero **nunca** el formulario sucio |

**Prebuffer de estabilidad.** Con la prioridad puesta en que **se vea**, la configuración recomendada deja el
prebuffer activo:

| Ajuste | Antes | Ahora |
| --- | --- | --- |
| Segmentos de prebuffer | 0 (apagado) | **2** (4 s ya escritos) |
| Espera máxima | 3000 ms | **6000 ms** |

Qué hace exactamente: cuando un reproductor pide el manifiesto, el panel espera a que la ventana tenga 2
segmentos antes de responder, y el tailer MPEG-TS arranca con esa misma ráfaga (`burstSegments =
max(tailerBurst, prebufferSegments)`). El reproductor empieza con imagen y sonido en vez de con un segmento a
medias. **La espera está topada**: si el canal no llega a 2 segmentos en 6 s, se entrega lo que haya y se marca
`X-TVLister-Prebuffer-State: timeout`; nunca se queda colgado.

Hay un perfil rápido nuevo: **«Máxima estabilidad · con prebuffer»** (segmento 2 s, lista 6, prebuffer 2,
espera 6000 ms, `join_on_segment`).

**Comprobado con un canal real servido por el panel** (origen HLS local + Copy/Copy):

| Prueba | Resultado |
| --- | --- |
| Canal ya en marcha | `200` en 3 ms · `X-TVLister-Prebuffer: 2` · `State: ready` (sin espera) |
| Canal recién arrancado | `200` en 2137 ms · esperó 1955 ms hasta tener 2 segmentos · `State: ready` |
| Reproducción real (ffmpeg leyendo el manifiesto del panel, 12 s) | **275 frames de vídeo + audio**, sin errores |
| Cliente `.ts` | 2.47 MB en 8 s, flujo continuo |

No se toca la línea de argumentos de FFmpeg: el prebuffer es entrega y lectura, no codificación.

**Escape por petición.** Un reproductor puede pedir `?prebuffer=0` (o la cabecera `X-XUI-Prebuffer: 0`) para
saltarse la espera en ese canal concreto, sin cambiar la configuración global.

### 8.31. CSV con el formato real del modulador (v2.5.6)

**El problema de campo.** El botón *Import* generaba un CSV de 6 columnas
(`Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,IP_Destino_UDP,Puerto_UDP`). Los moduladores
IP→analógico de la familia 2500C (CSP-2500C, WK-2500C, SFT2500C y clones) **no aceptan un archivo con columnas
inventadas**: su ventana de importación valida su propia estructura. Si la cabecera, el orden de columnas, el
separador o el final de línea no coinciden, el equipo **ignora el archivo**: no crea los canales UDP ni modifica
los que ya tiene.

**La solución: no adivinar el formato, usar el del equipo.** El panel guarda, por modulador, el CSV que el propio
equipo exporta y rellena *ese mismo archivo* con el plan real.

1. En la web del modulador (p. ej. `192.168.25.10`) → tabla de canales → **Export / Descargar**.
2. En el panel: **UDP / CATV → tarjeta del equipo → `Plantilla`** → pegar el archivo (o *Abrir archivo…*) → **Guardar plantilla**.
3. El panel muestra qué reconoció y una vista previa de 3 portadoras ya rellenadas.
4. **`Import`** descarga el archivo con la estructura del equipo y los canales reales.

**Qué se conserva del archivo del equipo** y qué se rellena:

| Se rellena | Se conserva tal cual |
| --- | --- |
| Canal / Channel | Nivel (`Level`, p. ej. `1.0`) |
| Frecuencia de vídeo (MHz) | Ancho de banda (`Bandwidth`, p. ej. `6.000`) |
| Frecuencia de audio (MHz) | Estándar que el equipo ya tenga escrito |
| IP destino y puerto UDP | Cualquier otra columna propia (enable, flags, índices…) |
| Nombre del canal (si existe la columna) | Separador, fin de línea (CRLF/LF) y cabecera |

**Detección de columnas.** Reconoce cabeceras en español e inglés, con o sin acentos y con cualquier separador
(`,` `;` tabulador `|`): `Portadora`/`Carrier`, `Canal_CATV`/`Channel`, `Frecuencia_Video`/`Frequency(MHz)`,
`Frecuencia_Audio`/`Audio Frequency`, `IP_Destino_UDP`/`IP Address`, `Puerto_UDP`/`Port`, `Nivel`/`Level`,
`Ancho de banda`/`Bandwidth`, `Estandar`/`Standard`, `Nombre`/`Name`, `Program`, `Enable`.

Si el archivo **no trae cabecera**, las columnas se deducen por su contenido en la primera fila: la IPv4 es la IP,
el entero alto (≥1000) el puerto, los dos números con decimales entre 40 y 900 son vídeo y audio (el menor es
vídeo), el entero entre 2 y 125 el canal y el que queda la portadora.

**API**

| Llamada | Efecto |
| --- | --- |
| `POST /api/wk2500/units/:id/csv-template` `{text}` | Analiza y guarda la plantilla; devuelve mapeo + vista previa |
| `GET /api/wk2500/units/:id/csv-template` | Resumen y vista previa de la plantilla guardada |
| `DELETE /api/wk2500/units/:id/csv-template` | Vuelve al formato compacto |
| `GET /api/wk2500/export-table?format=dev&unit_id=<id>` | CSV en el formato del equipo |
| `GET /api/wk2500/export-table?format=csv-min&header=0&eol=crlf` | Compacto sin cabecera y con CRLF (firmwares antiguos) |

Cabeceras de respuesta: `X-TVLister-CSV-Mode` (`device-template`, `compact` o `compact-fallback`),
`X-TVLister-CSV-Rows`, `X-TVLister-CSV-Columns`. Si el equipo no tiene plantilla, `format=dev` responde con el
formato compacto y avisa con `compact-fallback` (la UI lo muestra en ámbar).

**Verificación realizada** (panel real, 4 moduladores de 32 con el reparto `95, 2-28, 96-99` / `29-60` / `61-92` / `93-94, 100-125`):

| Prueba | Resultado |
| --- | --- |
| Plantilla de 11 columnas con `;` y CRLF | 11 columnas, separador `;`, CRLF y los 5 campos clave reconocidos |
| Descarga `format=dev` del equipo 1 | 32 portadoras + cabecera, 11 columnas en todas las filas |
| Portadora 1 | CH95 · 91.25 / 95.75 MHz · `192.168.25.10:5095` |
| Nivel y ancho de banda | Se conservan `1.0` y `6.000` del archivo del equipo |
| Editar el equipo (nombre, canales, IP) | La plantilla **no se pierde** |
| Equipo sin plantilla | `compact-fallback` + aviso en la UI |
| Compacto sin cabecera | `header=0` ⇒ primera línea ya es dato |
| Detección sin cabecera | `1;91.25;95.75;192.168.25.10;5095` ⇒ portadora/vídeo/audio/IP/puerto correctos |
| 27 pruebas unitarias del parser/mapeo | todas OK (incluye nombres con comas y comillas) |

### 8.32. Comprobar la salida UDP/CATV (v2.5.7)

Cuando el modulador "no cambia nada" hay tres causas distintas y hay que poder separarlas sin adivinar. El panel
incorpora una comprobación que mide **lo que realmente sale** y **lo que realmente lleva el archivo**.

**Panel**: *UDP / CATV → tarjeta del equipo → **Comprobar***.
**Terminal**: `tvlister-admin catv check [id_equipo]` (menú opción 19).

**Qué comprueba y cómo**

| Comprobación | Cómo lo sabe | Qué significa si falla |
| --- | --- | --- |
| Plantilla del modulador | `wk2500_units.csv_template` | `Import` está usando el formato compacto, no el del equipo |
| **¿El archivo lleva nombres?** | columna `name` reconocida en la plantilla | el CSV **no puede** cambiar los nombres del modulador |
| **¿El archivo lleva IP/puerto?** | columnas `ip` y `port` reconocidas | la IP/puerto se configuran en la página *Input/Mapping* del equipo, no en la tabla de canales |
| Destinos UDP | `udp_host`/`udp_port` de cada portadora | IP repetida o inválida: dos canales al mismo socket |
| Frecuencias | separación audio = vídeo + 4.5 MHz (NTSC-M) | plan de frecuencias incoherente |
| **Emisión real** | dos muestras de `packetsSent` separadas 1.2 s ⇒ paquetes/s y kbps | el panel no está entregando al modulador |
| Errores del motor | `lastError` de cada worker | origen caído, reconectando, etc. |
| Ruta de red | `ip route get <IP del equipo>` | no hay camino hacia el modulador |
| NIC del equipo | interfaz con la IP configurada en el equipo | el tráfico sale por otra IP (posible filtro en el equipo) |
| Alcance | `ping -c1 -W1` | **informativo**: muchos moduladores bloquean ICMP |

**API**

| Llamada | Devuelve |
| --- | --- |
| `GET /api/wk2500/verify` | comprobaciones de todos los equipos |
| `GET /api/wk2500/verify?unit_id=<id>` | sólo un equipo |
| `GET /api/wk2500/verify?ping=0` | sin ping (más rápido) |

Cada equipo devuelve `checks[]` (`{id, level, ok, title, detail}`), `carriers[]` (con `worker.packets_per_sec`,
`bitrate_kbps`, `status`, `last_error`) y `mappingText`: una tabla `Portadora · Canal · MHz · UDP · Nombre`
lista para copiar a la página de entrada del modulador.

**Por qué los nombres no cambiaban.** El formato compacto de 6 columnas **no tiene columna de nombre**: el
modulador no tiene nada que escribir. Sólo cambian si el CSV que se sube tiene esa columna, y eso ocurre cuando la
plantilla es la del propio equipo (que sí la trae) o cuando se pide `format=csv-min&name=1` (7ª columna
`Nombre_Canal`), que algunos firmwares aceptan en la tabla de canales.

**Por qué el UDP no cambiaba.** La tabla de canales del modulador sólo programa canal y frecuencia; la entrada
(IP/puerto UDP de cada portadora) se define en otra página del equipo (*Input* / *Mapping* / *Program*). La
comprobación genera la tabla exacta para copiarla ahí.

**Nota sobre el CLI**: `catv check` corre en un proceso distinto del servicio, así que no puede ver los workers
vivos; muestra la configuración y remite al panel para paquetes/s reales. El panel sí mide en vivo.

### 8.33. Multicast real y las dos páginas del modulador (v2.5.8)

Con 4 × 32 en **multicast** (`239.1.1.0`, base de puerto 1000) la comprobación anterior daba un falso aviso:
hacía `ping` a `239.1.1.0`, que es una **base de grupo**, no un equipo. Un grupo multicast nunca responde.

**Corregido**

| Antes | Ahora |
| --- | --- |
| `ping 239.1.1.0` ⇒ «no responde» | En multicast **no se hace ping**; se comprueba la ruta al **grupo del primer canal** |
| Sin distinción de modo | Detecta multicast por `ip_mode` o por el primer octeto (224–239) |
| — | Comprueba **TTL** (avisa si es 1: los paquetes mueren en el primer switch) |
| — | Avisa si **varios equipos comparten la misma IP**: normal en multicast, **error en unicast** |
| — | Recuerda que cada modulador debe tener en su página de entrada **sólo sus grupos** |

**Las dos páginas del modulador (la causa real de "no cambia el UDP").** Estos equipos tienen dos tablas
independientes y ningún CSV cambia las dos:

| Página del equipo | Qué lleva | CSV del panel |
| --- | --- | --- |
| **Canales** | Canal RF + frecuencia de vídeo y audio | `format=channel` |
| **Entrada / Input / Mapping** | Grupo o IP + puerto UDP por portadora | `format=input` |

```
format=channel   →  Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,Nombre_Canal
format=input     →  Portadora,IP_Destino_UDP,Puerto_UDP,Nombre_Canal
```

Archivos: `<equipo>_P1-CH<n>_<n>port_canales.csv` y `<equipo>_P1-CH<n>_<n>port_entrada_udp.csv`.
Cabecera `X-TVLister-CSV-Mode: page-channels | page-input`.

En el panel, el modal **Comprobar** trae los botones *CSV canales*, *CSV entrada UDP* y *Copiar entrada UDP*.
`tvlister-admin catv check` imprime las dos tablas separadas.

**Multicast: cómo se reparte** (verificado con el plan real de 4 × 32)

| Equipo | Portadoras | Grupos |
| --- | --- | --- |
| WK2500 1 | CH 2–33 | `239.1.1.2:1002` … `239.1.1.33:1033` |
| WK2500 2 | CH 34–65 | `239.1.1.34:1034` … `239.1.1.65:1065` |
| WK2500 3 | CH 66–97 | `239.1.1.66:1066` … `239.1.1.97:1097` |
| WK2500 4 | CH 98–125 (28) | `239.1.1.98:1098` … `239.1.1.125:1125` |

Regla del modo multicast: `host = base con el último octeto = canal`, `puerto = base_port + canal`.
Los cuatro equipos comparten la base y **eso es correcto**; lo que cambia es qué grupos tiene cada uno.

**Si el modulador espera unicast.** Muchos 2500C vienen configurados para recibir en una IP propia
(`192.168.200.x`). En ese caso hay que poner cada equipo en modo **unicast** con **su** IP: el panel lo marca como
error si dos equipos comparten IP en unicast, porque el switch entregaría el flujo al primero.

### 8.34. Llenar el plan y detectar destinos cruzados (v2.5.9)

Después del diagnóstico quedan dos tareas de operación: **asignar canales a las portadoras** y **detectar
portadoras que apuntan a un destino que no es el de su modulador**.

**`tvlister-admin catv fill`** (menú opción 20) — asigna los canales del panel a las portadoras libres, en orden,
sin repetir ninguno. **Por defecto sólo muestra la vista previa.**

```bash
tvlister-admin catv fill              # vista previa
tvlister-admin catv fill --apply      # asigna y marca para emitir
tvlister-admin catv fill --apply --force   # reasigna también las ocupadas
tvlister-admin catv fill 2 64         # limitar el rango de canales CATV
```

| Regla | Comportamiento |
| --- | --- |
| Sólo portadoras cubiertas por un equipo | lo demás se ignora |
| No repite canales | usa la lista de libres y continúa donde se quedó |
| No toca lo ya asignado | salvo `--force` |
| Corrige el destino UDP | recalcula `host:puerto` con la base de **su** modulador |
| Las portadoras sin canal quedan vacías | no se inventan rellenos |

También repara el destino de portadoras **sin** canal cuando quedaron con la dirección de fábrica
(`239.25.0.x`), que es el estado típico tras crear un equipo sin reaplicarlo.

**Detección de destinos cruzados (`catv check` y `Comprobar`)**

Nueva comprobación `udp-mismatch`: compara cada portadora con la dirección que le corresponde según
`ip_mode`, `dest_ip` y `base_port` de su equipo. Si no coincide, sale como **error**:

```
[!!] 1 portadora(s) apuntan a un destino que no es el de este equipo
     Ej.: CH10 → 239.25.0.10:5010; según la base del equipo debería ser 239.1.1.10:1010.
```

Sin esto, un plan a medio aplicar se veía "todo OK" aunque 56 portadoras apuntaran a `239.25.0.x`, donde no hay
ningún modulador escuchando.

**Prueba realizada** (plan sintético de 2 × 32 en multicast `239.1.1.0:1000`, 8 canales en el panel):

| Caso | Resultado |
| --- | --- |
| `fill` sin canales libres | «No queda nada por asignar» y no escribe |
| `fill` primera vez | 8 asignadas, 8 destinos calculados con la base del equipo |
| `fill` segunda vez | idempotente: 0 cambios |
| `fill --force` | reasigna las 8 y sale el aviso de portadoras que quedarían vacías |
| `fill --apply` con 56 portadoras sin canal | corrige las 56 direcciones de fábrica |
| `catv check` tras el fill | «Todos distintos, del 239.1.1.2:1002 al 239.1.1.33:1033» |
| Puerto/URL mal escrito a mano | `udp-mismatch` lo marca como error con el valor correcto |
