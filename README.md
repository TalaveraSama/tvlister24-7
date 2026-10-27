# Proca Automation + OBS

**Proca** convierte a OBS Studio en un sistema de emisión televisiva automatizada 24/7.
Proca administra la programación, la publicidad, los gráficos, la grabación, las señales en vivo y la
protección contra pantalla negra; **OBS funciona como motor de reproducción y salida del canal**.

No es necesario transmitir desde Proca: OBS conserva sus propias configuraciones de streaming y salidas.

---

## Lo que incluye

### Automatización 24/7
- Listas con videos individuales, **carpetas completas**, categorías, listas anidadas y **File Slots** rotativos.
- Reproducción mediante las listas VLC / fuentes multimedia de OBS (modos `single`, `playlist` y `m3u`).
- Orden **manual, alfabético, aleatorio o temporada/episodio**.
- **Ciclo continuo**: al terminar el último video vuelve al primero.
- Nunca deja el canal en negro: si no hay contenido entra un *slate* y, si falla la señal, la playlist de emergencia.
- Guarda y recupera la **posición de reproducción**; reanuda la automatización tras cerrar y abrir Proca.
- Controles manuales: reproducir, pausar, continuar, anterior, siguiente, reiniciar tema, detener y **enviar al aire**.

### Programación y parrilla
- Programación por **hora, días de la semana y rango de fechas** (vigencia).
- Programaciones diarias, semanales o por días seleccionados; prioridad por bloque.
- Hora de inicio y finalización; **terminar a una hora exacta o después del último video**.
- Importación de videos y carpetas (también desde la biblioteca).
- Categorías, géneros y **File Slots**.
- Parrilla visual semanal + tabla profesional con inicio, fin, duración, elementos y estado.
- Reordenar contenido, guardar parrillas como **plantillas** y **adaptar una parrilla vencida a la hora actual**.
- Insertar **cámaras y programas en vivo** como bloque de parrilla.
- Al finalizar una intervención o bloque, **vuelve automáticamente a la programación 24/7**.

### Publicidad automatizada
- Múltiples bloques publicitarios con anuncios individuales o **carpetas completas**.
- Disparadores: **a una hora determinada**, **cada N minutos** o **después de N temas**; días de emisión y máximo diario.
- Reproduce todos los comerciales del bloque con **cortina de entrada y de salida**.
- **Pausa la programación principal** y regresa exactamente al punto donde quedó (sin repetir lo ya emitido).
- Rotación que evita repetir anuncios.
- **Oculta logo, reloj y cintillo** durante la publicidad y los **restaura** al terminar.

### Gráficos para OBS
- **Logo permanente** (texto o imagen) con posición, ancho y opacidad; activar/desactivar desde Proca.
- **Reloj automático**, formato 12/24 h, con o sin segundos, con la zona horaria del canal.
- **Cintillo informativo** estilo ticker animado: varios textos, velocidad lenta/normal/rápida, encendido/apagado.
- Títulos **“Estás viendo”, “A continuación”, “Más tarde”**, automáticos según la emisión o programados por horario.
- Overlay listo para **fuente de navegador** en OBS (`/overlay`), con fondo transparente.
- Restauración automática de todos los gráficos después de la publicidad y la emergencia.

### Grabación automatizada
- Iniciar y detener la grabación de OBS desde Proca (manual o automático).
- **Ventanas programadas** por día y hora de comienzo/fin.
- Estado visible, tiempo transcurrido, archivo generado y registro de errores.

### Anti pantalla negra
- Supervisión constante de la reproducción y del medidor de audio.
- Detección de **silencio** o **contenido detenido** (cursor de medios sin avanzar).
- Activación automática de la **playlist de emergencia**, carpeta especial o medios de respaldo.
- Reintentos con recuperación automática a la programación (máximo 3 intentos seguidos).
- Registro de cada activación en el As-Run.

### Operación en vivo
- Intervención manual sin desmontar la automatización.
- Envío inmediato de una **cámara o fuente de OBS** al aire, con escena configurable.
- Duración programada, hora exacta de salida o finalización manual.
- **Regreso automático** a la parrilla o la lista 24/7, restaurando gráficos y posición.

### Control y seguridad
- Comunicación por **OBS WebSocket v5** con **reconexión automática**.
- Guardado persistente de toda la configuración (JSON atómico) y **presets**.
- Recuperación después de cierres o apagones.
- **Historial As-Run** con todo lo que realmente salió al aire y **exportación CSV**.
- Menú contextual con copiar, cortar, pegar y duplicar elementos de lista; selección y edición con el mouse.
- Biblioteca con búsqueda, carpetas, categorías y géneros.

---

## Requisitos

- **Node.js 18 o superior** (probado con Node 22).
- **OBS Studio 28+** con WebSocket habilitado (solo para el modo real).
- Los archivos de video permanecen en el disco; Proca solo guarda sus rutas y metadatos.

---

## Instalación

```bash
git clone <este-repositorio> proca
cd proca
npm install
npm start
```

Abrir **http://localhost:8420**.

Al primer arranque se generan datos de demostración (biblioteca, listas, parrilla, publicidad, gráficos y
emergencia) para poder probar todo sin configurar nada. El modo por defecto es el **simulador de OBS**.

### Scripts

| Comando | Descripción |
| --- | --- |
| `npm start` | Inicia Proca en `0.0.0.0:8420` |
| `npm run dev` | Igual, con recarga automática al editar el servidor |
| `npm run seed` | Reescribe `data/proca.json` con datos de demostración |
| `npm test` | Pruebas unitarias del dominio (tiempo, parrilla, publicidad, listas, As-Run, persistencia) |
| `npm run test:ui` | Prueba de humo e interacción de todas las vistas (requiere el servidor en marcha) |
| `npm run check` | Valida la sintaxis de todo el código JS |

Variables de entorno: `PORT` (8420), `HOST` (0.0.0.0), `PROCA_DATA` (ruta del JSON), `PROCA_DRIVER`
(`mock` | `real` | `off`).

---

## Conectar con OBS real

1. En OBS: **Herramientas → WebSocket settings** → habilitar servidor, puerto `4455` y contraseña.
2. En Proca: **Ajustes → Conexión OBS WebSocket** → modo **OBS real**, host, puerto y contraseña → **Conectar**.
3. En **Reproducción en OBS** elija el modo y los nombres de las fuentes/escenas.

### Fuentes y escenas recomendadas en OBS

| Elemento | Nombre sugerido | Tipo de fuente |
| --- | --- | --- |
| Reproductor principal | `Proca Media` | Fuente multimedia (*Media Source*) |
| Reproductor de listas VLC | `Proca VLC` | Fuente de reproducción VLC |
| Gráficos animados | `Proca Overlay` | Fuente de navegador → `http://IP-DE-PROCA:8420/overlay` (1920×1080, transparente) |
| Logo | `Proca Logo` | Imagen |
| Reloj | `Proca Reloj` | Texto (GDI+) |
| Cintillo | `Proca Ticker` | Texto (GDI+) |
| Slate / sin señal | `Proca Slate` | Color o imagen |
| Emergencia | `Proca Emergency` | Fuente multimedia |

Escenas: `Programa`, `En Vivo`, `Emergencia`, `Slate` (puede usar sus propios nombres;
se configuran en **Ajustes**).

Proca cambia el texto y la visibilidad de las fuentes directamente por WebSocket. La **fuente de navegador**
con el overlay es la forma recomendada de tener el cintillo animado, el reloj y los títulos, y se actualiza por SSE.

### Modo simulador

El **simulador** reproduce el comportamiento de OBS (escenas, fuentes, estados de medios, grabación y
medidores) para operar y demostrar el sistema completo sin OBS instalado. En la vista **En vivo** aparecen
botones para **simular silencio** y **simular caída**, ideales para ver el anti dead-air y la reconexión.

---

## Uso rápido

1. **Biblioteca → Importar carpeta**: indique una ruta local (se detectan mp4, mkv, avi, mov, ts, webm y audio).
   Ajuste categorías, géneros, temporadas y **duración** (clave para que el avance sea exacto).
2. **Listas 24/7**: cree una lista y agregue videos, categorías completas, carpetas o File Slots.
   Elija el orden y deje el ciclo continuo activo. Pulse **Enviar al aire**.
3. **Parrilla**: cree bloques con días, horario, fechas de vigencia y contenido. La parrilla tiene prioridad
   sobre la lista 24/7 y, al terminar cada bloque, se retoma la programación continua.
4. **Publicidad**: cree un bloque, agregue anuncios o una carpeta, defina el disparador y las cortinas.
5. **Gráficos**: configure logo, reloj y cintillo; el overlay ya está listo para OBS.
6. **Grabación**: ventanas programadas o grabación manual; todo queda en el historial.
7. **Anti pantalla negra**: asigne la lista de emergencia, los umbrales de detección y la recuperación.
8. **As-Run**: consulte lo emitido y exporte el reporte en CSV.

Atajos: `Espacio` pausa/continúa la emisión; clic derecho en listas y biblioteca abre el menú contextual.

---

## Cómo se decide qué está al aire

Cada segundo el motor evalúa, en este orden:

1. **Intervención en vivo** activa (prioridad absoluta).
2. **Publicidad** disparada por horario, intervalo o cantidad de temas.
3. **Parrilla**: bloque activo según día/hora/fechas, con prioridad entre bloques cruzados.
4. **Lista 24/7** o *slate* si no hay contenido.
5. **Emergencia** si la reproducción se detiene o hay silencio.

El estado (modo, lista, índice, posición, ads, vivos y emergencia) se guarda en `data/proca.json`, por lo que
un cierre inesperado o un apagón no pierde la posición: al abrir, Proca reanuda donde quedó.

---

## Estructura del proyecto

```
server/
  index.js              Arranque HTTP, OBS y motor
  app.js                API REST, SSE, overlay y estáticos
  engine.js             Núcleo de automatización (parrilla, ads, en vivo, emergencia, grabación)
  store.js              Persistencia JSON atómica con debounce
  defaults.js           Estructura de datos y datos de demostración
  time.js               Utilidades de fecha/hora con zona horaria
  logger.js             Registro en memoria + consola
  obs/
    manager.js          Fachada de OBS (real o simulador), reconexión y estado
    real.js             Cliente obs-websocket v5
    mock.js             Simulador de OBS
  services/
    resolver.js         Listas, categorías, carpetas, slots y orden
    schedule.js         Resolución de la parrilla
    ads.js              Bloques, disparadores y secuencia de comerciales
    graphics.js         Estado de gráficos y aplicación a OBS
    recorder.js         Ventanas de grabación
    asrun.js            Registro As-Run y CSV
    library.js          Escaneo e importación de carpetas
public/
  index.html            Interfaz (SPA sin build)
  overlay.html          Overlay transparente para OBS
  js/views/*.js         Vistas: monitor, listas, parrilla, publicidad, biblioteca, gráficos,
                        en vivo, grabación, emergencia, As-Run y ajustes
  css/                  Estilos de la interfaz y del overlay
test/                   Pruebas unitarias (node:test)
scripts/                Seed, chequeo de sintaxis y pruebas de interfaz
data/                   Base de datos JSON (no se versiona)
```

No hay paso de compilación: el frontend usa módulos ES nativos y se sirve desde `public/`.

---

## API principal

| Método y ruta | Descripción |
| --- | --- |
| `GET /api/bootstrap` | Todos los datos de la interfaz + estado actual |
| `GET /api/state` · `GET /api/events` | Estado en vivo (SSE) |
| `POST /api/playout/{pause,resume,next,previous,stop,air,goto,seek,automation}` | Controles de emisión |
| `GET/POST/PATCH/DELETE /api/media…` · `POST /api/media/import-folder` | Biblioteca |
| `GET/POST/PATCH/DELETE /api/playlists…` | Listas 24/7 |
| `GET/POST/PATCH/DELETE /api/slots…` | File Slots y rotación |
| `GET/POST/PATCH/DELETE /api/grid…` · `POST /api/grid/adapt` | Parrilla y plantillas |
| `GET/POST/PATCH/DELETE /api/ads…` · `POST /api/ads/blocks/:id/run` | Publicidad |
| `PATCH /api/graphics` · `POST /api/graphics/ticker` | Gráficos |
| `POST /api/live/start` · `POST /api/live/end` | Intervención en vivo |
| `PATCH /api/emergency` · `POST /api/emergency/{test,exit}` | Anti pantalla negra |
| `POST /api/recording/{start,stop}` · `/api/recording/schedules` | Grabación |
| `GET /api/asrun` · `GET /api/asrun/export.csv` | Historial y reporte |
| `POST /api/obs/connect` · `/api/obs/scene` · `/api/obs/simulate` | OBS |
| `GET /api/data/export` · `POST /api/data/import` | Respaldo y restauración |

---

## Seguridad y operación

- Proca escucha en `0.0.0.0` para poder usarse desde otro equipo o con OBS en la misma red.
- **No incluye autenticación**: publíquelo solo en una red de confianza o detrás de un proxy con contraseña.
- Use contraseña en OBS WebSocket y no exponga el puerto a Internet.
- Respaldos: **Ajustes → Descargar respaldo completo** (JSON) o copia de `data/proca.json`.

## Limitaciones conocidas

- Proca **no analiza el contenido de los videos**: la duración se toma de los metadatos cargados o del valor
  editado a mano (por defecto 60 s). Ajuste la duración para una parrilla exacta.
- No transcodifica ni corta archivos: reproduce lo que entrega OBS/VLC.
- En modo lista VLC el avance lo calcula Proca; si VLC se desfasa, use **Sincronizar con OBS** o el modo
  de archivo único.
- La grabación con audio depende de la configuración de salida de OBS.
- Los datos de demostración usan rutas `demo://`, pensadas para el simulador.
