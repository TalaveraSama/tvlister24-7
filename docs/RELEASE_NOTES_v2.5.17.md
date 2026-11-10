# TVLister 24/7 — v2.5.17 «Aguanta meses, no una tarde»

Pasada de estabilidad pensada para un headend que **no se va a reiniciar solo porque a alguien le
parezca**: se buscaron los fallos que sólo aparecen después de días encendido o después de un corte
de luz, y se corrigieron los que dejan al panel o a los moduladores sin servicio.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.17
tvlister-admin restart
tvlister-admin health
```

Esta versión hace **una copia consistente de la base antes de instalar** (ver punto 3). Si algo sale
mal, el panel vuelve con los datos de hace un minuto.

---

## 1. Lo que estaba mal y ahora está corregido

| # | Fallo encontrado | Qué pasaba en producción | Cómo queda |
| --- | --- | --- | --- |
| 1 | **FFmpeg huérfanos** | Si el panel muere de golpe (OOM, `kill -9`, corte), sus FFmpeg quedan vivos y siguen enviando **al mismo grupo UDP** del modulador. Dos emisores = el doble de bitrate y el modulador se cae. | Los hijos llevan la marca `TVLISTER_WORKER=1`. Al arrancar se barren los de la ejecución anterior **antes** de lanzar los nuevos. |
| 2 | **Canales congelados sin vigilancia** | FFmpeg vivo, sin escribir segmento: el canal aparece "activo" y el cliente ve la última imagen. Nadie lo reiniciaba. | Vigilante cada minuto: manifiesto parado > 90 s → se mata el FFmpeg y su propio supervisor lo relanza (sin tocar la línea de argumentos). En CATV: 3 minutos sin un byte → se reengancha el canal. |
| 3 | **`tvlister-admin backup` con `cp`** | Copiar un SQLite en modo WAL con `cp` deja fuera lo que aún está en el `.db-wal`: el respaldo sale viejo o **corrupto** justo el día que hace falta. | Copia consistente con `VACUUM INTO` (sin parar el panel). Si fallara, copia `db + wal + shm` juntos. |
| 4 | **Respaldos incompletos** | Faltaban `users` (¡sin ella no se entra al panel!), `wk2500_units`, `wk2500_channels`, `flussonic_servers`, `mnf_trunks`, `headend_nodes`, `ingest_endpoints`, `vod_watch_folders`, `credit_logs`. | Ahora entran todas las tablas que hacen falta para levantar el sistema en otra máquina. |
| 5 | **systemd se rendía** | Sin `StartLimitIntervalSec=0`, tras 5 caídas en 10 s el servicio quedaba en `failed` y **no volvía a levantarse** hasta hacerlo a mano. | `StartLimitIntervalSec=0` + `TimeoutStopSec=25` (cierre ordenado con checkpoint del WAL). |
| 6 | **Actualizar sin red de seguridad** | `release`/`update` reemplazaban el código sin respaldar antes. | Copia consistente de la base antes de instalar. Si falla la copia, avisa y sigue. |
| 7 | **Basura en `/dev/shm`** | Directorios HLS de canales borrados hace meses. Se come la RAMDisk que necesitan los canales vivos y el motor empieza a escribir en disco sin avisar. | Limpieza cada 10 min: sólo se borran directorios sin worker vivo y con más de 10 min de antigüedad. |
| 8 | **WAL y conexiones zombis** | El `-wal` crecía sin límite y `active_connections` acumulaba filas de clientes que ya no existían. | Mantenimiento horario: `PRAGMA optimize`, checkpoint si el WAL pasa de 32 MB y borrado de conexiones de más de 1 día. |
| 9 | **`/api/health` mentía** | Devolvía `db: 'wal_ok'` **fijo**. Un monitor externo (Uptime Kuma, Zabbix…）nunca habría detectado la base rota. | Comprueba de verdad (`PRAGMA journal_mode` + consulta real), añade `rssMb` y el estado de la guardia. |
| 10 | **Sin medida del bucle de eventos** | Si el proceso principal se atasca, el panel entero se congela y no había forma de verlo. | p50 / p99 / máximo cada minuto en `health` y en el Dashboard. |

## 2. Cómo se comprueba (sin teoría)

```bash
tvlister-admin health
```

```
  [OK]   Panel en marcha: 3 d 4 h 12 min · RSS 412 MB · heap 96 MB
  [OK]   Bucle de eventos: p50 1.2 ms · p99 4.8 ms · máx 22.1 ms
  [OK]   Disco de datos: 128443 MB libres de 234881 MB (45 % usado)
  [OK]   RAMDisk HLS: /dev/shm/tvlister_hls · 3821 MB libres (61 % usado)
  [OK]   Base de datos SQLite: 88.4 MB · WAL 2.1 MB · ok
  [OK]   Respaldo del panel: 10 respaldos · el último hace 6 h
  [OK]   Canales HLS: 145 workers · 0 sin proceso · 0 con manifiesto parado
  [OK]   Salida a moduladores (UDP): 124 canales activos · 0 reconectando · 0 sin bytes
  [OK]   Procesos huérfanos: ninguno
  [OK]   Motor FFmpeg: /opt/tvlister24-7/.runtime/bin/ffmpeg
```

Sale con **código 1** si hay cualquier `[FALLA]`, así que sirve en un cron o en un monitor:

```bash
*/5 * * * * root /usr/local/bin/tvlister-admin health >/var/log/tvlister-health.log 2>&1 || \
  mail -s "TVLister: falla de estabilidad" tu@correo </var/log/tvlister-health.log
```

Mantenimiento puntual:

```bash
tvlister-admin health --clean      # libera directorios HLS sin worker y recorta el WAL
tvlister-admin health --vacuum     # compacta la base cuando hay mucho espacio muerto
tvlister-admin health --orphans    # busca y termina FFmpeg de una ejecución anterior
```

En el panel, el **Dashboard** muestra el mismo veredicto arriba de las tarjetas: verde si todo está
en orden, ámbar con los avisos, rojo si hay fallas.

## 3. Qué se verificó antes de publicar

Todo ejecutado en esta máquina, no deducido:

- **Barrido de huérfanos**: 5 emisores falsos con la marca fueron detectados y terminados; un hijo
  legítimo del mismo proceso **no** se tocó.
- **Limpieza de RAMDisk**: directorio de hace 1 h sin worker → borrado; directorio reciente → respetado.
- **Mantenimiento de base**: `optimize` + checkpoint de WAL + purga ejecutados sobre una base real.
- **Watchdog HLS**: worker que nunca escribe manifiesto → reiniciado; un worker recién relanzado **no**
  se vuelve a matar (sin tormenta de reinicios).
- **Watchdog CATV**: canal que declara `streaming` y lleva 3 vueltas sin bytes → marcado; si vuelve a
  mandar datos, deja de estarlo en la misma vuelta.
- **Cadena real a modulador**: canal CATV con FFmpeg → UDP `239.25.0.2:5002`, `streaming`, 793 kbps →
  1.066 kbps, 967 paquetes, con la marca `TVLISTER_WORKER` en `/proc/<pid>/environ`.
- **Reinicio por guardia**: `restartWk2500ChannelWorker` → PID nuevo y vuelta a `streaming`.
- **Endpoints**: `/api/health`, `/api/system/stability`, `/api/dashboard`, Motor FFmpeg, plan CATV → 200.
- **CLI**: `health`, `health --clean`, `health --vacuum`, `health --orphans`, `hls status`.

## 4. Lo que no cambió

- La línea de FFmpeg de los canales y la cadena UDP (`-re`, SDT, CBR) — intactas. El modo HLS por
  defecto sigue en `off`.
- No se toca ningún dato del operador: la guardia sólo borra directorios temporales y conexiones
  caducadas.

## 5. Recomendaciones de sistema (esto no lo hace el panel)

Para un 24/7 de verdad, en el servidor:

1. **Journal acotado** — un journal sin límite se come el disco en un equipo con 145 canales:
   ```bash
   sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
   sudo systemctl restart systemd-journald
   ```
2. **Hora sincronizada** (`chrony` o `systemd-timesyncd`): sin NTP, los PTS y las fechas de los
   respaldos se van de madre.
3. **UPS** con apagado ordenado (el `TimeoutStopSec=25` ya da margen para cerrar limpio).
4. **Disco**: que `data/` y `streams_runtime/` estén en el mismo disco que vigila `health`. Si se
   llena, primero se cae la guía de programación, después todo.
5. **Unidad de respaldo**: el panel reinicia canales y procesos, pero **no** sustituye un modulador
   muerto ni un enlace caído. Mantén el equipo de repuesto.
