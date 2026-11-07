#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flussonic_push.py — probar y poner la salida UDP (push) de un stream de Flussonic
desde tu PC, sin instalar nada. Sólo Python 3.8+ (biblioteca estándar).

    # 1) Diagnóstico: enseña cómo guarda el servidor sus salidas y prueba cada forma.
    #    Al terminar deja el stream como estaba.
    python flussonic_push.py probe a0ed

    # 2) Poner (o cambiar) la salida UDP de un stream.
    python flussonic_push.py set a0ed --url "udp://ens37@239.1.1.2:1005"

    # 3) Quitarla.
    python flussonic_push.py set a0ed --remove

Servidor y credenciales: por parámetro o por variables de entorno.

    export FLUSSONIC_URL="http://192.168.200.10:80"
    export FLUSSONIC_USER="admin"
    export FLUSSONIC_PASS="tu-clave"

    python flussonic_push.py probe a0ed --server http://192.168.200.10 --user admin --pass tu-clave

Qué hace exactamente:
  · Lee el stream (GET /streamer/api/v3/streams/<nombre>) y **no** reenvía `inputs`
    ni `stats` (es lo que provoca el 400 «parsing_parameters»).
  · Mira cómo guarda el servidor sus salidas: con la interfaz dentro de la url
    (`udp://ens37@239.1.1.2:1002`) o en un campo aparte (`"interface": "ens37"`),
    y copia los campos extra que añada (`type`, `ttl`, `bitrate`…).
  · Prueba las formas en orden y **verifica releyendo** el stream: una forma sólo
    vale si el servidor la aceptó (2xx) y la salida aparece al releer.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import quote

# Campos que el GET devuelve pero que no son configuración: no se reenvían.
READ_ONLY = {
    "stats", "effective", "named_by", "position", "sessions", "schema",
    "$schema", "media_info",
}
RUNTIME_OUTPUT_KEYS = {
    "url", "stats", "state", "status", "running", "bytes", "started_at",
    "opened_at", "bitrate_kbps", "error", "clients", "sessions",
}


# ─────────────────────────── cliente HTTP mínimo ────────────────────────────
class Flussonic:
    def __init__(self, base, user, password, timeout=15):
        base = (base or "").rstrip("/")
        if not base:
            raise SystemExit("Falta --server (o FLUSSONIC_URL), p.ej. http://192.168.200.10")
        self.base = base if base.endswith("/streamer/api/v3") else base + "/streamer/api/v3"
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.timeout = timeout

    def call(self, method, path, body=None):
        url = self.base + path
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", self.auth)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read().decode("utf-8", "replace")
                return r.status, raw, safe_json(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            return e.code, raw, safe_json(raw)
        except Exception as e:  # red, DNS, timeout…
            return 0, f"{type(e).__name__}: {e}", None

    # ── atajos ──
    def stream(self, name):
        return self.call("GET", f"/streams/{quote(name, safe='')}")

    def put(self, name, body):
        return self.call("PUT", f"/streams/{quote(name, safe='')}", body)

    def config(self):
        return self.call("GET", "/config")

    def schema(self):
        return self.call("GET", "/schema")


def safe_json(text):
    try:
        return json.loads(text)
    except Exception:
        return None


# ─────────────────────────── URLs de push UDP ───────────────────────────────
def parse_url(url):
    """udp://[iface@]host:port[?params] → dict, o None si no es udp/rtp."""
    u = (url or "").strip()
    if "://" not in u:
        return None
    proto, rest = u.split("://", 1)
    if proto.lower() not in ("udp", "rtp"):
        return None
    params = ""
    if "?" in rest:
        rest, params = rest.split("?", 1)
    if rest.endswith("/"):          # forma antigua udp://grupo:puerto/IP_local
        rest = rest.rstrip("/")
    iface = ""
    if "@" in rest:
        iface, rest = rest.rsplit("@", 1)
    if ":" not in rest:
        return None
    host, port = rest.rsplit(":", 1)
    try:
        port = int(port)
    except ValueError:
        return None
    return {"proto": proto.lower(), "iface": iface, "host": host, "port": port, "params": params}


def build_url(p, iface=None):
    p = dict(p)
    if iface is not None:
        p["iface"] = iface
    pre = f"{p['iface']}@" if p["iface"] else ""
    tail = f"?{p['params']}" if p["params"] else ""
    return f"{p['proto']}://{pre}{p['host']}:{p['port']}{tail}"


def target_key(url):
    """host:puerto, para reconocer «el mismo destino» con o sin interfaz."""
    p = parse_url(url)
    return f"{p['host'].lower()}:{p['port']}" if p else ""


# ─────────────────────── cómo guarda el servidor la salida ──────────────────
def outputs_of(cfg):
    raw = (cfg or {}).get("outputs") or []
    if not isinstance(raw, list):
        raw = [raw]
    return [o if isinstance(o, dict) else {"url": str(o)} for o in raw if o]


def output_style(cfg):
    """Si la interfaz va en un campo aparte y qué campos extra añade el servidor."""
    outs = outputs_of(cfg)
    sample = next((o for o in outs if parse_url(o.get("url", ""))), None) or (outs[0] if outs else None)
    if not sample:
        return {"iface_field": False, "extra": {}, "sample": None}
    extra = {k: v for k, v in sample.items() if k not in RUNTIME_OUTPUT_KEYS}
    iface_field = isinstance(sample.get("interface"), str) and bool(sample.get("interface"))
    return {"iface_field": iface_field, "extra": extra, "sample": sample}


def output_entry(url, style):
    entry = {k: v for k, v in (style.get("extra") or {}).items() if k != "url"}
    p = parse_url(url)
    if style.get("iface_field") and p:
        entry["url"] = build_url(p, iface="")
        entry["interface"] = p["iface"] or entry.get("interface", "")
        return entry
    entry["url"] = url
    if p and p["iface"]:
        entry.pop("interface", None)
    return entry


def outputs_value(urls, style, as_text=False):
    return list(urls) if as_text else [output_entry(u, style) for u in urls]


def strip_runtime(cfg):
    out = {}
    for k, v in (cfg or {}).items():
        if k in READ_ONLY or k.startswith("$") or k in ("inputs", "outputs", "push"):
            continue
        out[k] = v
    inputs = [{"url": i.get("url") if isinstance(i, dict) else i} for i in (cfg.get("inputs") or [])]
    inputs = [i for i in inputs if i.get("url")]
    if inputs:
        out["inputs"] = inputs
    return out


# ─────────────────────────── formas del cuerpo ──────────────────────────────
def body_outputs(urls, cfg):
    return {"outputs": outputs_value(urls, output_style(cfg))}


def body_outputs_text(urls, cfg):
    return {"outputs": list(urls)}


def body_iface_field(urls, cfg):
    out = []
    for u in urls:
        p = parse_url(u)
        if p and p["iface"]:
            out.append({"url": build_url(p, iface=""), "interface": p["iface"]})
        else:
            out.append({"url": u})
    return {"outputs": out}


def body_push(urls, cfg):
    return {"push": outputs_value(urls, output_style(cfg))}


def body_push_text(urls, cfg):
    return {"push": list(urls)}


def body_full(urls, cfg, name):
    out = strip_runtime(cfg)
    out["name"] = (cfg or {}).get("name") or name
    out["outputs"] = outputs_value(urls, output_style(cfg))
    return out


def body_schema_full(urls, cfg, name, props, key, as_text):
    out = {}
    for k, v in (cfg or {}).items():
        if k in READ_ONLY or k.startswith("$") or k in ("inputs", "outputs", "push"):
            continue
        if props and k not in props:
            continue
        out[k] = v
    if not props or "inputs" in props:
        inputs = [{"url": i.get("url") if isinstance(i, dict) else i} for i in (cfg.get("inputs") or [])]
        inputs = [i for i in inputs if i.get("url")]
        if inputs:
            out["inputs"] = inputs
    if not props or "name" in props:
        out["name"] = (cfg or {}).get("name") or name
    out[key] = outputs_value(urls, output_style(cfg), as_text=as_text)
    return out


def outputs_property(schema_doc):
    """Mira el OpenAPI del servidor: ruta PUT /streams/{name} → campo de salidas."""
    if not isinstance(schema_doc, dict):
        return None
    paths = schema_doc.get("paths") or {}

    def resolve(node, depth=0):
        while isinstance(node, dict) and "$ref" in node and depth < 8:
            ref = node["$ref"].lstrip("#/").split("/")
            cur = schema_doc
            for part in ref:
                cur = (cur or {}).get(part) if isinstance(cur, dict) else None
            node, depth = cur, depth + 1
        return node

    path_key = next((p for p in paths if p.rstrip("/").startswith("/streams/{") and "put" in (paths[p] or {})), None)
    if not path_key:
        return None
    op = paths[path_key]["put"]
    body = (((op.get("requestBody") or {}).get("content") or {}).get("application/json") or {}).get("schema")
    body = resolve(body)
    props = resolve(body).get("properties") if isinstance(resolve(body), dict) else None
    if not isinstance(props, dict):
        return None
    key = next((k for k in props if k.lower() in ("outputs", "output", "push", "pushes", "udp")), None)
    if not key:
        return None
    node = resolve(props[key])
    items = resolve((node or {}).get("items") or {})
    return {
        "key": key,
        "as_text": (items or {}).get("type") == "string",
        "properties": sorted(props.keys()),
        "version": ((schema_doc.get("info") or {}).get("version") or ""),
    }


# ─────────────────────────────── operaciones ────────────────────────────────
def read_outputs(fs, name):
    status, text, cfg = fs.stream(name)
    if status != 200 or not isinstance(cfg, dict):
        return None, f"GET del stream → HTTP {status} {text[:200]}"
    return [o.get("url") for o in outputs_of(cfg)], None


def saved(fs, name, urls):
    have, err = read_outputs(fs, name)
    if have is None:
        return False, err
    return {target_key(u) for u in have} == {target_key(u) for u in urls if target_key(u)}, ""


def build_variants(fs, name, cfg, urls):
    """Formas del cuerpo, en el orden en que tiene sentido probarlas."""
    schema_meta = None
    status, _, doc = fs.schema()
    if status == 200:
        schema_meta = outputs_property(doc)

    variants = [("outputs", body_outputs(urls, cfg))]
    if any((parse_url(u) or {}).get("iface") for u in urls):
        variants.append(("iface_field", body_iface_field(urls, cfg)))
    variants += [
        ("outputs_text", body_outputs_text(urls, cfg)),
        ("push", body_push(urls, cfg)),
        ("push_text", body_push_text(urls, cfg)),
        ("full", body_full(urls, cfg, name)),
    ]
    if schema_meta and schema_meta["properties"]:
        variants.append((
            "schema:full",
            body_schema_full(urls, cfg, name, set(schema_meta["properties"]), schema_meta["key"], schema_meta["as_text"]),
        ))
    return variants, schema_meta


def attempt(fs, name, variants, urls):
    """Prueba cada forma y devuelve la primera que el servidor acepta Y guarda."""
    for shape, body in variants:
        status, raw, _ = fs.put(name, body)
        ok = False
        if 200 <= status < 300:
            ok, _ = saved(fs, name, urls)
        mark = "✅" if ok else "  "
        print(f"  {mark} {shape:<13} HTTP {status:<4} {raw.strip()[:150]}")
        print(f"     enviado: {json.dumps(body, ensure_ascii=False)[:200]}")
        if ok:
            return shape
    return None


def restore(fs, name, cfg, before):
    """Deja el stream con las salidas que tenía."""
    if not before:
        return True
    fs.put(name, body_outputs(before, cfg))
    have, _ = read_outputs(fs, name)
    return have == before


def probe(fs, name, url):
    status, text, cfg = fs.stream(name)
    if status != 200 or not isinstance(cfg, dict):
        print(f"❌ No se pudo leer el stream «{name}»: HTTP {status} {text[:200]}")
        return 2

    before = [o.get("url") for o in outputs_of(cfg)]
    style = output_style(cfg)
    test_url = url or (before[0] if before else "")
    if not test_url:
        print("❌ El stream no tiene salidas: indica la URL a probar con --url udp://ens37@239.1.1.2:1002")
        return 2

    print(f"Stream:   {name}  (static={cfg.get('static')}, named_by={cfg.get('named_by')})")
    print(f"Formato:  {'interfaz en campo «interface» aparte' if style['iface_field'] else 'interfaz dentro de la url (udp://ens37@…)'}")
    extra = [k for k in style["extra"] if k != "interface"]
    if extra:
        print(f"Campos:   {', '.join(sorted(extra))}")
    print(f"Salidas : {', '.join(before) or '(ninguna)'}")
    print(f"JSON    : {json.dumps(outputs_of(cfg), ensure_ascii=False)[:600]}")
    if not url and any(target_key(u) == target_key(test_url) for u in before):
        print("⚠️         el stream ya tiene ese destino; pasa --url con otro puerto para una prueba real")
    print(f"Prueba  : {test_url}")

    variants, meta = build_variants(fs, name, cfg, [test_url])
    if meta:
        print(f"Esquema : v{meta['version']} · campo «{meta['key']}» ({'texto' if meta['as_text'] else 'objetos'})")
        print(f"          propiedades: {', '.join(meta['properties'])}")
    print()

    winner = attempt(fs, name, variants, [test_url])
    have, _ = read_outputs(fs, name)
    restored = have == before or restore(fs, name, cfg, before)
    print()
    print(f"{'✅ Forma que funciona: ' + winner if winner else '❌ Ninguna forma funcionó'}")
    print("   (el stream quedó como estaba)" if restored else "   ⚠️ revisa las salidas del stream en Flussonic")
    return 0 if winner else 2


def apply_push(fs, name, url, remove=False):
    status, text, cfg = fs.stream(name)
    if status != 200 or not isinstance(cfg, dict):
        print(f"❌ No se pudo leer el stream «{name}»: HTTP {status} {text[:200]}")
        return 1

    before = [o.get("url") for o in outputs_of(cfg)]
    key = target_key(url)
    keep = [u for u in before if target_key(u) != key]
    wanted = keep if remove else keep + [url]
    if not remove and key in {target_key(u) for u in before}:
        print(f"ℹ️  «{name}» ya tiene ese destino; se reescribe para comprobar que el servidor lo acepta.")

    print(f"Antes  : {', '.join(before) or '(ninguna)'}")
    print(f"Después: {', '.join(wanted) or '(ninguna)'}")

    variants, meta = build_variants(fs, name, cfg, wanted)
    if meta:
        print(f"Esquema : v{meta['version']} · campo «{meta['key']}»")
    print()
    winner = attempt(fs, name, variants, wanted)
    if winner:
        print(f"\n✅ Guardado y verificado con la forma «{winner}».")
        print(f"   Salidas ahora: {', '.join(wanted) or '(ninguna)'}")
        return 0

    restore(fs, name, cfg, before)
    print("\n❌ Ninguna forma funcionó. El stream quedó con sus salidas de antes.")
    print("   Ejecuta `probe` para ver la respuesta exacta de tu servidor con --url.")
    return 2


def main():
    ap = argparse.ArgumentParser(description="Probar/poner la salida UDP (push) de un stream de Flussonic")
    ap.add_argument("accion", choices=["probe", "set"], help="probe = diagnosticar sin dejar cambios; set = poner o quitar")
    ap.add_argument("stream", help="nombre del stream en Flussonic (p.ej. a0ed)")
    ap.add_argument("--url", default="", help="url de push: udp://ens37@239.1.1.2:1002")
    ap.add_argument("--remove", action="store_true", help="quitar la salida en vez de ponerla")
    ap.add_argument("--server", default=os.environ.get("FLUSSONIC_URL", ""), help="http://IP[:puerto]")
    ap.add_argument("--user", default=os.environ.get("FLUSSONIC_USER", "admin"))
    ap.add_argument("--pass", dest="password", default=os.environ.get("FLUSSONIC_PASS", ""))
    args = ap.parse_args()

    fs = Flussonic(args.server, args.user, args.password)
    if args.accion == "probe":
        return probe(fs, args.stream, args.url)
    if not args.url and not args.remove:
        print("❌ Falta --url udp://ens37@239.1.1.2:1002 (o --remove)")
        return 1
    return apply_push(fs, args.stream, args.url, remove=args.remove)


if __name__ == "__main__":
    sys.exit(main())
