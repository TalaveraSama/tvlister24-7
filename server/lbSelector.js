/**
 * Elección de nodo para servir a un cliente (maestro o balancer).
 *
 * Vive aparte de `iptvApi.js` para poder probarlo sin arrancar el panel: aquí
 * entra lo que dicen los latidos (Mbps servidos, conexiones, CPU) y sale a
 * quién se le manda el cliente —o `null`, que significa «lo sirve el maestro».
 */

/** Capacidad de un nodo: su NIC declarada en Mbps (0/ausente = 800). */
export function nodeCapacityMbps(srv) {
  const cap = Number(srv?.max_bandwidth_mbps);
  return Number.isFinite(cap) && cap > 0 ? cap : 800;
}

/** 0 = vacío, 1 = al 100 %. Manda lo más cargado entre Mbps, conexiones y CPU. */
export function nodeLoadRatio(srv) {
  const bw = Number(srv?.bandwidth_mbps) || 0;
  const cap = nodeCapacityMbps(srv);
  const conns = Number(srv?.active_conns) || 0;
  const maxConns = Number(srv?.max_clients) || 1000;
  const cpu = Number(srv?.cpu_usage) || 0;
  return Math.max(bw / cap, conns / Math.max(1, maxConns), cpu / 95);
}

/** Un nodo está lleno si su salida pasó del 95 % de su NIC o no admite más conexiones. */
export function nodeIsFull(srv) {
  const bw = Number(srv?.bandwidth_mbps) || 0;
  if (bw >= nodeCapacityMbps(srv) * 0.95) return true;
  if ((Number(srv?.active_conns) || 0) >= (Number(srv?.max_clients) || 1000)) return true;
  if ((Number(srv?.cpu_usage) || 0) >= 95) return true;
  return false;
}

/**
 * Devuelve el nodo elegido o `null` si debe atender el maestro.
 *
 * - Sólo se consideran nodos no llenos.
 * - `mode` filtra por país (`geoip`) o ISP (`isp`) si hay coincidencias; si no
 *   las hay, se usan todos (nunca se deja al cliente sin nadie).
 * - `offloadPct` = 0 reparte siempre entre maestro y nodos (el más libre gana).
 *   Con 70, el maestro atiende mientras esté por debajo del 70 % de su tope y
 *   a partir de ahí los clientes nuevos van a los nodos.
 * - Se exige 5 puntos de diferencia para quitarle clientes al maestro, así no
 *   hay saltos entre nodos por diferencias mínimas.
 */
export function pickTarget({ nodes = [], masterRatio = 0, mode = 'load', country = '', isp = '', offloadPct = 0 } = {}) {
  const available = (Array.isArray(nodes) ? nodes : []).filter((n) => !nodeIsFull(n));
  if (available.length === 0) return null;

  const wantsGeo = mode === 'geoip' && country;
  const wantsIsp = mode === 'isp' && isp;
  let candidates = available;
  if (wantsGeo) {
    const byCountry = available.filter((n) =>
      String(n.region_countries || '')
        .toUpperCase()
        .split(',')
        .map((c) => c.trim())
        .includes(String(country).toUpperCase().trim())
    );
    if (byCountry.length) candidates = byCountry;
  } else if (wantsIsp) {
    const byIsp = available.filter(
      (n) => n.isp_match && String(isp).toLowerCase().includes(String(n.isp_match).toLowerCase().trim())
    );
    if (byIsp.length) candidates = byIsp;
  }

  const ranked = candidates
    .map((node) => ({ node, ratio: nodeLoadRatio(node) }))
    .sort((a, b) => a.ratio - b.ratio);

  const best = ranked[0];
  const offload = Number(offloadPct) || 0;
  if (offload > 0) {
    // Umbral: por debajo, el maestro atiende (tiene sitio); al pasarlo, se
    // reparte a los nodos. Así el ancho de banda extra sólo entra en hora pico.
    if (Number(masterRatio) * 100 < offload) return null;
    return best.node;
  }
  // Sin umbral: reparto libre entre maestro y nodos. El maestro atiende si está
  // claramente más libre que el mejor nodo (5 puntos, para no botar clientes).
  if (Number(masterRatio) <= best.ratio - 0.05) return null;
  return best.node;
}
