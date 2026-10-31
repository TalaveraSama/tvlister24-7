# TVLister 24/7 — v2.3.0 «Producción Total»

Primer release oficial empaquetado del panel. Instalación reproducible desde GitHub, con paquete
verificado por **SHA256** y sin clonar ramas de git.

---

## Instalación en 1 línea (VPS Ubuntu / Debian, como root)

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash
```

Versión fija + puerto explícito (recomendado en producción):

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.3.0/install.sh \
  | sudo bash -s -- --tag v2.3.0 --port 8095
```

Desde el propio servidor:

```bash
tvlister-admin release            # última versión publicada
tvlister-admin release v2.3.0     # versión exacta
```

El instalador mantiene el modo **aislado / zero-apt**: Node.js 22 y FFmpeg viven en
`/opt/tvlister24-7/.runtime`, no se tocan MariaDB, Nginx ni los puertos de XUI.one, y la base de
datos (`data/tvlister.db`) se conserva entre instalaciones y actualizaciones.

## Artefactos del release

| Archivo | Qué es |
| --- | --- |
| `tvlister24-7-v2.3.0.tar.gz` | Código completo del panel (sin `node_modules`, `data` ni `.runtime`) |
| `install.sh` | Instalador autónomo: resuelve la versión, verifica el paquete y lanza el instalador aislado |
| `SHA256SUMS` | Checksums de ambos archivos |

Verificación manual:

```bash
curl -fsSLO https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.3.0/SHA256SUMS
curl -fsSLO https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.3.0/tvlister24-7-v2.3.0.tar.gz
sha256sum -c SHA256SUMS
```

## Novedades de esta versión

### Motor y estabilidad
- Motor FFmpeg propio con HLS nativo en RAMDisk, `-f tee` sólo para doble salida TS y manifiesto
  revalidado cada ≤18 s. Los argumentos de FFmpeg quedan **congelados** (sin presets ni segmentación
  automática): es el motor validado en producción.
- Corrección del tirón en clientes HLS/MPEG-TS (cola ordenada HLS→TS, sin segmentos duplicados).
- Motor FFmpeg configurable desde el panel: hilos, ventana HLS, RAMDisk, perfiles de transcodificación
  y capa de compatibilidad con las **3 versiones de FFmpeg de XUI.one** (`4.4`, `4.3`, `4.0`) más el
  binario incluido. Selección por canal/servidor y `tvlister-admin ffmpeg status|use|install`.
- Prebuffer de entrega estilo XUI (opcional, por defecto apagado) y cabeceras de streaming.

### Orígenes y respaldo
- Cada canal puede tener **Source 2 dormido**: 0 peticiones mientras el principal emite y conmutación
  automática opcional (3 revisiones, enfriamiento de 120 s y bloqueo anti-rebote de 3 cambios/15 min).
  Sin interruptor global, sin `priority_backup`: la decisión es por canal.
- Auditoría de fuentes y limpieza masiva de respaldos para evitar sesiones duplicadas en el headend.

### Diagnóstico
- **Diagnóstico de reproducción por canal** (`⋯ → Diagnosticar origen`): prueba origen → motor →
  entrega al reproductor desde el servidor y dice **dónde** se corta, con el HTTP real
  (`401/403/404`, `ECONNREFUSED`, timeout, DNS) y acciones concretas. Reporte copiable con tokens
  enmascarados. Detecta también si la Source 2 responde aunque la 1 esté caída.

### Flussonic / headend
- Módulo Flussonic 23.12 con streams 24/7 constantes (nunca `ondemand`), Copy/Anti-Rayado + nivelador
  de audio, **sin transcodificación por defecto** y sin reescribir el bitrate nativo.
- Cadena de nivelación de audio 24/7: ProLiant Gen9 → Flussonic local → Flussonic remoto por `m4f`.
- Módulo UDP/CATV para moduladores WK2500: canales 2–125, NIC de egreso dedicada, telemetría real.

### Panel
- Skin de la lista de canales inspirado en XUI.one (tabla densa, menú de acciones, filtros, paginación,
  badges de estado y vista por categoría) manteniendo la paleta oscura y los iconos de TVLister.
- Bouquets editables desde la ficha del canal, notas, EPG, vistas rápidas y ficha completa.
- Importación nativa de la base de datos de XUI.one (MySQL, socket o `.sql`) sin romper la instalación
  existente en `/home/xui`.
- CLI `tvlister-admin`: `status`, `doctor`, `reset-admin`, `shield`, `import-xui`, `clean`,
  `enable-cron`, `setup-ssl`, `set-port`, `add-port`, `install-ingest`, `ffmpeg`, `update`, `release`.

## Actualizar desde una instalación anterior

```bash
ssh root@TU_SERVIDOR
tvlister-admin release      # o: tvlister-admin update  (rama de trabajo)
tvlister-admin restart
```

La base de datos, los bouquets, las líneas, el puerto y la carpeta `.runtime` se conservan.
Después de actualizar, recarga el panel con **Ctrl+F5**.

## Requisitos

- Ubuntu 22.04 / 24.04 o Debian 12, x86_64 o arm64, acceso `root`.
- 1 vCPU y 512 MB de RAM mínimos para el panel (la ingesta suma según canales activos).
- Puertos de la API Xtream (`/get.php`, `/live`, `/movie`, `/series`) accesibles para tus clientes.
- Coexistencia verificada con **XUI.one** instalado en el mismo servidor.
