# TVLister 24/7 — v2.5.7 «Comprobar: qué sale y qué lleva el archivo»

Un botón **Comprobar** por modulador (y `tvlister-admin catv check`) que responde con datos —no con teoría— a
las tres preguntas de campo: ¿el panel está enviando?, ¿qué puede cambiar el CSV?, ¿se llega al equipo?

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.7
tvlister-admin restart
tvlister-admin catv check        # comprobar todos los equipos
tvlister-admin catv check 1      # sólo el equipo 1
```

---

## Por qué los nombres no cambiaban

El formato compacto de 6 columnas **no tiene columna de nombre**. El modulador no tiene dónde escribir el nombre,
así que no cambia nada aunque el archivo se importe bien. La comprobación ahora lo dice con esas palabras:

> **El archivo compacto no lleva nombres** — los nombres del modulador NO pueden cambiar por el CSV que estás
> subiendo. Se cambian en la página de canales del propio equipo, o añade la columna de nombre a la plantilla.

Opciones para que **sí** cambien:
1. Guardar la **plantilla del equipo** (que trae su columna `Name`) → el CSV rellena los nombres.
2. `format=csv-min&name=1` → 7ª columna `Nombre_Canal` (válido en algunos firmwares).

## Por qué el UDP no cambiaba

En estos moduladores la tabla de canales programa **canal y frecuencia**, y la entrada de cada portadora (IP/puerto
UDP) se configura en otra página (*Input* / *Mapping* / *Program*). El CSV no puede tocar lo que el equipo no lee
de esa tabla. La comprobación genera la tabla exacta para copiar:

```
P1   CH95   91.25 MHz   192.168.25.10:5095   CH95
P2   CH2    55.25 MHz   192.168.25.10:5002   CH2
```

Botón **Copiar tabla** en el panel.

---

## Qué mide la comprobación

| Comprobación | Cómo | Si falla |
| --- | --- | --- |
| Plantilla del modulador | columna guardada en el equipo | `Import` usa el formato compacto |
| ¿Lleva nombres? | columna `name` reconocida | el CSV no puede cambiarlos |
| ¿Lleva IP/puerto? | columnas `ip` / `port` | se configuran en *Input/Mapping* |
| Destinos UDP | IP:puerto de cada portadora | repetidos o inválidos |
| Frecuencias | audio = vídeo + 4.5 MHz | plan incoherente |
| **Emisión real** | dos muestras de paquetes a 1.2 s ⇒ **pkt/s y kbps** | el panel no entrega |
| Errores del motor | `lastError` por portadora | origen caído / reconectando |
| Ruta | `ip route get <IP del equipo>` | no hay camino |
| NIC | interfaz de la IP configurada | el tráfico sale con otra IP |
| Alcance | `ping` (informativo) | muchos equipos bloquean ICMP |

---

## Verificación realizada (panel real)

Canal real asignado a la portadora 1 de un modulador de 32 × NTSC-M:

| Prueba | Resultado |
| --- | --- |
| Entrega real | **CH95 · 4286 pkt/s · 37 Mbps** hacia `192.168.25.10:5095` |
| Sin canal asignado | aviso claro: «el panel no tiene nada que enviar al modulador» |
| Origen caído | `[!!] 1 portadora(s) con error del motor` con el texto del error |
| Sin plantilla | avisa que el compacto no lleva nombres |
| Con plantilla de 11 columnas | nombres y IP/puerto pasan a `[OK]` |
| Destinos repetidos | se detectan y se nombran |
| Frecuencias | P1 = CH95 @ 91.25 MHz, audio +4.5 |
| Ruta | «Hay ruta hacia 192.168.25.10 por eth0 · sale con IP …» |
| Ping fallido | se marca informativo, no como error |
| `catv check` en CLI | informe completo + tabla para copiar (`[OK]/[!]/[!!]`) |

---

## API

| Llamada | Devuelve |
| --- | --- |
| `GET /api/wk2500/verify` | todos los equipos |
| `GET /api/wk2500/verify?unit_id=1` | un equipo |
| `GET /api/wk2500/verify?ping=0` | sin ping (más rápido) |

Cada equipo entrega `checks[]`, `carriers[]` (con `worker.packets_per_sec`, `bitrate_kbps`, `last_error`) y
`mappingText` para copiar a la página de entrada del modulador.
