# TVLister 24/7 — v2.5.5 «El formulario ya no se borra · prebuffer de estabilidad»

Dos cosas: el **fallo que borraba lo que escribías** en *Motor FFmpeg* y el **prebuffer activado** para que la
imagen entre firme desde el primer segundo.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.5
tvlister-admin restart
tvlister-admin tune apply      # deja el prebuffer de estabilidad (2 segmentos)
```

---

## 1. Se borraban las opciones al ir a guardar — arreglado

**Qué pasaba.** La página refresca *Motor FFmpeg* cada 15 s. Esa función de refresco se registró una sola vez al
abrir la página y leía el estado «hay cambios sin guardar» **congelado en `false`**. Resultado: a los pocos
segundos de empezar a editar, el refresco pisaba el formulario con los valores guardados y **borraba lo escrito**
— justo cuando ya estabas bajando a pulsar Guardar.

**Qué se hizo.**

| Cambio | Efecto |
| --- | --- |
| `dirtyRef` / `savingRef` | El refresco automático **ya no toca el formulario** si hay cambios sin guardar o se está guardando |
| Barra flotante abajo | **N cambio(s) sin guardar** + *Guardar y reiniciar escalonado* + *Descartar*, siempre visible |
| Botón **Descartar cambios** | Vuelve a lo guardado sin reiniciar canales |
| Refresco intacto | Los contadores (canales, RAMDisk, prebuffer, segmentos faltantes) siguen actualizándose |

Ahora puedes editar, bajar tranquilamente y guardar: lo que escribiste sigue ahí.

---

## 2. Prebuffer de estabilidad (prioridad: que se VEA)

| Ajuste | Antes | Ahora |
| --- | --- | --- |
| Segmentos de prebuffer | 0 (apagado) | **2** (4 s ya escritos) |
| Espera máxima | 3000 ms | **6000 ms** |

- El panel **no responde el manifiesto** hasta que la ventana tiene 2 segmentos, así el reproductor arranca con
  imagen y sonido reales en vez de con un segmento a medias.
- El tailer MPEG-TS arranca con la misma ráfaga de 2 segmentos.
- **La espera está topada en 6 s**: si el canal no llega, se entrega lo que haya (`State: timeout`). Nunca se
  queda colgado — el error de v2.5.1 fue justo lo contrario (entregar *menos* ventana).
- Perfil rápido nuevo en la página: **«Máxima estabilidad · con prebuffer»**.

**Medido con un canal real servido por el panel**

| Prueba | Resultado |
| --- | --- |
| Canal en marcha | 200 en 3 ms, `X-TVLister-Prebuffer: 2`, `ready`, sin espera |
| Canal recién arrancado | 200 en 2137 ms, esperó 1955 ms hasta tener 2 segmentos, `ready` |
| Reproducción real (ffmpeg leyendo del panel, 12 s) | **275 frames + audio**, sin errores |
| Cliente `.ts` | 2.47 MB en 8 s, continuo |

**La línea de argumentos de FFmpeg no se toca**: el prebuffer es entrega/lectura, no codificación.

Un reproductor concreto puede saltarse la espera con `?prebuffer=0` (o cabecera `X-XUI-Prebuffer: 0`) sin
cambiar la configuración global.

---

## Resumen de la recomendación actual (`tvlister-admin tune`)

```
Segmento HLS 2 s · manifiesto 6 (12 s de ventana)
Prebuffer 2 segmentos · espera máxima 6000 ms
Sondas HTTP 5 MB / 4 s · locales 1.5 MB / 1.5 s
Hilos x264 según núcleos · log error con ≥100 canales
Reserva de RAMDisk 10 % de /dev/shm
```
