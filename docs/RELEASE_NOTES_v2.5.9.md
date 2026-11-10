# TVLister 24/7 — v2.5.9 «Llenar el plan y cazar destinos cruzados»

Tu `catv check` ya sale con **0 errores**. Quedaban dos cosas: 122 portadoras sin canal y ningún aviso cuando un
plan queda apuntando a la dirección de fábrica.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.9
tvlister-admin restart
```

---

## 1. `tvlister-admin catv fill` — llenar las portadoras (menú 20)

Asigna los canales del panel a las portadoras libres, **en orden y sin repetir**.

```bash
tvlister-admin catv fill                   # vista previa (no escribe nada)
tvlister-admin catv fill --apply           # asigna y marca para emitir
tvlister-admin catv fill --apply --force   # reasigna también las que ya tienen canal
tvlister-admin catv fill --apply 2 64      # limitar el rango
```

```
  Moduladores        : 4 (124 portadoras)
  Canales en el panel: 145
  Ya asignados       : 2
  Canales libres     : 143
  A asignar ahora    : 122
```

Reglas: sólo toca portadoras cubiertas por un equipo, no repite canales, no pisa lo asignado (salvo `--force`),
y **recalcula el destino UDP con la base de cada modulador**.

Después: `tvlister-admin restart` o el botón **Iniciar todo** en UDP / CATV.

---

## 2. Destinos cruzados: ahora es un error, no un silencio

Antes un plan a medio aplicar se veía «todo OK» aunque decenas de portadoras apuntaran a `239.25.0.x`, donde no hay
nadie escuchando. Nueva comprobación en `catv check` y en **Comprobar**:

```
[!!] 1 portadora(s) apuntan a un destino que no es el de este equipo
     Ej.: CH10 → 239.25.0.10:5010; según la base del equipo debería ser 239.1.1.10:1010.
     Arréglalo con «tvlister-admin catv fill --apply» o reaplicando el equipo en el panel.
```

Y `catv fill --apply` lo repara también en las portadoras **sin** canal:

```
  [OK] No queda nada por asignar en ese rango.
  [OK] 56 destino(s) UDP corregidos con la base de cada modulador.
```

---

## Verificación realizada

Plan sintético 2 × 32 multicast `239.1.1.0:1000`, 8 canales en el panel:

| Caso | Resultado |
| --- | --- |
| `fill` sin canales libres | «No queda nada por asignar», no escribe |
| Primera pasada | 8 asignadas, 8 destinos calculados con la base del equipo |
| Segunda pasada | idempotente: 0 cambios |
| `--force` | reasigna las 8 y avisa cuántas quedarían vacías |
| `--apply` con 56 portadoras sin canal | corrige las 56 direcciones de fábrica |
| `catv check` después | «Todos distintos, del 239.1.1.2:1002 al 239.1.1.33:1033» |
| Dirección cambiada a mano (CH10) | `udp-mismatch` la marca como error con el valor correcto |

---

## Lo que te queda en tu servidor

1. **Llenar el plan**: `tvlister-admin catv fill` → revisar → `--apply` → `tvlister-admin restart`.
2. **Plantilla** por modulador (para que el CSV lleve nombres en el formato del equipo): *UDP / CATV → Plantilla*.
3. **Página de entrada** de cada equipo: cargar el `CSV entrada UDP` (sólo los grupos de **ese** equipo) o copiar
   la tabla desde **Comprobar**.
4. Listo: los 3 avisos de plantilla son la única causa que queda.
