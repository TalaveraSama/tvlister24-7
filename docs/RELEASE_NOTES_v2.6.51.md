# TVLister v2.6.51 — desinstalador COMPLETO + desinstalar por SSH desde tu PC

Sobre v2.6.50. El desinstalador de la versión anterior era prudente de más: dejaba los certificados, no tocaba el
firewall y no se podía lanzar sin entrar al servidor. Ahora quita **todo lo que pone TVLister** y hay un lanzador
para hacerlo **desde tu PC por SSH**.

## Desinstalar en el servidor

```bash
sudo /opt/tvlister24-7/scripts/uninstall.sh          # o: sudo tvlister-admin uninstall   (menú 33)
```

| Comando | Qué hace |
| --- | --- |
| `sudo bash scripts/uninstall.sh` | Desinstala **todo** y guarda la base de datos en `/root/tvlister-backup-AAAAMMDD-HHMM` |
| `sudo bash scripts/uninstall.sh --purge` | Desinstala **todo** sin copia (y borra los respaldos viejos de `/root`) |
| `sudo bash scripts/uninstall.sh --dry-run` | Sólo enseña lo que haría: no cambia nada |
| `sudo bash scripts/uninstall.sh --yes` | Sin preguntar (scripts, SSH, `curl \| bash`) |
| `--keep-data` | Deja `data/` (base de datos y lo subido) donde está y borra el resto |
| `--keep-certs` | No borra `/etc/tvlister` (certificados TLS) |
| `--keep-firewall` | No toca las reglas de ufw/iptables |
| `--keep-backups` | No borra `/root/tvlister_backup_*.tar.gz` |
| `--app-dir RUTA` · `--ports "8095 8554"` | Instalación en otra carpeta · puertos extra del panel |

## Desinstalar por SSH (desde tu PC, sin entrar al servidor)

```bash
ssh-copy-id root@192.168.200.8                 # una sola vez
bash scripts/uninstall_ssh.sh root@192.168.200.8
bash scripts/uninstall_ssh.sh root@192.168.200.8 --purge --yes
bash scripts/uninstall_ssh.sh root@mi-vps --puerto 2222 --clave ~/.ssh/id_ed25519
bash scripts/uninstall_ssh.sh root@mi-vps --descargar    # usa el último publicado
```

- Pregunta **aquí** y luego ejecuta allí con `--yes` (el servidor no necesita terminal). Con `--dry-run` no
  pregunta y no añade `--yes`.
- Manda el script por la entrada estándar de `ssh`: no hace falta `scp` ni que el servidor tenga nada instalado.
  Con `--descargar` (o `--tag v2.6.51`) baja el desinstalador del release directamente en el servidor.
- Si no entras como root, comprueba `sudo -n true` y ejecuta con `sudo`; si no puede, **aborta sin tocar nada**.
- Al terminar **verifica** que no quedan `/opt/tvlister24-7`, la unidad ni el comando, y avisa si algo sigue.

Y si no puedes entrar sin contraseña, una sola línea:

```bash
ssh root@TU_IP 'curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/uninstall.sh | bash -s -- --yes'
```

`uninstall.sh` va ahora como asset del release, junto a `install.sh` y `SHA256SUMS`.

## Qué quita ahora (además de lo de v2.6.50)

- **Los certificados de `/etc/tvlister`** (salvo `--keep-certs`).
- **Las reglas de firewall del panel**: puerto del panel (leído de la unidad), 1935, 19350, 8554 y 8890/udp, con
  `ufw delete allow` e `iptables -D`. Los puertos **80/443 no se tocan nunca**.
- **Cualquier drope-in** `tvlister24-7.service.d/` y cualquier otra unidad `tvlister*.service`.
- El comando `tvlister-admin` también en `/usr/sbin` y `/bin`, y `tvlister-compat.conf` / `tvlister247-*.disabled`
  de nginx si quedaron.
- Con `--purge`: los respaldos `/root/tvlister_backup_*.tar.gz` y `/root/tvlister-backup-*`.

## Qué sigue sin tocar

- `/home/xui`: XUI.one, su nginx y sus canales (`a0ed.conf`, `a0d6.conf`, `a0ez.conf`…) quedan exactamente igual.
- Los puertos **80/443** del firewall y de nginx.
- Ningún archivo de otro programa: antes de borrar comprueba que la carpeta sea del panel (`server/index.js` +
  `package.json` con `name: tvlister24-7`).
- Por defecto la base de datos **se copia** a `/root/tvlister-backup-AAAAMMDD-HHMM/`; si la copia falla **no borra
  `data/`**.

## Pruebas

- `bash scripts/test_uninstall.sh` → **44 comprobaciones** sobre un árbol simulado (`TVLISTER_SYSROOT`):
  desinstalación completa (certificados fuera, respaldos viejos conservados, respaldo nuevo con sus filas),
  `--purge` (sin copia y sin respaldos viejos), `--keep-certs`/`--keep-backups`, `--keep-data` (data/ se queda y
  el código se va), `--dry-run` idéntico, cancelación sin `SI`, carpeta ajena intacta, motor node detenido sin
  matar la shell, segunda pasada sin nada instalado y comprobación de que el **80/443 no se cierra**.
- `bash scripts/test_uninstall_ssh.sh` → **40 comprobaciones** con un `ssh` de mentira que ejecuta el comando
  «remoto» en este mismo equipo: ayuda y errores de argumentos, envío por stdin, `--yes` añadido tras confirmar,
  `--dry-run` sin `--yes`, `--purge`, `--keep-certs`, cancelación sin terminal, servidor sin root y sin sudo
  (aborta sin tocar nada), servidor con sudo, `--descargar` y `--tag v9.9.9`.

## Volver a instalarlo

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash
```

Después, copia tu respaldo de `/root/tvlister-backup-…` en `data/` y todo sigue donde estaba.
