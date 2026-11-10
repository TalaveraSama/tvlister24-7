# TVLister 24/7 — v2.5.4 «La mejor configuración para tu servidor»

El panel ahora **calcula solo** la mejor configuración del motor para la máquina donde está instalado, usando
**únicamente los ajustes que el panel ya tiene**. No se añadió ninguna opción nueva de FFmpeg y la línea de
argumentos del motor sigue siendo la misma de v2.5.3.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.4
tvlister-admin restart
tvlister-admin tune          # ver qué recomienda para tu máquina
tvlister-admin tune apply    # aplicarlo
```

---

## Qué hace

Lee el hardware real y la carga real:

| Dato | Fuente |
| --- | --- |
| Núcleos de CPU | `os.cpus()` |
| RAM total | `/proc/meminfo` |
| RAMDisk (`/dev/shm`) | `statfs` (total y libre) |
| Canales y perfiles | tablas `streams` + `transcode_profiles` |
| Moduladores y portadoras | `wk2500_units`, `wk2500_channels` |

Con eso estima cuánto ocupa la ventana HLS de todos los canales (`hls_time × hls_list_size` por canal) y
avisa cuando no cabe en la RAMDisk, indicando cuánto habría que darle a `/dev/shm`.

---

## Dónde se usa

**Terminal**

```bash
tvlister-admin tune            # cuadro comparativo: valor actual → recomendado, con el porqué
tvlister-admin tune apply      # escribe sólo lo que difiere; si ya está todo, dice «Nada que cambiar»
```

También aparece como opción **18** del menú de `tvlister-admin`.

**Panel** — *Motor FFmpeg* → tarjeta **«Recomendado para este servidor»**: perfil detectado, lista de ajustes
que difieren con su valor actual tachado y el recomendado, botón **Aplicar N ajuste(s)** y los avisos. Cuando
todo coincide muestra *Ya está aplicada*.

**API**

| Método | Ruta | Cuerpo |
| --- | --- | --- |
| `GET` | `/api/system/tune` | — |
| `POST` | `/api/system/tune/apply` | `{}` o `{"only":["h264Threads","logLevel"]}` |

---

## Qué recomienda

| Ajuste | Recomendación |
| --- | --- |
| Segmento HLS / manifiesto | 2 s / 6 segmentos (12 s de ventana) |
| Sondas HTTP-HLS | 5 MB y 4 s |
| Sondas locales | 1.5 MB y 1.5 s |
| Tubería TS | `auto` + `join_on_segment` |
| Hilos x264 | 1 si ≤ 2 núcleos · 2 por defecto · 4 si ≥ 16 núcleos con ≤ 4 canales re-codificando |
| Nivel de log | `error` con ≥ 100 canales · `warning` por debajo |
| Lector de segmentos | 160 ms, ráfaga 2 |
| Reserva de RAM | 10 % de `/dev/shm`, entre 128 y 2048 MB |
| Prebuffer | 0 segmentos, espera 3000 ms |
| Binario FFmpeg | **sin cambios** (respeta el que ya esté elegido) |

---

## Lo que NO hace (a propósito)

- **No cambia los argumentos de FFmpeg.** Sólo escribe valores de `settings`.
- **No reinicia canales.** Para que el valor nuevo llegue a todos los canales hay que pulsar
  *Guardar y reiniciar escalonado* o `tvlister-admin restart`. Un reinicio automático tira los canales de los
  moduladores, así que queda en tus manos.
- **No inventa opciones.** Si un ajuste no existe ya en *Motor FFmpeg*, no se recomienda.

---

## Ejemplo medido

Servidor de prueba (2 núcleos, 3940 MB de RAM, `/dev/shm` de 1970 MB) con 145 canales en Copy/Copy:

```
Perfil: Cabecera grande · Copy masivo
  Hilos x264            2 → 1
  Nivel de log          warning → error
  Reserva de RAM        384 → 197 MB
Aviso: la ventana HLS de 145 canales (~4672 MB) no cabe en /dev/shm (1970 MB).
       Los canales que exceden la RAM bajan solos a disco; para tenerlos todos en
       memoria, sube /dev/shm a ~7 GB.
```

Aplicado una vez, la segunda ejecución responde **«Nada que cambiar»**.
