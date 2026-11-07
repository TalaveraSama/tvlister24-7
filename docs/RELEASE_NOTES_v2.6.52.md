# TVLister v2.6.52 — el desinstalador no deja copias sueltas en /tmp

Sobre v2.6.51. Detalle pequeño pero real: para poder borrar la carpeta del panel mientras se ejecuta, el
desinstalador **se copia a `/tmp`** y se ejecuta desde ahí… y esa copia se quedaba en el servidor.

- Ahora la copia `/tmp/tvlister_uninstall.XXXX.sh` **se borra sola al terminar** (con un `trap EXIT`), pase lo
  que pase: éxito, cancelación o error.
- Pruebas nuevas en `scripts/test_uninstall.sh`:
  - por **tubería** (`cat uninstall.sh | bash -s -- --yes`), que es exactamente lo que hace el lanzador SSH:
    con `--yes` desinstala y guarda el respaldo; sin `--yes` no borra nada;
  - se cuentan las copias de `/tmp` antes y después: no aumenta ninguna.
- `bash scripts/test_uninstall.sh` → **49 comprobaciones** (antes 44) y `bash scripts/test_uninstall_ssh.sh` → **40**.

Nada más cambia: los comandos, las opciones (`--purge`, `--dry-run`, `--yes`, `--keep-*`, `--app-dir`) y el
lanzador `bash scripts/uninstall_ssh.sh root@TU_IP` siguen igual que en v2.6.51.
