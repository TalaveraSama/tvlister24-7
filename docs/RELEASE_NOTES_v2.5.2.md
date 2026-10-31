# TVLister 24/7 — v2.5.2 «Un CSV por modulador»

El CSV único de 124 canales pasa a ser **un archivo por IP analógico**, con las portadoras de ese equipo y en
su orden real (portadora 1 primero). Es el que se sube a cada CSP-2500C.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.2
tvlister-admin restart
```

---

## Novedades

### Tres botones por modulador
En **UDP / CATV**, cada tarjeta de equipo trae ahora:

| Botón | Qué descarga |
| --- | --- |
| **CSV** | El plan completo de ese equipo (14 columnas, con nombre de canal y transporte) |
| **Import** | CSV compacto de 6 columnas para la ventana de importación del modulador |
| **M3U** | Sólo las portadoras de ese equipo, para probar con VLC |

En la cabecera:
- **«CSV por modulador (N)»** → descarga los N archivos seguidos, uno por equipo.
- **«CSV plan completo»** → el archivo de 124 filas de antes (revisión o respaldo).

### Nombre de archivo inequívoco

`<equipo>_P1-CH<canal de la portadora 1>_<n>port.csv`

| Equipo | Archivo | Portadoras |
| --- | --- | --- |
| CSP-2500C #1 | `CSP_2500C_1_P1-CH95_32port.csv` | 32 |
| CSP-2500C #2 | `CSP_2500C_2_P1-CH29_32port.csv` | 32 |
| CSP-2500C #3 | `CSP_2500C_3_P1-CH61_32port.csv` | 32 |
| CSP-2500C #4 | `CSP_2500C_4_P1-CH93_28port.csv` | 28 |

Así no hay duda de a qué equipo pertenece cada archivo ni en qué portadora empieza.

### Formato compacto para importar

```
Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,IP_Destino_UDP,Puerto_UDP
1,95,91.25,95.75,192.168.25.10,5095
2,2,55.25,59.75,192.168.25.10,5002
3,3,61.25,65.75,192.168.25.10,5003
```

Sin comillas, sin columnas de relleno: se pega tal cual en la carga del modulador. La fila 1 es la portadora 1.

### API

| Llamada | Devuelve |
| --- | --- |
| `GET /api/wk2500/export-table?format=csv&unit_id=<id>` | CSV completo del equipo |
| `GET /api/wk2500/export-table?format=csv-min&unit_id=<id>` | CSV compacto de importación |
| `GET /api/wk2500/export-table?format=m3u&unit_id=<id>` | M3U del equipo |
| `GET /api/wk2500/export-units` | Índice con un renglón por equipo y sus URLs |

Sin `unit_id` (o con `unit_id=all`) se obtiene el plan completo, igual que antes. Un `unit_id` inexistente
devuelve `404`.

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| Filtro por equipo | 32 / 32 / 32 / 28 filas — exactamente sus portadoras |
| Orden | columna `Portadora` consecutiva 1..N en los 4 archivos |
| Portadora 1 | #1→CH95 @91.25 · #2→CH29 @253.25 · #3→CH61 @445.25 · #4→CH93 @637.25 |
| Nombre de archivo | `CSP_2500C_1_P1-CH95_32port.csv`, etc. |
| CSV compacto | cabecera de 6 columnas, fila 1 = `1,95,91.25,95.75,192.168.25.10,5095` |
| M3U por equipo | 32 entradas `udp://` en el equipo 1 |
| Plan completo | sigue con 124 filas |
| `unit_id` inválido | `404` con mensaje |
| UI | 4 botones CSV + 4 Import, tooltip con `P1=CH…` por equipo |
| Build de producción | Vite sin errores |

---

## Compatibilidad

- Sin migraciones de base de datos ni cambios en el motor FFmpeg.
- El CSV completo anterior sigue disponible y con el mismo formato (columna `Equipo` incluida).
- Los canales sin equipo asignado sólo aparecen en el plan completo, nunca en un CSV de equipo.
