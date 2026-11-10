# TVLister 24/7 — v2.5.25 «Panel invisible y el UDP lo puede empujar Flussonic»

Dos cosas, y ninguna cambia lo que ya te funcionaba:

1. El panel ya no se ve: sin código de acceso no aparece ni la pantalla de login. Los códigos
   se crean **sólo desde la terminal**.
2. El UDP de CATV puede seguir generándolo TVLister (como siempre) o **empujarlo Flussonic
   23.12**, canal por canal, controlado por su API.

```bash
tvlister-admin release v2.5.25
tvlister-admin access-code close        # deja el panel invisible
tvlister-admin access-code add mipanel admin
```

---

## 1. Panel invisible (`access-code close`)

Antes, el panel sólo pedía código **si ya existía uno**. Si no había ninguno, cualquiera
llegaba al login. Ahora hay un candado explícito:

```
🔒 Panel cerrado: sin código de acceso no se ve ni la pantalla de login.
   Todavía no hay ningún código activo. Crea el primero AHORA:
     tvlister-admin access-code add micodigo admin
```

Detalles:

- Mientras no haya código, la propia pantalla lo dice (no te deja en un callejón sin salida):
  *"Todavía no hay ningún código creado. Se crean en el servidor: …"*.
- **Se cierra también la API**: `/api/auth/login` ya no responde sin la cookie del código. Antes
  se podía pedir un token con un `curl` saltándose la puerta; ahora no.
- Se abre cuando quieras: `tvlister-admin access-code open`.
- El código se crea **sólo desde terminal**. Si intentas crearlo desde el panel:
  `403 · Los códigos de acceso se crean sólo desde la terminal del servidor`.
- Lo que **nunca** se cierra: `get.php`, `player_api.php`, `xmltv.php`, `/live/`, HLS, MAG,
  MNF y el portal WebTV. Tus clientes no notan nada.

```bash
tvlister-admin access-code              # estado: códigos, usos y si el panel está cerrado
tvlister-admin access-code add socio.2026 reseller "revendedor Rubén"
tvlister-admin access-code close|open   # cerrar / quitar el cierre forzado
tvlister-admin access-code off          # apaga todos los códigos
```

## 2. Quién genera el UDP: TVLister o Flussonic

Hasta ahora el MPEG-TS hacia los moduladores lo generaba **siempre** TVLister (socket propio
o ffmpeg). Eso sigue siendo el valor por defecto y **no se ha tocado ni una línea de ese
camino**. Lo nuevo es poder elegir, por canal:

| Motor | Quién empuja el TS | Cuándo conviene |
| --- | --- | --- |
| `local` (**por defecto**) | TVLister: socket propio `direct_dgram` o ffmpeg | Producción actual: 4 × CSP-2500C, NIC dedicada, 124 portadoras, control total del ritmo y del CBR |
| `flussonic` | El stream de Flussonic 23.12, configurado por su API | Cuando el canal **ya vive en Flussonic** y no quieres dos procesos generando el mismo flujo |

### Cómo se usa

```bash
tvlister-admin catv udp-engine                        # estado: cuántos canales en cada motor
tvlister-admin catv udp-engine flussonic 12 mi_stream # el CH 12 lo empuja Flussonic
tvlister-admin catv udp-engine flussonic 2-33         # un rango entero
tvlister-admin catv udp-engine local 12               # devolver ese canal a TVLister
tvlister-admin catv udp-engine sync                   # (re)aplica las salidas en Flussonic
```

En el panel: tarjeta **«Motor UDP: quién empuja el TS a los moduladores»** en *CATV WK2500*,
con contadores, selector de motor, rango de canales y botón *Reaplicar en Flussonic*.

### Qué hace exactamente en modo Flussonic

1. Calcula la **misma** URL de salida que usaría el motor local (`udp://host:puerto` con
   `pkt_size`, `ttl` y `localaddr` de la NIC dedicada; `rtp://` si el canal lo pide).
2. La escribe en el stream de Flussonic (`PUT/PATCH /streamer/api/v3/streams/<stream>`),
   **conservando** las demás salidas e inputs que ese stream ya tuviera.
3. TVLister **deja de abrir socket y de lanzar ffmpeg** para ese canal.
4. Reaplica cada 2 minutos por si alguien edita el stream en Flussonic y borra la salida.
5. Al volver a `local` (o al apagar el canal) **retira** esa salida de Flussonic.
6. Guarda qué URL puso (`flussonic_output_url`) para poder sustituirla si cambias de puerto, sin
   acumular salidas viejas.

### Reglas para que no rompa nada

- **Un stream de Flussonic = una salida UDP.** Si dos canales CATV apuntan al mismo stream, se
  rechaza con un 409 explicando cuál lo tiene. (Comprobado: `El stream "canal_uno" ya empuja el
  UDP del CH2…`).
- Si Flussonic no acepta el cambio, **sólo ese canal** queda en error visible; los demás siguen
  emitiendo por donde estaban.
- Si el stream no existe o las credenciales fallan, no se toca nada y se informa del motivo.
- `PATCH` primero; si el servidor no lo admite (405/400/422), se hace `GET` + `PUT` **sólo con
  los campos escribibles**, para no perder transcoder ni inputs.

## 3. Cómo se probó (con Flussonic simulado, API v3 real)

| Prueba | Resultado |
| --- | --- |
| Encender CH2 en modo Flussonic | `PATCH`, salida escrita: `udp://192.168.200.8:5002?ttl=16` |
| Repetir el sync | `ya estaba` (idempotente, 0 escrituras) |
| Cambiar el puerto del canal | **sustituye** la salida (no acumula) |
| Servidor sin PATCH (405) | cae a `PUT` sin campos de sólo lectura; inputs y title intactos |
| Otra salida ya existente en el stream | se conserva |
| Volver a `local` | salida retirada de Flussonic; el canal vuelve al motor propio |
| Dos canales al mismo stream | `409` con el nombre del canal que ya lo usa |
| Sin servidor Flussonic configurado | se rechaza el cambio y el UDP sigue saliendo por TVLister |
| Panel cerrado | `/` muestra la puerta; `/api/auth/login` sin cookie → `401` |
| Panel cerrado con código | login `200`, panel `200` |
| Crear código desde el panel | `403` con el comando de terminal |
| Cliente IPTV con el panel cerrado | `get.php`, `player_api.php`, `xmltv.php` → `200` |
| `access-code open` | el login vuelve a funcionar sin código |

## 4. Por qué el UDP de producción no se ve afectado

- El valor por defecto de la columna nueva es `local`: en tu base de datos, los 124 canales
  siguen con el motor de siempre tras actualizar. No hay migración que los cambie.
- No se ha tocado `buildFfmpegUdpOutputArgs`, `TsUdpPacketizer`, `startWk2500ChannelWorker`
  (salvo la bifurcación hacia Flussonic cuando el canal lo pide) ni el cálculo de
  frecuencias/puertos de los CSP-2500C.
- El modo Flussonic es **opt-in por canal**: se puede tener 2–33 por TVLister y 34–65 por
  Flussonic a la vez.
