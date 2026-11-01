# TVLister 24/7 — v2.5.23 «Access Codes: el panel como XUI.one»

El panel ya se puede cerrar con un **código de acceso**, igual que en XUI.one: sin código
no se llega ni a la pantalla de login.

```bash
tvlister-admin release v2.5.23
tvlister-admin access-code add mipanel admin
```

A partir de ahí, al abrir el panel:

```
        TVLister 24/7
Panel protegido. Introduce el código de acceso
que te dio el administrador.

  CÓDIGO DE ACCESO
  [ •••••••••• ]
  [   Entrar   ]
```

Y entrando con el enlace `/?access=mipanel` el código se guarda 7 días en ese navegador.

## 1. Lo que hay en el panel (menú → Access Codes)

Misma idea que la pantalla de XUI.one que me pasaste:

- **Add Code** — código, tipo y una nota para saber de quién es.
- Tabla con **Access Code · Type · Enabled · Actions**, con *Show N entries* y buscador.
- El cuadradito verde activa/desactiva un código **al instante** (y revoca las sesiones que
  lo estuvieran usando).
- Lápiz para editar, × para borrar, y un icono para copiar el enlace `?access=…`.
- Aviso arriba: si no hay ningún código activo, lo dice claramente («el panel está abierto»).

Tipos, como en XUI.one: **Admin**, **Admin API** y **Reseller** (sirven para organizarse;
los tres abren la puerta, el nivel real lo sigue dando el usuario con el que entras).

## 2. Qué protege y qué no

| Protege | No protege |
| --- | --- |
| El panel completo: HTML, assets y API administrativa | Las líneas IPTV de tus clientes (`get.php`, `player_api.php`, `.m3u8`, `.ts`) |
| La pantalla de login (sin código no se ve) | El portal WebTV público (`/api/webtv/*`) |
| | MAG/Stalker y MNF (usan sus propias credenciales) |

Los clientes **no notan nada**: la tele se sigue viendo igual, con la misma lista.

## 3. Diferencia con XUI.one (a favor)

Allí los códigos se escriben en la configuración de nginx y cada cambio **recarga el servidor
web** (con los segundos de corte que avisa su propio cartel). Aquí los valida TVLister:

- se aplican **al instante**, sin `nginx -s reload`;
- no tocan la configuración del nginx de XUI.one;
- el código se guarda en una cookie **firmada (HttpOnly)**, no en texto plano en la URL;
- 10 intentos fallidos por IP cada 5 minutos y luego espera (anti fuerza bruta);
- desactivar un código **revoca inmediatamente** los navegadores que lo usaban.

## 4. Desde la consola (si te quedas fuera del panel)

```bash
tvlister-admin access-code                     # lista con estado, tipo, usos y último uso
tvlister-admin access-code add socio.2026 reseller "revendedor Rubén"
tvlister-admin access-code url socio.2026      # enlace listo para mandar
tvlister-admin access-code off socio.2026      # desactiva uno
tvlister-admin access-code off                 # apaga todos (panel abierto otra vez)
tvlister-admin access-code on 4                # reactiva por id o por código
tvlister-admin access-code rm socio.2026
```

En el menú interactivo es la opción **27**.

## 5. Cómo se probó

Con el panel real levantado y el navegador simulado:

| Prueba | Resultado |
| --- | --- |
| Sin códigos | el panel abre normal (nada cambia) |
| Con código activo, sin cookie | aparece la pantalla de código |
| Código en `?access=` | entra y redirige a la ruta pedida con cookie firmada |
| Código correcto por POST | 302 a la ruta + cookie `HttpOnly` |
| Código incorrecto | 401 y mensaje en la propia pantalla |
| Cookie válida | el panel y sus assets cargan (200) |
| Código desactivado con la sesión abierta | vuelve a pedir código al instante |
| `get.php` / `player_api.php` sin código | siguen respondiendo (los clientes no se enteran) |
| `/api/streams` sin código | 401 en JSON |
| Alta duplicada (`SOCIO.2026` vs `socio.2026`) | rechazada sin distinguir mayúsculas |
| Código corto (`ab`) | rechazado con el motivo |
| Editar, activar, borrar, listar | OK por API y por consola |
| Pantalla Access Codes | renderiza tabla, columnas, contador y aviso |

## 6. Recomendación de uso

1. Crea **un código por persona** (`adminpanel` para ti, otro para cada revendedor): así
   revocas a uno sin tocar a los demás.
2. Deja siempre uno de respaldo apagado y actívalo desde consola si te bloqueas.
3. Combínalo con Cloudflare delante del panel: el código es la llave, Cloudflare protege
   del ruido.
