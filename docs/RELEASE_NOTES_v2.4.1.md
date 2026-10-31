# TVLister 24/7 — v2.4.1 «Motor FFmpeg simple y transparente»

Versión de interfaz: la sección **Motor FFmpeg** se rehace para que se entienda de un vistazo y nadie mueva el
motor sin querer. **No cambia ni un argumento de FFmpeg**: con todo en valores de fábrica la línea de comandos
es exactamente la misma que la validada en producción con los 145 canales.

---

## Instalación / actualización

```bash
# servidor ya instalado: publicar esta versión y reiniciar
tvlister-admin release v2.4.1
tvlister-admin restart

# o bien, actualizar desde el código del repositorio
tvlister-admin update
tvlister-admin restart

# servidor nuevo
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash
```

La base de datos, los canales, los bouquets y el puerto actual se conservan en las tres vías.

---

## Novedades

### Opciones estáticas
- La sección abre en **sólo lectura**. Cada opción es un recuadro con su **valor actual**, su **valor de fábrica**
  y la etiqueta `Por defecto` / `Modificado`.
- Para editar hay que pulsar **Permitir cambios** (y se puede volver a bloquear).
- El **texto explicativo de cada opción es fijo**: no se reescribe solo ni cambia según otros campos.

### Lo que modificas queda plasmado en su opción
- Al cambiar un valor, su recuadro pasa a ámbar y escribe literalmente **«Cambiado de X a Y»**, junto a la
  etiqueta `Sin guardar` hasta que se aplique.
- El botón **↺** devuelve esa opción concreta a su valor de fábrica.
- Barra superior con el resumen: *«N opción(es) fuera del valor de fábrica»* o *«Todo en valores de fábrica»*.

### Menos ruido en pantalla
- Sólo 6 opciones básicas a la vista: segmento HLS, segmentos en el manifiesto, hilos H.264, reserva del
  RAMDisk, registro y salida MPEG-TS.
- Sondas HTTP/UDP, tailer y prebuffer pasan a **Mostrar opciones avanzadas**, junto con las estadísticas del
  prebuffer de los últimos 5 minutos.
- **Perfiles rápidos** sólo rellenan el formulario (lo avisa en pantalla); no aplican nada hasta Guardar.
- **Comando real que ejecuta FFmpeg** y el selector de binario quedan plegados y compactos.
- Estado del motor en 4 casillas: canales activos, congelados, ventana HLS y RAMDisk libre, con aviso si no se
  pudo ejecutar ningún binario (Modo Direct Stream).

---

## Verificación realizada

| Prueba | Resultado |
| --- | --- |
| Apertura de la sección | modo sólo lectura, 6 opciones básicas visibles |
| «Permitir cambios» | habilita los campos y muestra el estado *Editable* |
| Cambio de un valor | el recuadro muestra «Cambiado de 2 s a 3 s» + `Sin guardar` |
| Opciones avanzadas | aparecen sondas, tailer, prebuffer y sus estadísticas |
| Perfil rápido | sólo rellena el formulario y avisa que falta Guardar |
| Guardar | `PUT /api/system/ffmpeg-engine` con los valores del formulario; reinicio escalonado |
| Build de producción | Vite sin errores |

---

## Compatibilidad

- Sin migraciones de base de datos ni cambios de API. Los valores guardados siguen en las mismas claves
  (`ffmpeg_*`) y la respuesta de `GET /api/system/ffmpeg-engine` mantiene su forma.
- Los perfiles de modulador, el estándar de TV, el plan de frecuencias y el transporte UDP/RTP de v2.4.0 quedan
  intactos.
