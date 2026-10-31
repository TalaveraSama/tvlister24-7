# TVLister 24/7 — v2.5.8 «Multicast bien comprobado · CSV por página»

Dos arreglos sobre lo que viste en tu `catv check`:

1. Ya **no hace ping a un grupo multicast** (`239.1.1.0` no es un equipo, es la base del rango).
2. El CSV se parte en las **dos páginas** que de verdad tiene el modulador: **canales** y **entrada UDP**.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.8
tvlister-admin restart
tvlister-admin catv check
```

---

## 1. Multicast: lo que estaba mal en la comprobación

En tu salida aparecía por cada equipo:

```
[!] 239.1.1.0 no responde a ping
```

Era un **falso aviso**: `239.1.1.0` es la base del rango multicast, no la IP de un modulador. Un grupo nunca
contesta a ICMP. Ahora:

| Antes | Ahora |
| --- | --- |
| `ping 239.1.1.0` | **no hay ping** en multicast; se consulta la ruta al **grupo del primer canal** |
| — | comprueba **TTL** (avisa si es 1: no cruza ni un switch) |
| — | avisa si **varios equipos comparten IP**: normal en multicast, **error en unicast** |
| — | recuerda que cada equipo debe tener **sólo sus grupos** |

Resultado esperado en tu caso:

```
[OK] Sale por ens38 hacia el grupo 239.1.1.2 · IP de origen 192.168.200.8
[OK] 4 equipos comparten la base multicast 239.1.1.0  (es correcto)
[OK] Multicast: 32 grupos (239.1.1.2:1002 … 239.1.1.33:1033)
```

---

## 2. El CSV se parte en dos: canales y entrada

Esto explica tu «no cambia el UDP». El modulador tiene **dos tablas** y el archivo de una **no toca** la otra:

| Página del equipo | Qué lleva | CSV del panel |
| --- | --- | --- |
| **Canales** | Canal RF + MHz de vídeo y audio | `CSV canales` |
| **Entrada / Input / Mapping** | Grupo o IP + puerto UDP por portadora | `CSV entrada UDP` |

```
channel →  Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,Nombre_Canal
           1,2,55.25,59.75,CH2

input   →  Portadora,IP_Destino_UDP,Puerto_UDP,Nombre_Canal
           1,239.1.1.2,1002,CH2
```

Dónde están: **Comprobar** → botones *CSV canales* / *CSV entrada UDP* / *Copiar entrada UDP*.
También por API: `export-table?format=channel&unit_id=1` y `export-table?format=input&unit_id=1`.

`catv check` ahora imprime las dos tablas por separado, en el orden en que se teclean en cada página.

---

## 3. Tu reparto real, verificado

| Equipo | Portadoras | Grupos |
| --- | --- | --- |
| WK2500 1 | CH 2–33 | `239.1.1.2:1002` … `239.1.1.33:1033` |
| WK2500 2 | CH 34–65 | `239.1.1.34:1034` … `239.1.1.65:1065` |
| WK2500 3 | CH 66–97 | `239.1.1.66:1066` … `239.1.1.97:1097` |
| WK2500 4 | CH 98–125 (28) | `239.1.1.98:1098` … `239.1.1.125:1125` |

Regla multicast: `host = base con el último octeto = canal`, `puerto = base_port + canal`.
Los cuatro comparten la base **y es correcto**.

---

## 4. Si tu modulador espera unicast

Muchos 2500C reciben en **una IP propia** (`192.168.200.x`), no por grupo. En ese caso:

1. Edita cada equipo → **modo unicast** → **su** IP (`.10`, `.11`, `.12`, `.13`).
2. Vuelve a `Comprobar`: si dos equipos quedan con la misma IP en unicast, ahora sale como **error**, porque el
   switch entregaría el flujo al primero.

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| Plan real 4 × 32 en multicast `239.1.1.0:1000` | grupos por canal correctos, 33/33 y 29/29 filas en los CSV |
| Ping a multicast | **ya no se intenta**; se informa ruta al grupo |
| Base compartida entre 4 equipos | `[OK]` en multicast, error si fuera unicast |
| TTL | aviso cuando es 1 |
| `format=channel` (equipo 4) | `1,98,109.25,113.75,CH98` … 28 portadoras |
| `format=input` (equipo 1) | `1,239.1.1.2,1002,CH2` … 32 portadoras |
| CLI | imprime tabla de canales y de entrada, separadas |
| Nombres | la columna `Nombre_Canal` sale de `custom_name` → nombre del canal → `CHn` |
