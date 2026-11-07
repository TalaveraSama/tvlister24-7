# TVLister 24/7 — v2.5.13 «Salida constante»

«Necesito que sea constante». Ya lo es, y el motivo de que no lo fuera estaba en el **motor que se elegía por
canal**, no en FFmpeg.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.13
tvlister-admin restart
```

Al reiniciar, los canales cuyas fuentes son **HTTP MPEG-TS** (las de Flussonic, `http://…?ts`) pasan solos a salir
dosificados. No hay que configurar nada.

---

## 1. La causa: el motor directo copiaba los bytes tal como llegaban

| Fuente del canal | Motor hasta v2.5.12 | ¿Dosificaba? |
| --- | --- | --- |
| `http://…` MPEG-TS | `direct_dgram` (Node copia el cuerpo HTTP al socket) | **No** |
| `.m3u8` / HLS | `ffmpeg` | Sí, desde v2.5.11 |

`direct_dgram` no abre un proceso por canal —eso es cómodo— pero **no espera**: si el origen entrega de golpe un
segmento de 2 s, la salida sale de golpe. De ahí el 6, el 10, el 2 y el 0.

Ahora, con el dosificado activo, las fuentes **HTTP/TS van por FFmpeg** (`-c copy` + `-re`). El motor directo queda
para **MNF** (que ya llega dosificado por la red) y para quien lo fuerce con `TVLISTER_CATV_DIRECT=1`.

Además, `-re` se aplica **también cuando la portadora tiene `muxrate`**: el CBR sólo rellena con paquetes nulos,
**no dosifica la lectura** (lo medí: CBR sin `-re` seguía saliendo a trozos).

---

## 2. Lo medido (worker real del panel, no un ffmpeg de laboratorio)

Origen a trozos: 800 KB de golpe cada 2 s, canal de 2,94 Mbps.

| Configuración | Media | Pico | Ráfagas | Tramos en 0 | Por segundo |
| --- | --- | --- | --- | --- | --- |
| motor directo (antes) | 0,49 Mbps | 1,96 | 4,0× | 15 | `0.0 1.0 0.0 1.0 0.0 1.0…` |
| FFmpeg + `-re` (ahora) | 2,92 Mbps | 3,28 | **1,12×** | **0** | `2.9 3.0 2.8 3.0 3.0 2.8 2.9 2.8` |
| FFmpeg + `-re` + CBR 3,40 | **3,40 Mbps** | 3,87 | 1,14× | **0** | `3.3 3.6 3.2 3.5 3.1 3.7 3.3 3.6` |

Y de paso el nombre: con el motor directo salía `Service01`; con FFmpeg sale el del canal. La corrección del nombre
de v2.5.11 **sólo alcanzaba a los canales que ya iban por FFmpeg**.

---

## 3. `tvlister-admin catv steady` (menú 22)

Enseña cómo va a salir cada canal **sin reiniciar nada**:

```
============================================================
  TVLister 24/7 - Salida UDP CONSTANTE hacia los moduladores
  4 canal(es) habilitados con origen
============================================================

  CANAL  MOTOR         DOSIFICADO    DECLARADO    MUXRATE  NOMBRE
  CH2    ffmpeg        si (-re)      2.90 Mbps  3.40 Mbps  CANAL 2 NACIONAL  [CBR 3.40 Mbps (+15%)]
  CH3    ffmpeg        si (-re)      2.50 Mbps          -  Telemundo
  CH4    direct_dgram  NO            2.50 Mbps          -  MNF Nicaragua

------------------------------------------------------------
  [OK] Todos los canales con FFmpeg salen dosificados (-re).
  [!!] 1 canal(es) por el motor directo (sin dosificar): CH4
```

```bash
tvlister-admin catv steady                    # vista previa
tvlister-admin catv steady --apply --cbr      # + CBR por portadora (headroom 15 % por defecto)
tvlister-admin catv steady --apply --cbr --headroom 25
tvlister-admin catv steady --apply --clear    # volver a VBR dosificado
tvlister-admin restart
```

---

## 4. CBR: úsalo sólo si lo necesitas

El CBR rellena con paquetes nulos hasta el `muxrate`, así que un canal de 2,9 Mbps con `muxrate 3,40` **ocupa
3,40 Mbps de subida de verdad**. Con 96 canales son ~50 Mbps extra en el enlace.

- **Recomendado**: dejar sólo `-re` (ya es constante en la práctica: 2,8–3,1 en un canal de 2,94).
- **CBR** sólo si el modulador o el operador exigen una cifra clavada.

---

## 5. Comprobación (30 segundos)

```bash
tvlister-admin restart
sudo tvlister-admin catv watch --secs 10 --ip 192.168.200.8
```

Debe salir, en cada canal:

```
        perfil: █▇▆▇▇▇█▇▇▇▇▇█▇▇▇  (500 ms cada símbolo)
        por segundo (Mbps): 2.9 3.0 2.8 3.0 3.0 2.8 2.9 2.8
        forma : constante
```

Si un canal sigue `a trozos`, ese canal no se ha reiniciado; si sale `cortes`, el origen no entrega más rápido de
lo que el flujo pide y el dosificado no puede inventarlo.

---

## Detalles técnicos

- `server/wk2500Manager.js`: `shouldUseDirectNodeUdpEngine()` no elige el motor directo para HTTP/TS cuando el
  dosificado está activo (salvo `TVLISTER_CATV_DIRECT=1`); `usePacing` ya no se desactiva por tener `muxrate`.
- `catvOutputPlan()` calcula, con las funciones reales del motor, motor + `-re` + `muxrate` por canal (lo usa
  `catv steady`; no es una estimación).
- El dosificado global sigue siendo `TVLISTER_CATV_PACING` (`0` lo desactiva) y ahora también controla qué motor
  se elige.

---

## Prueba realizada

| Caso | Resultado |
| --- | --- |
| `catv steady` (vista previa) | CH2 → `ffmpeg` · `si (-re)` · declarado 2,90 Mbps |
| `--apply --cbr` | escribe `muxrate 3400` (+15 %) en 1 canal · aviso de reinicio |
| `--apply --clear` | deja `muxrate 0` |
| Worker real con origen a trozos | media 2,92 · pico 3,28 · ráfagas 1,12× · 0 tramos en 0 · `constante` |
| Mismo worker con `TVLISTER_CATV_DIRECT=1` | media 0,49 · pico 1,96 · 15 tramos en 0 · `a trozos` · SDT `Service01` |
| Con CBR 3,40 aplicado | media 3,40 exacta · `constante` |
