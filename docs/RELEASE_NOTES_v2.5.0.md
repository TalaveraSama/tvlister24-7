# TVLister 24/7 — v2.5.0 «Bloques de canales por portadora»

Cada modulador IP→analógico puede ahora emitir **un bloque no contiguo de canales, en el orden exacto de sus
portadoras RF**. Con tus 4 equipos de 32 canales el reparto queda como lo tienes en campo: el equipo 1 lleva
`95, 2–28, 96–99`, y los otros tres se reparten el resto sin huecos ni solapes.

---

## Instalación / actualización

```bash
# servidor ya instalado
tvlister-admin release v2.5.0
tvlister-admin restart

# o desde el código del repositorio
tvlister-admin update
tvlister-admin restart
```

La base de datos se migra sola (columna nueva `wk2500_units.channels_json`); canales, streams, bouquets y
puerto actual se conservan.

---

## Novedades

### Lista exacta de canales por equipo
- Campo nuevo **«Canales del equipo — en el orden de las portadoras RF»** en el modal del equipo.
- Formato libre: `95, 2-28, 96-99` (también `–`, `..`, `;` o `P1:95`).
- La **primera entrada es la portadora 1**. Se conserva el orden tal como se escribe, incluso al reabrir el modal.
- Vacío = rango contiguo, como antes. Nada que ya funcionaba cambia de comportamiento.

### Reparto de tus 4 × 32 canales

| Equipo | Lista | Portadoras | Canales |
| --- | --- | --- | --- |
| 1 | `95, 2-28, 96-99` | 32/32 | 95, 2–28, 96–99 |
| 2 | `29-60` | 32/32 | 29–60 |
| 3 | `61-92` | 32/32 | 61–92 |
| 4 | `93-94, 100-125` | 28/32 | 93–94, 100–125 |

Total: **124 canales** cubiertos, 0 sin modulador, 4 portadoras libres en el equipo 4.

### Enrutado y cobertura correctos
- El panel manda cada canal **al equipo que realmente lo tiene**: CH95 sale a `udp://192.168.25.10:5095`
  (equipo 1), no al equipo 3.
- La cobertura, el «Activar asignados» y el aviso de canales huérfanos usan la lista real, no el rango.

### CSV en orden de programación
- Cabecera nueva: `Equipo, Portadora, Canal_CATV, Estandar_TV, Frecuencia_Video_MHz, …`
- Las filas van **equipo por equipo y en el orden de sus portadoras**: la fila 1 es la portadora 1 del equipo 1.
  Se teclea o se importa de arriba abajo en la web del modulador.

### Quitar canales a otro equipo sin pelear con el validador
- Si un canal ya pertenece a otro equipo, el modal lo avisa («N canal(es) ya los genera otro equipo»).
- Marcando **«quitar esos canales al otro equipo»**, el panel recorta la lista del equipo anterior y aplica el
  cambio en una sola operación. Antes había que reordenar los equipos a mano (`409`).

### Interfaz
- La tarjeta de cada equipo muestra `32/32 CH` y un recuadro **«Lista por portadora»** con `P1=CH95 · P2=CH2 …`.
- El modal previsualiza la lista como chips `P1 CH95`, `P2 CH2`, … y bloquea el guardado si excede la
  capacidad del modelo o del estándar de TV.

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| Crear equipo con `95, 2-28, 96-99` | 32 portadoras, P1 = CH95 @ 91.25 MHz |
| Cobertura 4 equipos | 124 canales, 0 huecos, 0 solapes |
| CH95 / CH29 / CH100 | → `.10:5095` / `.11:5029` / `.13:5100` |
| Canal repetido entre equipos | `409` nombrando el equipo dueño |
| Lista de 39 canales en modelo de 32 | `400` «sólo puede generar 32» |
| Recortar lista (PUT) | canales liberados, siguen encendidos si tienen stream |
| `steal_from_others` | el otro equipo se recorta y el canal pasa al nuevo |
| CSV | fila 1 = `"CSP-2500C #1",1,95,NTSC-M,91.25,95.75`, 124 filas |
| Reabrir el modal | la lista vuelve como `95, 2-28, 96-99` (orden intacto) |
| `auto-distribute` | vuelve a rangos contiguos y limpia la lista explícita |

---

## Compatibilidad

- Sin cambios en los argumentos de FFmpeg ni en el motor de salida UDP.
- Los equipos creados antes (sólo rango) siguen funcionando igual: la lista vacía significa «rango contiguo».
- El plan de frecuencias por estándar, `pkt_size` 188/1316 y RTP no cambian: **la lista mueve el canal de
  portadora, nunca su frecuencia**.
