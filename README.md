# TVLister 24/7 — Midnight Streamer OTT/VOD Panel

Plataforma auto-hospedada de código abierto para la gestión integral de **Canales en Vivo**, **Canales Dinámicos 24/7 (Playout Continuo)**, **Biblioteca VOD (Películas y Series)**, **Líneas M3U / Xtream API / MAG Stalker / Enigma2**, **Módulo de Resellers con Créditos** y **Reproductor Cliente WebTV HTML5**.

---

## Cómo Instalar

### Opción 1: Servidor VPS Ubuntu 20.04 / 22.04 / 24.04 o Debian 11 / 12 (Recomendado)

Conéctate por SSH a tu VPS como `root` (o usuario con `sudo`) y ejecuta:

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
sudo bash scripts/install_ubuntu.sh
```

*(Nota: Una vez que fusiones el Pull Request a la rama `main`, podrás omitir `-b arena/85cc9902-tvlister24-7`).*

También puedes instalarlo en **1 solo comando directo** en tu VPS Ubuntu/Debian:

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/tvlister24-7/arena/85cc9902-tvlister24-7/scripts/install_ubuntu.sh | sudo bash
```

¿Qué hace el instalador automáticamente?
1. Instala **FFmpeg**, **SQLite3** y **Node.js 22 LTS**.
2. Descarga y compila el panel en `/opt/tvlister24-7`.
3. Crea y activa el servicio `systemd` (`tvlister24-7.service`) para que inicie solo al reiniciar el VPS.
4. Levanta el panel en `http://TU_IP_DEL_VPS:8080` (puedes cambiar el puerto con `PORT=8000 sudo bash scripts/install_ubuntu.sh`).

---

### Opción 2: Instalación con Docker Compose

Si prefieres usar contenedores Docker (incluye Node 22 + FFmpeg preconfigurados):

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
docker compose up -d --build
```

Luego abre `http://TU_IP_O_LOCALHOST:8080`.

---

### Opción 3: Instalación Local (PC Windows / Mac / Linux)

Requiere **Node.js v22.5 o superior**:

```bash
git clone -b arena/85cc9902-tvlister24-7 https://github.com/TalaveraSama/tvlister24-7.git
cd tvlister24-7
npm install
npm run build
npm start
```

Abre en tu navegador: `http://localhost:8080`

---

## Credenciales Iniciales

| Rol | Usuario | Contraseña |
| --- | --- | --- |
| **Super Administrador** | `admin` | `admin123` |
| **Reseller Demo** | `reseller_latam` | `reseller123` |
| **Cliente Línea / WebTV / M3U** | `demo` | `demo123` |

> **Importante:** Al ingresar por primera vez en producción, cambia la contraseña de `admin` y elimina o edita las cuentas de demostración.
