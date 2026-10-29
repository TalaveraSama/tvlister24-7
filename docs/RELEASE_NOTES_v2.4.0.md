# TVLister 24/7 — v2.4.0 «Moduladores IP→analógico»

Salida UDP/CATV lista para producción con **varios moduladores**, cada uno con su marca, su estándar de TV
y su transporte. Probado con el perfil del **CATVSCOPE CSP-2500C** (32 en 1) y compatible con Wolck
WK-2500C, Softel SFT2500C, SKD1709B, CatCast, Ustarlink, Shineco y clones genéricos.

---

## Instalación / actualización

```bash
# servidor nuevo
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash

# versión fija
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.4.0/install.sh \
  | sudo bash -s -- --tag v2.4.0 --port 8095

# servidor ya instalado
tvlister-admin release v2.4.0   # o: tvlister-admin release
tvlister-admin restart
```

---

## Novedades

### Varios moduladores en la misma grilla
- Cada equipo WK2500 se registra con **modelo real** (32 / 64 / 125 canales), rango de canales, IP/puerto
  UDP, NIC dedicada, TTL y perfil de salida.
- **4 equipos de 32 canales** cubren los 124 canales: CH 2–33, 34–65, 66–97 y 98–125.
- La API rechaza rangos que excedan la capacidad del modelo (`400`) o que se solapen con otro equipo
  (`409`), y avisa de los canales sin modulador o con stream asignado fuera de cobertura.
- "Activar asignados" enciende sólo los números cubiertos por un equipo.

### Perfil de marca y estándar de TV
- Marcas: `CSP-2500C`, `WK-2500C`, `SFT2500C`, `SKD1709B`, `CatCast`, `Ustarlink`, `Shineco` y genérico.
- Estándares: **NTSC-M** (Nicaragua, por defecto), NTSC-J, PAL-M, PAL-N, PAL-B/G, PAL-D/K, PAL-I.
- El **plan de frecuencias** se calcula por estándar (EIA-542 para NTSC/PAL-M/PAL-N, CCIR/CENELEC con
  canales S para PAL europeo) y la **separación de audio** se ajusta sola (+4.5 / +5.5 / +6.0 / +6.5 MHz).
- Cualquier canal puede **forzar su frecuencia** (HRC/IRC o ajuste fino) desde la columna *Frecuencia RF*,
  con el botón ↺ para volver al plan del estándar.

### Transporte configurable
- `pkt_size` de **1316 bytes** (7×188, el clásico de estos equipos) o **188 bytes** (1×188).
- **UDP + RTP** opcional (`rtp_mpegts`, payload type 33) para los moduladores que lo exigen.
- El motor directo en Node respeta el tamaño de datagrama; con RTP el canal pasa por FFmpeg para llevar
  timestamps correctos.

### Exportación
- **CSV** del plan con canal, estándar, MHz de video, MHz de audio, banda, nombre, `udp://host:puerto`,
  transporte, service ID, perfil, equipo y estado: listo para cargar a mano en la web del modulador.
- **M3U** del plan UDP para probar los canales con VLC.

### Otros cambios de la versión
- Diagnóstico de reproducción por canal (`⋯ → Diagnosticar origen`): origen → motor → entrega, con el
  HTTP real y acciones concretas.
- Modelos de WK2500 de 32/64/125 canales y armado rápido de equipos.
- Instalador y releases versionados (`install.sh` con verificación SHA256, `tvlister-admin release`).

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| UDP `pkt_size=1316` | datagramas de 1316 B, sync 0x47 |
| UDP `pkt_size=188` | 188 B por datagrama |
| UDP+RTP | RTP v2, PT 33 (MPEG-TS), TS en el byte 12 |
| 4 × 32 canales | CH 2–33 / 34–65 / 66–97 / 98–125, cobertura 124/124 |
| Estándar PAL B/G | CH 2 = 48.25 MHz (audio 53.75), CH 33 = 471.25 MHz |
| Override de MHz | se mantiene bloqueado y vuelve al plan al pulsar ↺ |
| Validaciones | estándar inválido, `pkt_size` inválido y solape → 400/409 con motivo |

---

## Requisitos

- Ubuntu 22.04 / 24.04 o Debian 12, x86_64 o arm64, acceso `root`.
- Modulador IP→analógico con entrada **MPEG-TS sobre UDP/RTP** (CSP-2500C o equivalente).
- NIC dedicada para el tráfico UDP hacia el switch de moduladores (recomendado).
