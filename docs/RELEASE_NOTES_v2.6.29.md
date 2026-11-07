# v2.6.29 — Balancers que suman ancho de banda (y se instalan solos)

Publicada el 2 de noviembre de 2026. Sobre la v2.6.28 (aviso de la API Key de TMDB).

## Qué pediste

> «necesito que al estar en hora pico o esté lleno un balancer con el ancho de banda de 1 Gbps más se ocupe
> también; el panel debe hacer el installer balancer solo ingresar los datos del VPS, ya sea que tenga 10 VPS»

Dos cosas: que un VPS extra **sume su 1 Gbps de verdad** (antes no sumaba nada) y que el **panel lo instale
solo** pidiendo únicamente los datos del VPS.

## 1. El nodo ya no es un relé: sirve los bytes él mismo

El agente anterior pedía **todo** al maestro (`fetch(MASTER_URL + ruta)`), así que cada byte seguía pasando
por la NIC del maestro: se añadía un VPS y no se ganaba ni un Mbps.

| Ahora el nodo… | Efecto |
| --- | --- |
| **Cachea los segmentos** HLS en memoria (TTL corto, LRU con tope configurable) | 100 clientes del mismo canal = **1 descarga** al maestro |
| **Single-flight**: si 50 piden el mismo segmento a la vez, esperan a la misma descarga | sin ráfagas contra el maestro |
| **Reescribe los manifiestos**: las URLs absolutas del dominio de vídeo del maestro pasan a relativas | el cliente sigue en el nodo (si no, se escapaba al maestro) |
| **Mide su salida** (Mbps reales) y los aciertos de caché | el panel sabe cuándo está lleno |
| Sigue haciendo *streaming* en los flujos continuos (`/live/...ts`) y en VOD con `Range` | nada se rompe |

Medido en la prueba real: **25 clientes simultáneos del mismo segmento → 1 petición al maestro**, 96 % de
aciertos de caché y ~13 Mbps de salida informados en el latido.

## 2. Reparto por ancho de banda (no sólo CPU)

| Antes | Ahora (v2.6.29) |
| --- | --- |
| Se elegía por `conexiones/max_clients + CPU`, ignorando los Mbps | Se ordena por **carga real**: Mbps usados / Mbps del nodo, conexiones y CPU (lo peor manda) |
| Un nodo con el 100 % de su NIC seguía recibiendo clientes | Un nodo al **95 % de su capacidad** se descarta solo |
| El maestro no participaba en el reparto | El maestro entra con su **capacidad** (`master_max_bandwidth_mbps`, 800 por defecto) y su **salida medida** |
| — | `lb_master_offload_pct`: `0` = reparto libre entre maestro y nodos · `70` = el maestro atiende hasta el 70 % y desde ahí los clientes nuevos van a los nodos |

Así el ancho de banda total es la **suma** (maestro + cada balancer) y, cuando uno se llena, el tráfico pasa
al que esté más libre. El troncal de Flussonic sigue viendo **una sesión por canal**: los nodos piden al
maestro, no al troncal.

## 3. El panel instala el balancer: sólo pones la IP y la clave

En *Sistema → Nodos Edge Load Balancer* hay una tarjeta nueva. Escribes:

| Campo | Ejemplo |
| --- | --- |
| Nombre | `Balancer MX-2` |
| IP o dominio del VPS | `173.208.183.70` |
| Puerto del nodo | `8096` |
| Mbps del VPS | `800` (1 Gbps con margen) |
| Puerto / usuario SSH | `22` · `root` |
| Contraseña SSH *(o clave privada)* | — |
| Caché MB | `256` |

Y pulsas **«Instalar y conectar el balancer»**. El panel entra por SSH (`ssh2`, sin depender de `apt` ni de
`sshpass`), instala Node aislado en `/opt/tvlister-edge`, baja el agente **de este mismo panel**, crea el
servicio `tvlister-edge` y lo arranca. El progreso se ve en vivo y el nodo aparece **online** en cuanto
manda su primer latido. Se pueden añadir **los VPS que quieras**: cada uno es una fila con su capacidad.

- Credenciales: **no se guardan**. Sólo se usan para esa conexión; en la base queda el estado
  (`install_status`: `running`/`ok`/`error`) y el registro de la instalación.
- El comando se arma con *shell-quoting*: un token o un host con caracteres raros no puede inyectar nada.
- Siempre se devuelve el **comando manual** equivalente, por si prefieres pegarlo tú en el VPS.
- Recomendado: hacerlo sobre **HTTPS** o desde la red privada, porque la clave viaja en el cuerpo del POST.

## Cuántos nodos aguanta el maestro

Cada nodo pide al maestro **una copia por canal distinto** que esté sirviendo (no por cliente). El maestro
sube a cada nodo `canales_distintos × bitrate`. Con 148 canales a 3 Mbps eso son ~**444 Mbps por nodo** si
ese nodo sirve todos los canales: con 1 Gbps de subida el maestro alimenta **2 nodos** en ese escenario.

| Escenario | Subida del maestro por nodo | Nodos que aguanta un 1 Gbps |
| --- | --- | --- |
| 20 canales distintos a 3 Mbps | 60 Mbps | ~13 |
| 50 canales distintos a 3 Mbps | 150 Mbps | ~5 |
| 148 canales a 3 Mbps (todo el catálogo) | 444 Mbps | **2** |

Con 10 VPS, la forma correcta de repartir es que cada nodo sirva **un subconjunto de canales** (o que el
nodo tenga su propio TVLister tirando del troncal, que no pasa por el maestro). La caché ya evita el
problema grave —que el maestro subiera **cada cliente**—; este es el techo que queda.

## 4. Cambios de esquema (automáticos)

`servers` gana `max_bandwidth_mbps` (800), `cache_hit_pct`, `edge_version`, `install_status`, `install_log`
e `installed_at`. Las bases existentes se migran solas al arrancar.

## Pruebas

| Prueba | Qué hace | Resultado |
| --- | --- | --- |
| `node scripts/test_balancer_lb.mjs` | Reparto (`pickTarget`) + agente real | **36 OK**: nodo lleno excluido, gana el más libre, geoip, umbral 70 %, 25 clientes → 1 descarga, manifiesto reescrito, latido con Mbps/caché/versión, comando escapado |
| `node scripts/test_balancer_api.mjs` | Panel real + API | **23 OK**: instala contra un SSH que no responde (error controlado con log), nodo registrado con su capacidad, latido guarda 412,5 Mbps / 91,2 % de caché, `/api/system` expone la salida del maestro, borrado del nodo |
| `node scripts/test_balancer_ui.mjs` | Pantalla real (jsdom) | **16 OK**: campos, botón, POST con la IP y la clave, panel de progreso y log |

## Instalar / actualizar

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/v2.6.29/scripts/install_release.sh \
  | sudo bash -s -- --tag v2.6.29
```

En un panel ya instalado: `tvlister-admin update`. Los nodos que ya existían **no** hace falta reinstalarlos:
el panel les sirve el agente nuevo (`/api/lb/edge-agent.js`) y basta con reiniciar el servicio en el nodo
(`systemctl restart tvlister-edge`) para que empiecen a cachear.
