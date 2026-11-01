# TVLister 24/7 — v2.5.26 «Nombres de las 124 portadoras analógicas»

Tu lista ordenada ya está dentro del panel: cada portadora (CH 2 al 125) lleva su rótulo, y ese
rótulo es el que sale en el CSV que importan los moduladores.

```bash
tvlister-admin release v2.5.26
tvlister-admin catv names            # vista previa: qué cambiaría
tvlister-admin catv names --apply    # aplicarla
```

## 1. La lista, tal como la diste

| CH | Canal | CH | Canal |
| --- | --- | --- | --- |
| 2 | NACIONAL | 64 | NAT GEO |
| 3 | TELEMUNDO | 65–70 | ESPN.1 … ESPN.6 |
| 4 | NACIONAL | 71 | MLB NETWOR |
| 5 | UNIMAS | 72 | TDN |
| 6 | NACIONAL | 73 | BANDAMAX |
| 7 | UNIVISION | 74 | TELEHIT MUSICA |
| 8–13 | NACIONAL | 75 | TELEHIT |
| 14 | VOS TV | 76 | HTV |
| 15 | REPETICION CH.61 | 77 | MTV |
| 16 | PASIONES | 78 | MAS MUSIC |
| 17 | TELEMUNDO INT. | 79 | TELENOSTALGIA |
| 18 | CANAL DE LAS ESTR. | 80 | FUTURA TV |
| 19 | TLE NOVELA | 81 | TLC |
| 20 | NIKELODEON | 82 | LOVE NATURE |
| 21 | CARTOON NETW. | 83 | elGOURMET |
| 22 | DISCOVERY KIDS | 84 | E! |
| 23 | NICK JR. | 85 | A&E |
| 24 | BABY TV | 86 | Caracol |
| 25 | DISNEY XD | 87 | Discovery Turbo |
| 26 | DISNEY JUNIOR | 88 | HOME AND HEALT. |
| 27 | TOONCAST | 89 | DISCOVERY ID. |
| 28 | MAS TV. LOCAL | 90 | France 24Hrs |
| 29 | BOOMERANG | 91 | DW |
| 30 | ANIMAS | 92 | TELESUR |
| 31 | ZOOMOO | 93 | CUBA VISION |
| 32 | STARZ. (PREMIER) | 94 | RT ESP. |
| 33 | CINEMAX | 95 | Wtv |
| 34 | GOLDEN EDGE CANALES PREMIER | 96 | Mas series |
| 35 | CINE LATINO | 97 | TV AGRO |
| 36 | HBO 2 | 98 | TELETICA |
| 37 | ENCORE | 99 | LIFE TIME |
| 38 | TNT | 100 | TRU TV |
| 39 | GOLDEN | 101 | MARIA VISION |
| 40 | SONY | 102 | Liga española |
| 41 | WARNER BROOS | 103 | Canal 6 Tico |
| 42 | TCM | 104 | Ometepe TV |
| 43 | DE PELICULA | 105 | Hispa TV |
| 44 | MULT.PREMIER | 106 | EWTN |
| 45 | UNIVERSAL CH. | 107 | CH. EL SEMBRADOR |
| 46 | CINECANAL | 108 | ENLACE |
| 47 | TNT Series | 109 | CDM.INTERN. |
| 48 | FX | 110 | 3 ABN LAT. |
| 49 | STUDIO UNIVERSAL | 111 | BitMe |
| 50 | STAR CHANNEL | 112 | Azteca Mundo |
| 51 | AXN | 113 | COMEDY CENTRAL |
| 52 | HBO | 114 | Wapa TV |
| 53 | +PLUS MOVIE | 115 | Universo |
| 54 | USA TV | 116 | TVE .LAT. |
| 55 | MAS SERIES | 117 | ANTENA 3.INT |
| 56 | MOVIES | 118 | Fox News |
| 57 | MOVIE FUN | 119 | ISAT |
| 58 | SHOW TIME | 120 | RTVe 24 HORAS |
| 59 | SPACE | 121 | Bethle |
| 60 | DISCOVERY CH. | 122 | Universal Comedy |
| 61 | ANIMAL PLANET | 123 | Universal Crimen |
| 62 | HISTORY CH. | 124 | Universal Premier |
| 63 | H2.LAT | 125 | Ometepe TV |

Comprobado: **124 posiciones, sin huecos, del 2 al 125**. Se conservan las repeticiones que tú
pusiste: `NACIONAL` en 2/4/6/8/9/10/11/12/13 y `Ometepe TV` en 104 y 125.

## 2. Cómo se aplica

```bash
tvlister-admin catv names              # vista previa (marca con -> lo que cambia)
tvlister-admin catv names --apply      # escribe los 124 rótulos
```

Salida real de la vista previa:

```
  -> CH 2  NACIONAL
  -> CH 3  TELEMUNDO
  -> CH 15 REPETICION CH.61
  ...
  124 portadoras en la lista · 124 por cambiar
```

Y en el panel: tarjeta **«Nombres de las portadoras (CH 2 al 125)»** en *CATV WK2500*, con
**Ver cambios** (lista con el nombre nuevo y el viejo tachado) y **Aplicar lista**.

## 3. Dónde aparece el nombre

Comprobado en los CSV reales que se importan en los moduladores:

```
Portadora,Canal_CATV,Frecuencia_Video_MHz,Frecuencia_Audio_MHz,Nombre_Canal
1,2,55.25,59.75,NACIONAL
2,3,61.25,65.75,TELEMUNDO
3,4,67.25,71.75,NACIONAL
```

```
Portadora,IP_Destino_UDP,Puerto_UDP,Nombre_Canal
1,192.168.200.8,5008,NACIONAL
2,192.168.200.8,5003,TELEMUNDO
```

Un CSV **por equipo** (`unit_id`), como ya estaba.

## 4. Lo que NO cambia (importante)

- **Frecuencias** de video/audio (NTSC-M 6 MHz, +4.5) — intactas.
- **UDP**: IP, puerto, `pkt_size 1316`, TTL 16, NIC dedicada — intactos.
- **Stream asignado** a cada portadora — se conserva.
- Los canales que emiten siguen emitiendo: sólo se reescribe el rótulo.

Después de aplicarlo, en cada modulador hay que **volver a importar el CSV de la página
CANALES** para que cambien los rótulos en pantalla; el plan y las entradas UDP no se tocan.

## 5. Tu lista, editable

Queda versionada en `docs/canales_analogos_2_125.txt` con formato `CH<TAB>NOMBRE`. Si algún día
cambias una cadena, editas ese archivo y:

```bash
tvlister-admin catv names --apply /opt/tvlister24-7/docs/canales_analogos_2_125.txt
```

Sin ruta se usa la lista incluida en el código. Probado también con un archivo parcial (3
canales): sólo toca esos tres y el resto se queda igual.

## 6. Pruebas

| Prueba | Resultado |
| --- | --- |
| Lista incluida: 124 posiciones, sin huecos | OK (2..125) |
| Vista previa antes de aplicar | 124 por cambiar, marca `->` |
| `--apply` | 124 rótulos escritos, verificado en BD |
| Repetir `--apply` | idempotente, 0 cambios |
| Archivo propio con 3 canales | sólo esos 3 |
| Archivo sin líneas válidas | error explicando el formato |
| CSV página CANALES (equipo 32 canales) | nombres correctos en `Nombre_Canal` |
| CSV página ENTRADA | nombres correctos, IP/puerto intactos |
| API `GET/POST /api/wk2500/channel-names` | preview y aplicación idempotente |
| Pantalla CATV | tarjeta con Ver cambios / Aplicar lista |
