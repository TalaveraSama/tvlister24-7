# ¿Quién emite las claves DRM? (y qué puede hacer TVLister)

Respuesta corta:

| Sistema | ¿Quién emite la clave? | ¿TVLister puede emitirla? | Coste | Cobertura real |
| --- | --- | --- | --- | --- |
| **AES-128 (HLS)** | **TVLister** (tu panel) | **Sí, ya lo hace** | 0 | Todo: TV boxes, Smart TV, VLC, Kodi, TiviMate, Smarters, WebTV, tu APK |
| **SAMPLE-AES (HLS)** | **TVLister** | **Sí** | 0 | Igual que AES-128 (cifra sólo audio/vídeo) |
| **ClearKey (EME)** | **TVLister** | **Sí** | 0 | Navegadores/Android con EME; clave poco protegida |
| **Widevine** | **Google o un partner autorizado** | **No** | Desde ~50-100 USD/mes o % | Android, Chrome, Smart TV modernas |
| **PlayReady** | **Microsoft o un partner autorizado** | **No** | Igual | Windows, Xbox, algunos TVs |
| **FairPlay** | **Apple** (certificado) | **No** | Acuerdo con Apple | Safari, iOS, tvOS |

---

## 1. Las que sí son tuyas: AES-128 (y SAMPLE-AES, ClearKey)

Aquí **el panel es el emisor**. No hay tercero, no hay cuota, no hay cuenta que pagar.

Cómo funciona hoy en TVLister (v2.6.x):

1. Al activar DRM en un canal, el panel genera una **clave maestra de 32 bytes** y la guarda en la
   base de datos (`drm_streams.master_key`). Esa clave es tuya y no sale del servidor.
2. Flussonic, con `drm aes128 keyserver=<tu panel>/drm/cas/<token>`, pide la clave **cada 10 minutos**
   (rotación propia de Flussonic, con un `number` nuevo cada vez).
3. El panel **deriva** la clave de ese número: `HKDF-SHA256(master, salt, "tvlister-drm:<canal>:<n>")`
   → 16 bytes. No se guardan claves por rotación: se calculan.
4. Esa misma clave se le entrega al reproductor en `/drm/key/<token>?n=<n>`, comprobando token de
   línea, estado de la línea y registrando IP (`drm_key_log`).
5. Si rotas los tokens (`tvlister-admin drm tokens <canal>`), todas las URLs viejas dejan de entregar
   clave en el acto. Si revocas una línea, deja de recibir claves.

**Qué protege de verdad:** que un enlace `.m3u8`/`.ts` copiado por ahí no sirva sin pasar por tus
líneas; que un panel ajeno que copie tu lista no pueda descifrar; que puedas revocar todo con un
comando y tener auditoría de quién pide qué.

**Qué NO protege:** a un usuario con una línea válida que capture a la salida del reproductor. Eso no
lo evita ningún DRM 100%, ni Widevine: sólo lo hace más caro (nivel de seguridad L1/L3 del CDM).

## 2. Las que NO se pueden emitir desde un panel: Widevine / PlayReady / FairPlay

Esto es lo importante que hay que entender: **una licencia DRM no es una clave, es una firma**.

- La clave de contenido (`aes_key` + `iv`) es un número. La puede tener cualquiera.
- La **licencia** es un documento firmado con la clave privada del sistema DRM que el CDM del
  dispositivo valida contra su certificado raíz. Sin esa firma, el teléfono se niega a descifrar.
- Esa clave de firma la tiene **Google** (Widevine) y **Microsoft** (PlayReady). No se distribuye: se
  obtiene con un acuerdo (Widevine: programa **CWIP** + cuota anual si lo alojas tú; o un partner que
  ya lo tiene) y el SDK de servidor de licencias.

Google retiró su servicio Cloud License; hoy las licencias las emiten despliegues del **License
Server SDK**, por partners (Axinom, EZDRM, BuyDRM, DRMtoday, DoveRunner/PallyCon, Verimatrix…) o por
el propio operador si tiene el acuerdo y las credenciales. Ningún panel auto-hospedado puede firmar
una licencia Widevine por sí mismo, y quien diga lo contrario está vendiendo humo.

### Lo que TVLister sí hace en Widevine (y ya está implementado)

- **Custodia de tus claves de contenido**: guardas en el panel tu `aes_key`, `iv` y `content_id` (los
  de tu cuenta Widevine). No salen al navegador: sólo se muestran por terminal o se envían a
  Flussonic por API.
- **Genera el bloque exacto** para Flussonic:
  `drm widevine aes_key=… iv=… content_id=… keyserver=https://tu-proveedor/…`
- **Proxy de licencias autorizado**: el reproductor pide la licencia a
  `/drm/license/<token>?t=<token_de_línea>`, TVLister comprueba la línea y reenvía con **tus
  cabeceras secretas** al keyserver del proveedor. Resultado: el keyserver nunca queda expuesto y tú
  puedes cortar el acceso por línea sin tocar el proveedor.
- **Contrato para la app**: `action=get_drm` le da a tu APK la URL de licencia de cada canal.

### Lo que necesitas para Widevine (checklist real)

1. Cuenta / acuerdo con un proveedor Widevine (o CWIP de Google si vas a alojar el License Server
   SDK tú mismo).
2. Un **keyserver URL** con credenciales (o cabecera de autenticación) que ellos te dan.
3. Las **claves de contenido** (`aes_key` + `iv`) y el `content_id` por canal, emitidas por ese
   proveedor.
4. En TVLister: poner keyserver + claves en *DRM & Claves* → modo Widevine → *Aplicar a Flussonic*.
5. Un reproductor con CDM Widevine (tu APK con Media3 lo tiene; los TV boxes chinos baratos a veces
   no).

## 3. Qué recomiendo para tu caso (CATV + IPTV, 125 canales)

**Fase 1 — hoy, gratis:** AES-128 emitido por el panel en todos los canales que salgan por HLS.
Cubre el 100% de tus clientes (tu APK, TiviMate, Smarters, TV boxes, WebTV). Coste 0, sin terceros,
con rotación cada 10 min, revocación por línea y auditoría. Ya está funcionando.

**Fase 2 — sólo si aparece la necesidad:** Widevine en los paquetes premium (deportes, estrenos).
Ahí sí pagas proveedor, y TVLister ya está preparado para custodiarlo y hacer de proxy.

**Importante para tu CATV:** el UDP hacia los moduladores **no se cifra ni se toca**. El DRM es sólo
de la salida HTTP. Si un canal CATV usa el mismo stream de Flussonic que quieres cifrar, el panel te
lo marca en rojo en *DRM & Claves* antes de que actives nada — porque Flussonic con `drm` cifra su
salida HLS y eso podría afectar a cómo genera ese UDP.

## 4. Preguntas rápidas

**¿Puedo cambiar de proveedor Widevine sin rehacer nada?** Sí: cambias el keyserver y las claves en
el panel; la app sigue pidiendo a la misma URL del panel.

**¿Si apago el DRM, dejo de ver canales?** No: `drm_enabled:false` en `get_drm` y la app reproduce
como siempre; y si quitas la línea `drm` de Flussonic, el canal vuelve a salir en claro.

**¿Quién ve las claves?** Sólo el servidor. En AES-128 la clave maestra está en la base de datos; en
Widevine el `aes_key/iv` también, y el navegador los ve enmascarados (`<guardada>`).

**¿Y si alguien roba la base de datos?** Cambia todas las claves maestras (`drm tokens` +
`regenerateMasterKey`) y las claves de contenido con tu proveedor. Con la base sola no puede firmar
licencias Widevine ni descifrar el HLS cifrado con claves rotadas de Flussonic.
