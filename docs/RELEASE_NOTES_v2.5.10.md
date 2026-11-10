# TVLister 24/7 — v2.5.10 «Medir el UDP que llega de verdad»

El modulador marca más Mbps de los que debería (30 Mbps en un canal de 2–3) y las portadoras no quedan parejas.
Antes de cambiar nada hay que saber **quién** mete esos megas. `tvlister-admin catv watch` lo mide desde el
lado del modulador, no desde el contador del panel.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.10
tvlister-admin restart
```

---

## 1. `tvlister-admin catv watch` — medir como mide el modulador (menú 21)

Se une al grupo multicast de cada portadora y cuenta bytes, paquetes y PIDs durante N segundos.
No usa el contador del panel: eso es precisamente lo que hay que comparar.

```bash
tvlister-admin catv watch                      # canales habilitados con origen
tvlister-admin catv watch --secs 8             # 8 s por canal
tvlister-admin catv watch --ch 2,3,45          # sólo esos canales
tvlister-admin catv watch --ip 192.168.200.8   # NIC de los moduladores
tvlister-admin catv watch 2                    # sólo el equipo 2
```

```
============================================================
  TVLister 24/7 - Medición real del UDP hacia los moduladores
  4 canal(es) · 5 s cada uno (≈1 min en total) · interfaz: 192.168.200.8
  Se mide lo MISMO que recibe el modulador: se une al grupo y cuenta.
============================================================

  CANAL  EQUIPO           DESTINO UDP                  MEDIDO   PKT/S   DECLARADO  PIDs
  CH2    CSP-2500C 1     239.1.1.2:1002            2.61 Mbps     248   2.50 Mbps  0x0065 0x0066
  CH3    CSP-2500C 1     239.1.1.3:1003           29.61 Mbps    2812   2.50 Mbps  0x0065 0x0066
        [!!] EXCESO 11.8× lo declarado
        origen: http://…
        motor : direct_spts · muxrate (CBR): 0 kbps  <- sin límite: la salida va al ritmo del origen
  CH4    CSP-2500C 2     239.1.1.4:1004            2.60 Mbps     297   2.50 Mbps  0x0065 0x0066
        [!!] 7.1% PAQUETES DUPLICADOS
        [!!] 594 paquete(s) con el mismo continuity_counter → el mismo TS llega más de una vez

  Mediana del conjunto: 2.61 Mbps
  [!!] DESBALANCEADOS (1): CH3 29.61 Mbps
```

### Qué detecta

| Señal | Causa | Arreglo |
| --- | --- | --- |
| `EXCESO N×` | fuente más gorda de lo que se cree, o salida en ráfagas | revisar origen; poner `muxrate (CBR)` por portadora |
| `N% PAQUETES DUPLICADOS` | **otro emisor** en el mismo grupo (Flussonic, otro TVLister, dos portadoras al mismo `IP:puerto`) | dejar un solo emisor; `catv fill --apply` |
| `mismo destino que CH n` | dos canales al mismo `IP:puerto`: el modulador **suma** ambos flujos | corregir destinos |
| `NO LLEGA NADA` | el grupo no entra por esa NIC | `--ip <IP de la NIC correcta>` |
| `captura incompleta` | el kernel perdió paquetes: el valor real es algo mayor | subir `net.core.rmem_max` |
| `Puerto N privilegiado` | los puertos < 1024 exigen root | `sudo` |

### Cómo se interpreta en dos pasos

1. **Panel ≈ modulador** → el problema está en el origen: la fuente entrega más bitrate del que se pensaba, o
   el flujo va en ráfagas al recuperarse de un corte.
2. **Panel < modulador** → hay **otro emisor** en ese grupo. Lo delata el porcentaje de paquetes duplicados,
   porque el mismo `continuity_counter` llega repetido.

### Por qué importa el `muxrate`

Con `output_mode = direct_spts` y `muxrate = 0` la salida va **al ritmo del origen**. Si el origen se retrasa y
luego se recupera (reconexión, búfer del CDN), el modulador ve picos de decenas de Mbps en una portadora.
Fijar `muxrate (CBR)` por portadora entrega un flujo constante y predecible.

---

## 2. Detalles técnicos

- `server/catvWatch.js`: `measureUdpStream()` (socket UDP con `SO_REUSEADDR`, `recvbuf` de 8 MB, unión al grupo
  por la NIC indicada, parseo TS a paso 188, contadores por PID) y `watchCatvOutput()` (recorre los canales,
  compara con `streams.bitrate_kbps`, calcula mediana y marca desbalance).
- Detección de duplicados por `continuity_counter`; los paquetes de sólo adaptación (`afc = 2`) se excluyen
  porque repiten el contador de forma legítima.
- Si el `recvbuf` queda corto, la pérdida se estima con los huecos del `continuity_counter` y se avisa.
- Los puertos CATV habituales (`base_port 1000` → 1002, 1003…) son **privilegiados**: el comando debe correr
  como root, igual que el servicio.

---

## Prueba realizada

Cuatro grupos multicast `239.1.1.x` con emisores sintéticos (uno correcto, uno de 30 Mbps, uno duplicado y uno
sin tráfico), declarado 2500 kbps en todos:

| Caso | Resultado de `catv watch` |
| --- | --- |
| Grupo a 2.6 Mbps | `2.61 Mbps` · 248 pkt/s · sin avisos |
| Grupo a 30 Mbps | `29.70 Mbps` · `EXCESO 11.9×` · marcado como desbalanceado |
| Grupo con cada paquete enviado dos veces | `7.1% PAQUETES DUPLICADOS` + 594 contadores repetidos |
| Grupo sin emisor | `NO LLEGA NADA` |
| Dos canales con el mismo `IP:puerto` | `mismo destino que CH 6` en ambos |
| Puertos 1002–1005 sin root | `Puerto 1002 privilegiado (<1024): ejecuta el comando como root` |
