# TVLister v2.6.50 — desinstalador de verdad (`tvlister-admin uninstall`)

Sobre v2.6.49. Hasta ahora, quitar el panel del servidor era a mano y con miedo a llevarse por delante XUI.one.
Ahora hay un desinstalador que pregunta, guarda los datos y no toca nada que no sea suyo.

## Cómo se usa

```bash
sudo /opt/tvlister24-7/scripts/uninstall.sh      # o: sudo tvlister-admin uninstall
```

Antes de borrar nada enseña lo que va a hacer y pide escribir **SI**.

| Comando | Qué hace |
| --- | --- |
| `sudo bash scripts/uninstall.sh` | Desinstala y **guarda** la base de datos en `/root/tvlister-backup-AAAAMMDD-HHMM` |
| `sudo bash scripts/uninstall.sh --purge` | Desinstala y **borra todo**, sin copia |
| `sudo bash scripts/uninstall.sh --dry-run` | Sólo enseña lo que haría: no cambia nada |
| `sudo bash scripts/uninstall.sh --yes` | Sin preguntar (para scripts) |
| `sudo bash scripts/uninstall.sh --app-dir /ruta` | Instalación en otra carpeta |

También está en el menú de `tvlister-admin` como opción **33**.

## Qué quita

- El servicio `tvlister24-7`: se para, se desactiva del arranque y se borra su unidad de systemd (más el
  `service.d/cloudflare.conf` que añade el asistente de Cloudflare).
- El comando `tvlister-admin` (`/usr/local/bin` y el enlace de `/usr/bin`).
- La carpeta del panel (`/opt/tvlister24-7`) y `/var/lib/tvlister24-7` (HLS y playlists temporales).
- El cron del respaldo automático (`/etc/cron.d/tvlister24-7-backup`).
- **Los bloques de nginx que puso el panel**: `tvlister-panel.conf` y `tvlister-streams.conf` en el nginx de
  XUI.one, `tvlister247-*.conf` y `tvlister-cloudflare-realip.conf` en el del sistema, sus enlaces de
  `sites-enabled` y `/root/tvlister247_*.nginx.conf`. Después recarga nginx **sin cortar** lo que esté sirviendo.
- Los procesos node/ffmpeg que hayan quedado sueltos. Se comprueba `/proc/<pid>/exe`, así que nunca mata una
  shell ni un proceso de otro programa.

## Qué NO toca

- `/home/xui`: XUI.one, su nginx y sus canales (`a0ed.conf`, etc.) siguen exactamente igual.
- El firewall (ufw/iptables). Las reglas que abrió el instalador se quedan; al terminar el script te dice cómo
  verlas y quitarlas (`ufw status numbered`). El 80/443 son de XUI.one: no hay que cerrarlos.
- Los certificados de `/etc/tvlister`, salvo con `--purge`.
- Tus backups `/root/tvlister_backup_*.tar.gz`.

## Seguridades

- Por defecto **la base de datos se copia** a `/root/tvlister-backup-AAAAMMDD-HHMM/` (con lo subido). Si la copia
  falla, **no borra `data/`**: la deja en su sitio y lo dice.
- Se niega a borrar una carpeta que no sea del panel (comprueba `server/index.js` y `package.json` con
  `name: tvlister24-7`).
- Se copia a `/tmp` y se ejecuta desde ahí, para poder borrar la carpeta en la que vive.
- `--dry-run` no cambia absolutamente nada.

## Volver a instalarlo

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/latest/download/install.sh | sudo bash
```

Si guardaste el respaldo, copia esa carpeta en `data/` después de instalar y todo sigue donde estaba (canales,
líneas, VOD, access codes).

## Pruebas

Probado en un entorno simulado (`TVLISTER_SYSROOT`, instalación falsa en `/tmp`):

- desinstalación normal: unidad, cron, enlaces, bloques de nginx, `/var/lib` y carpeta del panel fuera; base de
  datos en el respaldo **con sus filas** y los archivos subidos;
- `--purge`: todo fuera, incluido `/etc/tvlister` y la base de datos;
- `--dry-run`: árbol de archivos idéntico antes y después;
- sin escribir `SI`: cancela y no toca nada;
- carpeta ajena: se niega y la deja intacta;
- proceso node del panel: detenido; la shell que lo lanzó y el `a0ed.conf` de XUI.one: intactos.

Y las pruebas del panel siguen en verde: `test_catv_flussonic_ui`, `control` 25 OK, `pacer`, `test_youtube_live`
39 OK, `test_youtube_live_ui` 35 OK; `npm run build` OK y el tar del release arranca con `/api/health` → `2.6.50`.
