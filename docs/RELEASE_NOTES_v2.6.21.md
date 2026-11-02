# TVLister 24/7 — v2.6.21

**El paso que faltaba: compartir la carpeta en el servidor de Jellyfin.** Montar el disco desde el
panel sólo funciona si el otro servidor **exporta** la carpeta. Ahora el panel genera los comandos
exactos para hacerlo en el servidor de Jellyfin y lista lo que ese servidor ya comparte.

## Qué se añadió

### Comandos listos para el servidor de Jellyfin

En el bloque **«Disco de Jellyfin en este servidor (NFS / SMB)»** hay un desplegable:

> ¿El otro servidor todavía no comparte la carpeta? Comandos para el servidor de Jellyfin

Genera el texto ya rellenado con **la carpeta** y **la IP de este panel**:

```bash
# EJECUTAR EN EL SERVIDOR DE JELLYFIN (el que tiene el disco), como root
sudo apt install -y nfs-kernel-server
sudo mkdir -p /mnt/Storage1/movie
echo '/mnt/Storage1/movie 192.168.1.77(ro,sync,no_subtree_check)' | sudo tee -a /etc/exports
sudo exportfs -ra
sudo systemctl enable --now nfs-kernel-server
sudo ufw allow from 192.168.1.77 to any port 2049 proto tcp
sudo ufw allow from 192.168.1.77 to any port 111 proto tcp
```

En SMB genera el bloque de Samba (`[jellyfin]`, `read only = yes`, `smbpasswd`) y el puerto `445`.
Si el servidor tiene varias IP, el bloque deja elegir con cuál se autoriza el panel.

### «Ver carpetas compartidas»

Con NFS, el botón consulta el otro servidor con **`showmount -e`** y muestra las carpetas que ya
comparte; al pulsar una, se rellena sola la ruta del export. Si no hay ninguna, lo dice con el
comando para crearla.

### Terminal

```bash
sudo tvlister-admin jellyfin mount exports 192.168.1.50          # qué comparte (showmount -e)
sudo tvlister-admin jellyfin mount share nfs /mnt/Storage1/movie # comandos para el otro servidor
sudo tvlister-admin jellyfin mount share smb /mnt/Storage1/movie
```

Sin argumentos, `jellyfin mount` recuerda estos dos comandos si aún no hay nada configurado.

### API

- `POST /api/jellyfin/mount/exports` `{host}` → exportes NFS con sus clientes permitidos.
- `GET /api/jellyfin/mount/share?protocol=nfs&path=…&address=…` → comandos y direcciones del panel.
- `GET /api/jellyfin/mount/capabilities` añade `addresses` (IPs de este servidor).

## Comprobado ejecutando el panel

| Caso | Resultado |
| --- | --- |
| `showmount -e` con dos exports | `/mnt/Storage1/movie → 192.168.1.0/24` y `/srv/series → 192.168.1.77` |
| Servidor sin exports | lista vacía + aviso de que hay que crear el export |
| Servidor caído | `400` con el motivo (`Port mapper failure`) y el comando para generarlos |
| Receta NFS | incluye `mkdir`, `exports`, `exportfs -ra`, firewall `2049`/`111` y `showmount -e` |
| Receta SMB | bloque `smb.conf`, `smbpasswd`, `reload smbd` y puerto `445` |
| CLI `mount exports` / `share` | mismo resultado, con error en una línea (sin traza de Node) |
| Elegir otra IP del panel | la receta se regenera con la IP elegida |

## Sin cambios

Montaje, `fstab` con `nofail`, credenciales SMB `600`, detección de equivalencias, importación con
«Create Symlink», UDP/CATV, Flussonic, registro de aparatos y apps Xtream/M3U.

## Guía

[`docs/JELLYFIN_VOD.md`](JELLYFIN_VOD.md) — sección **3b**, ahora con los pasos 1 (compartir en el
servidor de Jellyfin), 2 (montar desde el panel) y 3 (terminal).

## Instalación / actualización

```bash
curl -fsSL https://github.com/TalaveraSama/tvlister24-7/releases/download/v2.6.21/install.sh \
  | sudo bash -s -- --tag v2.6.21 --port 8095
```
