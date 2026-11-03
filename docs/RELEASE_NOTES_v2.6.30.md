# v2.6.30 — Reparto de canales entre nodos (para que 10 VPS quepan en un maestro)

Publicada el 2 de noviembre de 2026. Sobre la v2.6.29 (balancers con caché e instalador desde el panel).

## Qué pediste

> «…ya sea que tenga 10 VPS»

Con la v2.6.29 los nodos ya sumaban ancho de banda, pero quedaba un techo: **cada nodo pide al maestro una
copia por cada canal distinto que sirve**. Con 10 VPS sirviendo los 148 canales, el maestro tendría que subir
`148 × bitrate × 10` y su 1 Gbps no da. Esta versión lo arregla repartiendo **qué canales sirve cada nodo**.

## Cómo funciona

| Pieza | Qué hace |
| --- | --- |
| `streams.server_id` (ya existía, ahora se usa) | Nodo dueño del canal. `1`/vacío = lo sirve el maestro |
| `server/nodeAffinity.js` | Reparto ponderado por capacidad, resumen por nodo y comprobación de que el nodo sigue sano |
| `selectEdgeRedirect(req, { streamId })` | **La afinidad manda**: si el canal está asignado a un nodo sano, todos sus clientes van ahí, aunque el maestro esté más libre |
| Si el nodo está lleno, caído o sin latido (>90 s) | El canal **no se queda sin servicio**: cae al reparto normal y lo atiende el maestro u otro nodo |
| Al borrar un nodo | Sus canales vuelven al maestro (no quedan apuntando a un id inexistente) |

### El resultado con 10 VPS

Repartiendo los canales, el maestro sube **una sola vez por canal en total** (no una vez por nodo):

| Reparto | Subida del maestro a los nodos | Nodos con 1 Gbps |
| --- | --- | --- |
| Antes: los 10 nodos con los 148 canales | 444 Mbps **por nodo** = 4,4 Gbps | 2 |
| Ahora: 148 canales repartidos en 10 nodos | ~444 Mbps **en total** (≈44 Mbps por nodo) | 10 |

## En el panel

*Sistema → Nodos Edge Load Balancer → **Reparto de canales entre nodos***:

- **Repartir automáticamente**: reparte todo el catálogo por turnos, ponderando por la NIC de cada VPS
  (800 Mbps = 2 turnos, 400 Mbps = 1). Con 10 nodos de 1 Gbps, ~15 canales cada uno.
- Cada nodo muestra **cuántos canales tiene**, con dos atajos: **todos** (se queda el catálogo completo) y
  **liberar** (devuelve sus canales al maestro).
- Los nodos **offline o sin latido** no entran en el reparto, así no se manda gente a un servidor muerto.

Por API:

| Ruta | Qué hace |
| --- | --- |
| `GET /api/servers/streams` | Resumen: canales por nodo (maestro incluido) |
| `POST /api/servers/:id/streams` | `{ streamIds }` asigna · `{ mode: 'all' }` todo · `{ mode: 'clear-all' }` los devuelve · `{ categoryId }` por categoría |
| `POST /api/servers/balance-streams` | `{}` reparte · `{ serverIds }` sólo esos nodos · `{ reset: true }` todo al maestro |

## Pruebas

| Prueba | Qué comprueba | Resultado |
| --- | --- | --- |
| `node scripts/test_node_affinity.mjs` | Reparto ponderado (nodo de 800 Mbps recibe el doble que uno de 400), afinidad manda sobre la carga, nodo lleno/caído/sin latido no usable, **redirect real `/live/...` que va al nodo asignado** (302) y vuelve al reparto si ese nodo cae, liberar canales, borrar nodo, maestro rechaza asignaciones | **27 OK** |
| `node scripts/test_balancer_ui.mjs` | La tarjeta nueva: resumen, «Repartir automáticamente», mensaje de resultado | **23 OK** |
| `test_balancer_lb` / `test_balancer_api` | Siguen pasando (caché, heartbeat, instalador) | **36 + 23 OK** |

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.30/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.30
```

En un panel ya instalado: `tvlister-admin update`. Los nodos no se reinstalan.

## Cómo dejarlo listo con tus VPS

1. Instala o registra cada VPS en *Nodos Edge Load Balancer* (IP + clave + Mbps de su enlace).
2. Espera a que aparezcan **online** (primer latido, 10 s).
3. Pulsa **Repartir automáticamente**.
4. Comprueba en cada nodo que su `bandwidth_mbps` se mantiene muy por debajo de su NIC: eso significa que
   el maestro sólo le manda sus canales.
5. Si un canal debe quedarse en un VPS concreto (por audiencia o por ISP), ponlo con **todos** en ese nodo y
   reparte el resto.

> Nota: la afinidad es por canal, no por cliente. Es lo correcto: si dos clientes del mismo canal cayeran en
> nodos distintos, el maestro subiría ese canal dos veces.
