# TVLister 24/7 — v2.5.18 «El video y la lista se mueven juntos»

Arreglado el reproductor del portal WebTV: al cambiar de canal, la lista de canales quedaba **encima**
del video y había que bajar desde arriba para volver a ver la señal.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.18
tvlister-admin restart
```

---

## 1. Qué pasaba

La lista de canales tenía una altura fija calculada como `100vh − 57px`, suponiendo que la barra
superior medía siempre 57 px. En el móvil (y en cualquier pantalla estrecha) la barra ocupa **dos
líneas** — el botón «Volver al Panel», el nombre de la línea, «Test Velocidad» y «Reportar Canal» —
así que la lista salía más alta que la pantalla y empujaba el reproductor fuera de vista.

Resultado: tocabas un canal, el video cambiaba… pero para verlo tenías que **subir y bajar** la página.

Además, al abrir el portal o cambiar de canal, la lista se quedaba **al principio**, con el canal que
estabas viendo en cualquier parte (o fuera de la zona visible).

## 2. Cómo queda

- **Móvil / tableta:** reproductor **arriba y fijo**, lista **debajo** con su propio desplazamiento.
  La página ya no se desplaza: el video y la lista van en conjunto.
- **La lista se abre siempre en el canal activo** y, al cambiar de canal, se centra sola en el que
  estás viendo. No hay que buscar ni bajar de arriba.
- **El alto de la barra superior se mide** (`ResizeObserver`) en vez de suponer 57 px: si la barra
  crece o el usuario rota el teléfono, la lista se recalcula.
- **Escritorio:** igual que antes (lista a la izquierda, player a la derecha), con el añadido de que
  la lista sigue al canal activo.
- Al elegir canal en móvil, si la página estaba desplazada se vuelve al video (red de seguridad para
  navegadores viejos que no soportan `dvh`).

## 3. Cómo comprobarlo

En el teléfono, con el portal WebTV abierto:

1. Entra al portal y elige un canal cualquiera → el video se ve arriba, sin tocar nada.
2. Baja por la lista hasta el canal 60, tócalo → el video cambia **y sigue a la vista**; la lista se
   queda centrada en ese canal.
3. Cierra el portal, vuelve a entrar → la lista aparece en el canal que quedó seleccionado, no al
   principio.
4. Rota el teléfono a horizontal y vuelve a vertical → la lista se reajusta y no hay que bajar.

## 4. Qué se verificó

- Renderizado del portal con 30 canales (React + jsdom): la lista tiene scroll propio, el
  reproductor lleva `order-1` y la lista `order-2` en móvil.
- Cambio al canal 25 → el contenedor se desplaza a la posición del canal (1328 px) y el canal activo
  queda **dentro** de la zona visible.
- Cambio al canal 2 → la lista vuelve arriba sola (0 px) y el canal activo sigue visible.
- `vite build` sin errores y las clases nuevas (`100dvh`, `62dvh`, `overscroll-contain`) presentes en
  el CSS compilado.

## 5. Lo que no se tocó

- Nadie cambia la línea de FFmpeg ni la cadena UDP: esto es sólo el reproductor web.
- El motor HLS sigue en `off` por defecto y la configuración del panel (v2.5.17) queda intacta.
