# TVLister 24/7 — v2.5.12 «Perfil del flujo: ¿a trozos o cortado?»

«Veo fluctuaciones de 6, 10, y bajadas a 2 y después 0». Eso ahora lo dice el propio comando, con el dibujo del
flujo y una frase que explica qué está pasando.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.12
tvlister-admin restart
```

---

## Qué se añade

`tvlister-admin catv watch` (menú **21**) imprime el **perfil real** del canal, un símbolo por cada 500 ms:

```
  CH2    CSP-2500C 1      239.9.9.1:7111            1.42 Mbps 9.50 Mbps     135   2.90 Mbps
        PIDs: 0x0100 0x0101 · ráfagas 6.67× · oscilación 199.7%
        perfil:  ▃   ▅   ▇   █   ▂    (500 ms cada símbolo)
        por segundo (Mbps): 1.5 0.0 3.0 0.0 3.9 0.0 4.7 0.0 1.0 0.0
        forma : a trozos: 5 entrega(s) corta(s), pico 6.67× la media
        → El flujo llega por segmentos: entra de golpe (ese es el 6–10 que ves) y luego
          silencio (el 2 y el 0). La media es la correcta; lo que baila es la lectura
          instantánea. Se aplana con -re en la salida; si sigue, el origen entrega tarde.
```

Y en un canal sano, para comparar:

```
        perfil: █▇▆▇▇▇█▇▇▇▇▇█▇▇▇  (500 ms cada símbolo)
        por segundo (Mbps): 3.0 2.7 2.9 3.1 2.8 2.9 3.0 2.9
        forma : constante
```

### Las cuatro formas

| Forma | Qué significa | Qué hacer |
| --- | --- | --- |
| `constante` | todo bien | nada |
| `a trozos: N entrega(s) corta(s)` | el origen entrega por segmentos (HLS de 2 s): los picos son el segmento completo entrando de golpe | `-re` (ya activo desde v2.5.11); si sigue, el origen entrega tarde |
| `cortes: N% del tiempo en 0` | el origen se cae, el canal se reinicia o el enlace no da el ancho | revisar origen y `last_error` del canal |
| `no llega nada` | el grupo no entra por esa NIC o el canal no emite | `--ip <NIC correcta>` |

**La diferencia entre «a trozos» y «cortes» está en la forma de los huecos**, no en la media: varias entregas
cortas (≤ 1 s) repetidas con huecos parecidos = el flujo está completo pero llega por segmentos. Un hueco largo o
un flujo que no vuelve = cortes de verdad.

### La cuenta, para que no haya magia

Un segmento de 2 s de un canal de 2,9 Mbps son ≈ 725 KB. Si entra en 0,2 s, ese instante va a ≈ 29 Mbps y los
1,8 s siguientes a 0. La media sigue siendo 2,9 Mbps; la lectura instantánea —la del modulador o la del panel—
salta entre 30, 6, 2 y 0 según cuándo se mire. **Los picos no se suman; los huecos sí se ven** (micro-congelados).

---

## Detalles técnicos

- `server/catvWatch.js`: `measureUdpStream()` devuelve `profileKbps` (kbps por trama de 500 ms) y
  `pattern` (`steady` · `chunky` · `gaps` · `uneven` · `none`), calculado por `classifyPattern()` a partir de los
  tramos activos/inactivos y del número de entregas cortas repetidas.
- El comando dibuja el perfil con ` ▁▂▃▄▅▆▇█` escalado al pico y resume por segundo.
- Sólo imprime la explicación cuando hay algo que explicar (`a trozos`, `cortes`, `no llega nada`).

---

## Prueba realizada (mediciones reales)

| Caso | Salida de `catv watch` |
| --- | --- |
| Origen que entrega 600 KB cada 2 s (segmento HLS) | `▃ ▅ ▇ █ ▂` · por segundo `1.5 0.0 3.0 0.0 3.9 0.0 4.7 0.0 1.0 0.0` · `a trozos: 5 entregas cortas` · pico 9,50 Mbps |
| FFmpeg con `-re` sobre la misma fuente | `█▇▆▇▇▇█▇▇▇▇▇█▇▇▇` · por segundo `3.0 2.7 2.9 3.1 2.8 2.9 3.0 2.9` · `constante` |
| Grupo sin emisor | `no llega nada` |
| Flujo que se corta a mitad | `cortes: N% del tiempo en 0` |
