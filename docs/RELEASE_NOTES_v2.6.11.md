# TVLister 24/7 — v2.6.11 «Revisión del comprobador de dominios»

Pasada de revisión sobre la v2.6.10 (la que arregló el `Cannot convert object to primitive
value`). El arreglo era correcto; estas son las tres grietas que quedaban al probarlo con casos
límite.

## 1. El puerto del origen ya no se da por supuesto

La v2.6.10 preguntaba siempre a `127.0.0.1:443`. Si el panel se sirve en otro puerto (por ejemplo
`8443`, o el video por `https://live-stream…:8088`), el diagnóstico habría dicho «el origen no
responde» cuando sí responde.

Ahora el puerto se deduce: el de `public_stream_base` si lo lleva, el `443` si está declarado como
HTTPS y, si no, el primer puerto HTTPS configurado. La línea del comando y la tarjeta del panel
muestran el puerto real (`Origen: … :8443 · 120 días`). El sondeo público también usa el puerto de
salida del video: con `https://live-stream…:8088` el diagnóstico habla del `:8088`, no del `443`.

## 2. Sin DNS no se culpa al certificado

Antes, un dominio sin registro `A` producía dos errores encadenados: «no resuelve en DNS» y
«sin respuesta HTTPS válida (ENOTFOUND)», que apuntaban a dos sitios distintos. Ahora sólo se
informa del registro `A` (y se sigue mirando el 443 local, que sí se puede comprobar sin DNS).
La comprobación pasa de ~8 s a ~0,02 s en ese caso.

## 3. El detalle del certificado no confiable

Cuando el origen del video presenta un certificado que nadie puede validar, el mensaje incluye
ahora el emisor **y el código de error** (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, etc.). Y si el fallo
es de cadena en este servidor (una CA raíz que Node no trae), se emite un **aviso** con el comando
`openssl s_client` para comprobarlo, en vez de afirmar que el reproductor lo rechazará.

## Comprobado ejecutando

| Prueba | Resultado |
| --- | --- |
| `originProbePort()` sin puertos extra | `443` |
| … con `extra_http_ports = 80:both,443:https` | `443` |
| … con `80:http,8443:https` | `8443` |
| … con `public_stream_base = https://…:8088` | `8088` |
| `GET /api/domains/check` con el panel real | HTTP 200, JSON correcto, 60 ms |
| Dominio inexistente | sólo el problema de DNS, sin excepción, 22 ms |
| 443 con SNI + certificado propio (autofirmado) | problema explicado con emisor y código |
| El mismo certificado con su CA confiada (`NODE_EXTRA_CA_CERTS`) | sin problema de origen |
| `vite build`, `node --check`, `bash -n` | correctos |

## Instalación

```bash
sudo tvlister-admin update
sudo tvlister-admin dominios
```
