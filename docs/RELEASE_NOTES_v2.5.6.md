# TVLister 24/7 — v2.5.6 «El CSV que el modulador sí acepta»

El botón **Import** ya no manda un archivo con columnas inventadas: ahora entrega el CSV **con el mismo formato
que exporta el propio modulador**, rellenado con tus canales. Es la razón por la que el equipo no cargaba ni
cambiaba los canales UDP.

---

## Instalación / actualización

```bash
tvlister-admin release v2.5.6
tvlister-admin restart
```

La base de datos se migra sola (columna nueva `wk2500_units.csv_template`). Canales, equipos y streams se conservan.

---

## Por qué no funcionaba

El *Import* generaba 6 columnas:

```
Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,IP_Destino_UDP,Puerto_UDP
```

Los moduladores IP→analógico de la familia 2500C (CSP-2500C, WK-2500C, SFT2500C y clones) **validan su propia
estructura** en la ventana de importación. Si la cabecera, el orden de columnas, el separador o el fin de línea no
coinciden, **descartan el archivo en silencio**: no crea los canales UDP ni modifica los existentes. Exactamente
lo que viste.

---

## Cómo se usa (3 pasos, una sola vez por equipo)

1. **En la web del modulador** (`192.168.25.10`…) → tabla de canales → **Export / Descargar**. Guarda ese archivo.
2. **En el panel**: *UDP / CATV* → tarjeta del equipo → **`Plantilla`** → pega el archivo (o *Abrir archivo…*) →
   **Guardar plantilla**. El panel te dice cuántas columnas reconoció y te muestra cómo saldrá la fila de las 3
   primeras portadoras.
3. **`Import`** → descarga el archivo con la estructura del equipo y tus canales reales. Ese es el que se sube a la
   ventana de importación del modulador.

A partir de ahí el botón `Import` queda en **verde** y la tarjeta muestra *«Plantilla del equipo cargada: N columnas»*.

---

## Qué rellena y qué respeta

| Se rellena con el plan | Se conserva del archivo del equipo |
| --- | --- |
| Canal / Channel | Nivel (`1.0`) |
| Frecuencia de vídeo (MHz) | Ancho de banda (`6.000`) |
| Frecuencia de audio (MHz) | Estándar ya escrito |
| IP destino y puerto UDP | Cualquier columna propia (enable, flags, índices…) |
| Nombre del canal | Separador, fin de línea (CRLF/LF) y cabecera |

Reconoce cabeceras en español e inglés, con o sin acentos, y separadores `,` `;` tabulador `|`. Si el archivo **no
trae cabecera**, deduce las columnas por el contenido: IPv4 = IP, entero ≥1000 = puerto, los dos decimales entre 40
y 900 = vídeo (menor) y audio (mayor), entero 2–125 = canal, el resto = portadora.

---

## También nuevo

- `format=csv-min&header=0` → compacto **sin cabecera** (firmwares que sólo leen filas de datos).
- `format=csv-min&eol=crlf` → finales de línea Windows.
- Cabeceras `X-TVLister-CSV-Mode` / `-Rows` / `-Columns` para saber qué se generó.
- Si un equipo **no** tiene plantilla, `Import` sigue funcionando con el formato compacto y la tarjeta lo avisa en
  ámbar: *«Sin plantilla: si el equipo no carga ni cambia los canales…»*.

---

## Verificación (panel real, 4 moduladores de 32)

| Prueba | Resultado |
| --- | --- |
| Plantilla de 11 columnas con `;` y CRLF | reconocidas las 5 columnas clave + nivel y ancho de banda |
| Descarga del equipo 1 | 32 portadoras + cabecera, 11 columnas en todas las filas |
| Portadora 1 | **CH95 · 91.25 / 95.75 MHz · 192.168.25.10:5095** |
| `Level` / `Bandwidth` | se conservan `1.0` y `6.000` del equipo |
| Editar el equipo después | la plantilla **no se pierde** |
| Equipo sin plantilla | responde `compact-fallback` y la UI avisa |
| Compacto sin cabecera | `header=0` ⇒ la primera línea ya es dato |
| Archivo sin cabecera (`;`) | portadora/vídeo/audio/IP/puerto detectados por contenido |
| Parser y mapeo (27 pruebas) | todas OK, incluidos nombres con comas y comillas |

> Si tu modulador no tiene botón *Export*, pega al menos su **primera línea de cabecera**; el panel la usa como
> molde y deja el resto de columnas con los valores que escribas en la vista previa.
