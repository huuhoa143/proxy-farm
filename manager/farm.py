#!/usr/bin/env python3
"""
HMA Proxy Farm manager — turns one HMA (SurfEasy/Gen) subscription into many
per-location SOCKS5/HTTP proxy ports, each a Docker container running an IKEv2
tunnel + gost (see ../node). Host-side: shells out to `docker`.

  python3 farm.py serve                 # web UI on :8080 (default)
  python3 farm.py up <KEY|CC> ...        # start tunnels for locations/countries
  python3 farm.py down [KEY ...]         # stop (all if none given)
  python3 farm.py ls                     # list running proxies + exit IPs
  python3 farm.py rotate <KEY>           # reconnect (new gateway IP)

State: farm-state.json (chosen locations -> assigned port). Ports from BASE_PORT.
"""
import json, os, re, base64, subprocess, sys, time, threading, http.server, urllib.parse, socket

HERE = os.path.dirname(os.path.abspath(__file__))
LOCS = json.load(open(os.path.join(HERE, "locations.json")))
STATE_FILE = os.environ.get("HMA_STATE", os.path.join(HERE, "farm-state.json"))
IMAGE = os.environ.get("HMA_IMAGE", "hma-node")
SECRETS = os.environ.get("HMA_SECRETS", os.path.expanduser("~/hma-farm/secrets"))  # host path for -v
# Where the manager itself reads/writes the certificate. Same as SECRETS when it runs with
# host networking and no mount indirection; a published container must mount it.
COMPOSE_PROJECT = os.environ.get("HMA_COMPOSE_PROJECT", "")
SECRETS_DIR = os.environ.get("HMA_SECRETS_DIR", SECRETS)
BASE_PORT = int(os.environ.get("HMA_BASE_PORT", "29001"))
FLAGS_DIR = os.environ.get("HMA_FLAGS", os.path.join(HERE, "flags"))
STATUS_DIR = os.environ.get("HMA_STATUS_DIR", os.path.join(HERE, "status"))   # in-container path
STATUS_DIR_HOST = os.environ.get("HMA_STATUS_HOST", STATUS_DIR)               # host path for -v mounts
os.makedirs(STATUS_DIR, exist_ok=True)
BIND = os.environ.get("HMA_BIND", "127.0.0.1")          # host iface proxies listen on
UI_PORT = int(os.environ.get("HMA_UI_PORT", "8080"))
# Where the UI socket itself binds. Same as BIND when the manager runs with host
# networking; when it runs as a published container it must bind 0.0.0.0 inside the
# container and let `-p 127.0.0.1:...` do the restricting.
UI_BIND = os.environ.get("HMA_UI_BIND", BIND)

# Drop zone on disk: anything left here is imported automatically. run.sh seeds it with
# the HMA device token when the app is installed on this machine.
INBOX = os.environ.get("HMA_INBOX", "")
# Read-only directories scanned for VPN configs. Findings are only ever *suggested*;
# nothing outside INBOX is imported without the user asking.
SCAN_DIR = os.environ.get("HMA_SCAN", "")

CONFIG_DIR = os.environ.get("HMA_CONFIG_DIR", os.path.join(HERE, "configs"))
CONFIG_DIR_HOST = os.environ.get("HMA_CONFIG_HOST", CONFIG_DIR)
os.makedirs(CONFIG_DIR, exist_ok=True)

# ---- targets -----------------------------------------------------------------
# A "target" is anything that can become a proxy port. Two sources:
#   catalog  — a provider with a server list we ship (HMA/SurfEasy), auth by certificate
#   config   — a .conf/.ovpn the user uploaded; one file = one location
CATALOG = []
for l in LOCS["locations"]:
    CATALOG.append({**l, "provider": "hma", "protocol": "ikev2-cert",
                    "label": l["countryName"] + " " + l["city"]})

def detect_protocol(text):
    if "[Interface]" in text and "PrivateKey" in text: return "wireguard"
    if re.search(r"^\s*remote\s+\S+", text, re.M): return "openvpn"
    return None

_CC = {f[:-4].upper() for f in os.listdir(FLAGS_DIR) if f.endswith(".png")} \
      if os.path.isdir(FLAGS_DIR) else set()
CC_NAME = {l["country"]: l["countryName"] for l in CATALOG}

def guess_provider(name):
    """Best-effort provider from a filename like 'mullvad-se-got.conf' -> 'mullvad'."""
    for tok in re.split(r"[^A-Za-z]+", os.path.basename(name)):
        if len(tok) > 2 and tok.upper() not in _CC:
            return tok.lower()
    return "custom"

def guess_country(name):
    """Best-effort 2-letter country from a filename like 'mullvad-se-got.conf'."""
    for tok in re.split(r"[^A-Za-z]+", os.path.basename(name)):
        if len(tok) == 2 and tok.upper() in _CC:
            return tok.upper()
    return "XX"

def config_targets():
    out = []
    for fn in sorted(os.listdir(CONFIG_DIR)):
        if not fn.endswith((".conf", ".ovpn")): continue
        meta_p = os.path.join(CONFIG_DIR, fn + ".meta.json")
        try: meta = json.load(open(meta_p))
        except Exception: meta = {}
        stem = re.sub(r"[^A-Za-z0-9]+", "-", fn.rsplit(".", 1)[0]).strip("-").upper()
        out.append({
            "key": "CFG-" + stem,
            "provider": meta.get("provider") or "custom",
            "protocol": meta.get("protocol") or ("wireguard" if fn.endswith(".conf") else "openvpn"),
            "config": fn,
            "country": meta.get("country") or guess_country(fn),
            "city": meta.get("city") or fn.rsplit(".", 1)[0],
            "countryName": meta.get("countryName") or CC_NAME.get(
                meta.get("country") or guess_country(fn), "Tự nạp"),
            "label": fn,
        })
    return out

# ---- providers ---------------------------------------------------------------
PROVIDERS_FILE = os.path.join(os.path.dirname(STATE_FILE), "providers.json")

def load_providers():
    try: return json.load(open(PROVIDERS_FILE))
    except Exception: return {"eap": []}
def save_providers(p):
    json.dump(p, open(PROVIDERS_FILE, "w"), indent=1)
    os.chmod(PROVIDERS_FILE, 0o600)

def slug(t): return re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-").upper() or "X"

def hma_status():
    """What the UI shows for the HMA/SurfEasy card: is the device certificate present,
    whose is it, and when does it expire."""
    pem = os.path.join(SECRETS_DIR, "client.pem")
    if not os.path.exists(pem): return {"ready": False}
    out = {"ready": True, "locations": len(CATALOG)}
    try:
        r = subprocess.run(["openssl", "x509", "-in", pem, "-noout", "-subject",
                            "-enddate", "-nameopt", "multiline"],
                           text=True, capture_output=True, timeout=10)
        cn = re.search(r"commonName\s*=\s*(.+)", r.stdout)
        end = re.search(r"notAfter=(.+)", r.stdout)
        if cn: out["udid"] = cn.group(1).strip()
        if end: out["expires"] = end.group(1).strip()
    except Exception as e:
        out["error"] = str(e)
    return out

_PEM_CERT = re.compile(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.S)
_PEM_KEY = re.compile(r"-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----.*?"
                      r"-----END (?:ENCRYPTED )?PRIVATE KEY-----|"
                      r"-----BEGIN RSA PRIVATE KEY-----.*?-----END RSA PRIVATE KEY-----", re.S)

def _openssl_p12(p12_path, password, *args):
    """Run openssl pkcs12, retrying with -legacy: the app's bundle uses RC2/SHA1, which
    OpenSSL 3 only reads through the legacy provider."""
    base = ["openssl", "pkcs12", "-in", p12_path, "-passin", f"pass:{password}"]
    for extra in ([], ["-legacy"]):
        r = subprocess.run(base + list(args) + extra, text=True, capture_output=True, timeout=30)
        if r.returncode == 0 and r.stdout.strip(): return r.stdout
    raise ValueError("Không mở được chứng chỉ — sai mật khẩu hoặc file hỏng"
                     + (f" ({r.stderr.strip().splitlines()[-1]})" if r.stderr.strip() else ""))

def import_hma(token_text=None, p12_b64=None, password=None):
    """Install the HMA device certificate. Accepts either the macOS app's
    tokenCoreSE.json (which carries the PKCS#12 *and* its password) or a raw .p12."""
    meta = {}
    if token_text:
        try:
            outer = json.loads(token_text)
            dev = json.loads(base64.b64decode(outer["DeviceManager.device"]))
            p12_b64 = dev["credentials"]["certificate"]
            password = dev["credentials"]["certificatePassword"]
            meta = {"udid": dev.get("udid", ""),
                    "dns_format": (dev.get("dnsFormat") or [""])[0]}
        except Exception as e:
            raise ValueError(f"Không đọc được tokenCoreSE.json: {e}")
    if not p12_b64:
        raise ValueError("Thiếu chứng chỉ")
    try: raw = base64.b64decode(p12_b64)
    except Exception: raise ValueError("Chứng chỉ không phải base64 hợp lệ")

    os.makedirs(SECRETS_DIR, exist_ok=True)
    tmp = os.path.join(SECRETS_DIR, ".import.p12")
    with open(tmp, "wb") as f: f.write(raw)
    os.chmod(tmp, 0o600)
    try:
        leaf = _PEM_CERT.search(_openssl_p12(tmp, password or "", "-nokeys", "-clcerts"))
        key = _PEM_KEY.search(_openssl_p12(tmp, password or "", "-nocerts", "-nodes"))
        chain = _PEM_CERT.findall(_openssl_p12(tmp, password or "", "-nokeys", "-cacerts"))
        if not leaf or not key:
            raise ValueError("Chứng chỉ thiếu phần client hoặc khoá riêng")
        # Write only after every part parsed, so a bad import can't half-replace a
        # working certificate and take the whole farm down.
        for name, body in (("client.pem", leaf.group(0) + "\n"),
                           ("client.key", key.group(0) + "\n"),
                           ("ca-int.pem", "\n".join(chain) + "\n" if chain else "")):
            if not body.strip(): continue
            path = os.path.join(SECRETS_DIR, name)
            with open(path, "w") as f: f.write(body)
            os.chmod(path, 0o600)
    finally:
        try: os.remove(tmp)
        except OSError: pass

    prov = load_providers()
    prov["hma"] = {**meta, "imported": int(time.time())}
    save_providers(prov)
    return hma_status()

# ---- automatic discovery ------------------------------------------------------
def _cert_mtime():
    try: return os.path.getmtime(os.path.join(SECRETS_DIR, "client.pem"))
    except OSError: return 0

def ingest_inbox():
    """Import whatever is sitting in INBOX. Config files are consumed; the HMA token is
    left in place (run.sh refreshes it) and re-imported only when it is newer than the
    certificate we already installed."""
    if not INBOX or not os.path.isdir(INBOX): return []
    done = []
    for fn in sorted(os.listdir(INBOX)):
        path = os.path.join(INBOX, fn)
        if not os.path.isfile(path): continue
        try:
            if fn == "tokenCoreSE.json":
                if os.path.getmtime(path) <= _cert_mtime(): continue
                import_hma(token_text=open(path, encoding="utf-8").read())
                done.append(("hma", fn))
            elif fn.endswith((".conf", ".ovpn")):
                save_config(fn, open(path, encoding="utf-8").read())
                os.remove(path)
                done.append(("config", fn))
        except Exception as e:
            print(f"inbox: bỏ qua {fn}: {e}", flush=True)
    if done: print("inbox: đã nạp " + ", ".join(f for _, f in done), flush=True)
    return done

def inbox_loop():
    while True:
        try: ingest_inbox()
        except Exception as e: print("inbox:", e, flush=True)
        time.sleep(60)

def discover():
    """Config files lying around on the machine that are not imported yet."""
    if not SCAN_DIR or not os.path.isdir(SCAN_DIR): return []
    have = {t["config"] for t in config_targets()}
    out = []
    for root, dirs, files in os.walk(SCAN_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")][:20]
        if root.count(os.sep) - SCAN_DIR.count(os.sep) > 2: dirs[:] = []
        for fn in files:
            if not fn.endswith((".conf", ".ovpn")) or fn in have: continue
            fp = os.path.join(root, fn)
            try:
                if os.path.getsize(fp) > 200_000: continue
                proto = detect_protocol(open(fp, encoding="utf-8", errors="ignore").read(4000))
            except OSError: continue
            if not proto: continue
            out.append({"name": fn, "path": fp, "protocol": proto,
                        "where": os.path.relpath(root, SCAN_DIR),
                        "provider": guess_provider(fn), "country": guess_country(fn)})
            if len(out) >= 40: return out
    return out

def import_found(paths):
    ok = []
    for fp in paths:
        # Only ever read back inside the scanned tree: a path from the client is input.
        rp = os.path.realpath(fp)
        if not SCAN_DIR or not rp.startswith(os.path.realpath(SCAN_DIR) + os.sep): continue
        try:
            save_config(os.path.basename(rp), open(rp, encoding="utf-8").read())
            ok.append(os.path.basename(rp))
        except Exception as e:
            print(f"import: {rp}: {e}", flush=True)
    return ok

def eap_targets():
    out = []
    for e in load_providers().get("eap", []):
        out.append({"key": "EAP-" + e["id"], "provider": e.get("name") or "ikev2",
                    "protocol": "ikev2-eap", "fqdn": e["server"],
                    "eap_user": e.get("user"), "eap_pass": e.get("pass"),
                    "server_id": e.get("server_id"),
                    "country": e.get("country") or "XX",
                    "city": e.get("city") or e["server"],
                    "countryName": CC_NAME.get(e.get("country") or "", "Tự nạp"),
                    "label": e["server"]})
    return out

def add_eap(d):
    for f in ("server", "user", "pass"):
        if not (d.get(f) or "").strip():
            raise ValueError("Cần đủ máy chủ, tên đăng nhập và mật khẩu")
    prov = load_providers()
    name = (d.get("name") or d["server"].split(".")[0]).strip()
    e = {"id": slug(name + "-" + d["server"]), "name": name,
         "server": d["server"].strip(), "user": d["user"].strip(), "pass": d["pass"],
         "server_id": (d.get("server_id") or "").strip() or None,
         "country": (d.get("country") or "").strip().upper()[:2] or None,
         "city": (d.get("city") or "").strip() or None}
    prov.setdefault("eap", [])
    prov["eap"] = [x for x in prov["eap"] if x["id"] != e["id"]] + [e]
    save_providers(prov)
    return next(t for t in eap_targets() if t["key"] == "EAP-" + e["id"])

def delete_provider(pid):
    """Remove a provider and every port it owns. HMA also drops its certificate."""
    prov = load_providers()
    if pid == "hma":
        down([k for k, v in load_state().items() if v.get("provider") == "hma"])
        for f in os.listdir(SECRETS_DIR) if os.path.isdir(SECRETS_DIR) else []:
            if f.startswith(("client.", "ca-")): os.remove(os.path.join(SECRETS_DIR, f))
        prov.pop("hma", None)
    else:
        gone = [e for e in prov.get("eap", []) if slug(e["name"]) == pid]
        if gone:
            down(["EAP-" + e["id"] for e in gone])
            prov["eap"] = [e for e in prov["eap"] if slug(e["name"]) != pid]
        else:   # a file-based provider: every config tagged with this name
            for t in config_targets():
                if t["provider"] == pid: delete_config(t["key"])
    save_providers(prov)

# ---- per-provider port limits --------------------------------------------------
# Most providers cap simultaneous connections per account, so the farm refuses to start
# more than the cap rather than let the provider kick sessions. 0 = no limit.
# HMA: no limit — 20+ concurrent ran stable; what broke big farms was stuck reconnects,
# not the count. HMA ends every session after ~4.5 h; the watchdog reconnects in seconds.
DEFAULT_LIMITS = {"hma": 0, "protonvpn": 10, "proton": 10, "nordvpn": 10, "mullvad": 5,
                  "expressvpn": 8, "cyberghost": 7, "surfshark": 0, "pia": 0,
                  "ipvanish": 0, "windscribe": 0, "custom": 0}

def limit_key(t):
    return "hma" if t.get("protocol") == "ikev2-cert" else (t.get("provider") or "custom").lower()

def get_limits():
    return load_providers().get("limits", {})

def limit_for(key):
    lim = get_limits()
    return int(lim[key]) if key in lim else DEFAULT_LIMITS.get(key, 0)

def set_limit(key, n):
    prov = load_providers()
    prov.setdefault("limits", {})[key] = max(0, int(n))
    save_providers(prov)

def usage(run=None):
    """Ports currently holding a connection, per provider (stopped ones don't count)."""
    run = run if run is not None else running_containers()
    idx = targets_index(); out = {}
    for k, v in load_state().items():
        if (run.get(k) or {}).get("state") in ("running", "restarting"):
            lk = limit_key(idx.get(k, v))
            out[lk] = out.get(lk, 0) + 1
    return out

def over_quota(targets):
    """Split targets into those allowed to start now and those the cap refuses."""
    run = running_containers(); used = usage(run)
    ok, refused = [], []
    for t in targets:
        if (run.get(t["key"]) or {}).get("state") in ("running", "restarting"):
            ok.append(t); continue                    # already counted; recreating is free
        lk = limit_key(t); lim = limit_for(lk)
        if lim and used.get(lk, 0) >= lim:
            refused.append({"key": t["key"], "provider": lk, "limit": lim})
        else:
            used[lk] = used.get(lk, 0) + 1; ok.append(t)
    return ok, refused

def providers_list():
    out = [{"id": "hma", "kind": "ikev2-cert", "name": "HMA / SurfEasy",
            "note": "Chứng chỉ thiết bị từ app", **hma_status()}]
    by_file = {}
    for t in config_targets():
        p = by_file.setdefault(t["provider"], {"id": t["provider"], "kind": t["protocol"],
                                               "name": t["provider"], "ready": True,
                                               "note": "File cấu hình", "locations": 0})
        p["locations"] += 1
    out += sorted(by_file.values(), key=lambda p: p["name"])
    by_acct = {}
    for e in load_providers().get("eap", []):
        p = by_acct.setdefault(slug(e["name"]), {"id": slug(e["name"]), "kind": "ikev2-eap",
                                                 "name": e["name"], "ready": True,
                                                 "note": e["user"], "locations": 0})
        p["locations"] += 1
    out += sorted(by_acct.values(), key=lambda p: p["name"])
    used = usage()
    for p in out:
        lk = "hma" if p["kind"] == "ikev2-cert" else p["name"].lower()
        p["limit_key"] = lk
        p["limit"] = limit_for(lk)
        p["limit_default"] = DEFAULT_LIMITS.get(lk, 0)
        p["used"] = used.get(lk, 0)
    return out

def all_targets():
    # No certificate installed = no HMA locations, so a fresh install shows an honest
    # empty farm instead of 115 ports that would all fail to start.
    hma = CATALOG if os.path.exists(os.path.join(SECRETS_DIR, "client.pem")) else []
    return hma + config_targets() + eap_targets()

def targets_index():
    return {t["key"]: t for t in all_targets()}

BY_CC = {}
for l in CATALOG:
    BY_CC.setdefault(l["country"], []).append(l)

def load_state():
    try: return json.load(open(STATE_FILE))
    except Exception: return {}
def save_state(s): json.dump(s, open(STATE_FILE, "w"), indent=1)

SETTINGS_FILE = os.path.join(os.path.dirname(STATE_FILE), "settings.json")
CREDS_FILE = os.path.join(os.path.dirname(STATE_FILE), "creds.json")   # pre-settings layout

# Environment gives the defaults; settings.json (written by the UI) overrides them, so a
# user who never opens Settings behaves exactly as the docker run flags say.
DEFAULTS = {
    "proxy_user": os.environ.get("HMA_PROXY_USER", "hma"),
    "proxy_pass": os.environ.get("HMA_PROXY_PASS", ""),
    "rotate_key": "",
    "bind": BIND,
    "base_port": BASE_PORT,
    "mtu": int(os.environ.get("HMA_MTU", "1400")),
    "watchdog_interval": int(os.environ.get("HMA_WATCHDOG_INTERVAL", "15")),
    "watchdog_fails": int(os.environ.get("HMA_WATCHDOG_FAILS", "3")),
    # Nodes already back off to one attempt per 30 min, which is cheap and self-heals
    # when a gateway lifts its block. Giving up for good is therefore opt-in.
    "give_up_after": int(os.environ.get("HMA_GIVE_UP_AFTER", "0")),
    "dns": os.environ.get("HMA_TUNNEL_DNS", "1.1.1.1 8.8.8.8"),
}
SETTABLE = [k for k in DEFAULTS if k != "rotate_key"]

def save_settings(s):
    json.dump(s, open(SETTINGS_FILE, "w"), indent=1)
    os.chmod(SETTINGS_FILE, 0o600)

def load_settings():
    st = dict(DEFAULTS)
    try:
        st.update(json.load(open(SETTINGS_FILE)))
    except Exception:
        try:                                   # migrate the older creds-only file
            c = json.load(open(CREDS_FILE))
            st.update(proxy_user=c.get("user") or st["proxy_user"],
                      proxy_pass=c.get("pass") or "", rotate_key=c.get("rotate_key") or "")
        except Exception: pass
    import secrets as _s
    missing = not st["proxy_pass"] or not st["rotate_key"]
    st["proxy_pass"] = st["proxy_pass"] or _s.token_urlsafe(12)
    st["rotate_key"] = st["rotate_key"] or _s.token_urlsafe(16)
    if missing or not os.path.exists(SETTINGS_FILE): save_settings(st)
    return st

def load_creds():
    st = load_settings()
    return {"user": st["proxy_user"], "pass": st["proxy_pass"], "rotate_key": st["rotate_key"]}

def rotate_key(): return load_settings()["rotate_key"]

def docker(*a, check=True, capture=True):
    return subprocess.run(["docker", *a], text=True, check=check,
                          capture_output=capture)
def cname(key): return "hma-" + key.lower()

def used_ports(state):
    return {v["port"] for v in state.values()}
def next_port(state):
    used = used_ports(state)
    p = load_settings()["base_port"]
    while p in used: p += 1
    return p

def resolve_targets(args):
    """Expand KEY / country-code / 'all' into a list of target dicts."""
    idx = targets_index()
    out, seen = [], set()
    for a in args:
        if a == "all": picks = list(idx.values())
        elif a in idx: picks = [idx[a]]
        elif a.upper() in BY_CC: picks = BY_CC[a.upper()]
        else:
            print(f"unknown location/country: {a}", file=sys.stderr); continue
        for l in picks:
            if l["key"] not in seen: seen.add(l["key"]); out.append(l)
    return out

def up(keys):
    targets, refused = over_quota(resolve_targets(keys))
    for r in refused:
        print(f"skip {r['key']}: {r['provider']} đã đủ {r['limit']} cổng", flush=True)
    clear_failed([l["key"] for l in targets])
    stop_gracefully([cname(l["key"]) for l in targets])
    state = load_state()
    st = load_settings()
    cr = load_creds()
    for l in targets:                 # only what the cap allowed, never the raw request
        k = l["key"]
        proto = l.get("protocol", "ikev2-cert")
        port = state.get(k, {}).get("port") or next_port(state)
        state[k] = {"port": port, "country": l["country"], "city": l["city"],
                    "name": l.get("countryName", l.get("provider", "")),
                    "provider": l.get("provider", "hma"), "protocol": proto,
                    "fqdn": l.get("fqdn"), "config": l.get("config"),
                    **{x: state.get(k, {})[x] for x in ("rotate_minutes", "last_rotate")
                       if x in state.get(k, {})}}
        args = ["run", "-d", "--name", cname(k), "--restart", "unless-stopped",
                "--cap-add", "NET_ADMIN",
                "-e", f"PROTOCOL={proto}", "-e", f"STATUS_KEY={k}",
                "-e", f"PROXY_USER={cr['user']}", "-e", f"PROXY_PASS={cr['pass']}",
                "-e", f"MTU={st['mtu']}", "-e", f"TUNNEL_DNS={st['dns']}",
                "-e", f"WATCHDOG_INTERVAL={st['watchdog_interval']}",
                "-e", f"WATCHDOG_FAILS={st['watchdog_fails']}",
                "-v", f"{STATUS_DIR_HOST}:/status",
                "-p", f"{st['bind']}:{port}:1080",
                "--label", "hma-farm=1", "--label", f"hma-key={k}"]
        if COMPOSE_PROJECT:   # group the ports under the compose project in Docker Desktop
            args += ["--label", f"com.docker.compose.project={COMPOSE_PROJECT}",
                     "--label", "com.docker.compose.service=port",
                     "--label", "com.docker.compose.oneoff=False"]
        if proto in ("wireguard", "openvpn"):
            args += ["-e", f"CONFIG=/config/{l['config']}",
                     "-v", f"{CONFIG_DIR_HOST}:/config:ro"]
            for env in ("OVPN_USER", "OVPN_PASS"):
                if os.environ.get(env): args += ["-e", f"{env}={os.environ[env]}"]
        else:  # ikev2-cert / ikev2-eap
            args += ["-e", f"SERVER={l['fqdn']}", "-v", f"{SECRETS}:/secrets:ro"]
            for env, field in (("EAP_USER", "eap_user"), ("EAP_PASS", "eap_pass"),
                               ("SERVER_ID", "server_id")):
                v = l.get(field) or os.environ.get(env)
                if v: args += ["-e", f"{env}={v}"]
        docker("rm", "-f", cname(k), check=False)   # already stopped gracefully above
        docker(*args, IMAGE)
        save_state(state)
        print(f"up  {k:28} :{port}  ({proto}  {l['country']} / {l['city']})")
    return {"started": [l["key"] for l in targets], "refused": refused}

def save_config(filename, content, provider=None):
    """Store an uploaded VPN config + a sidecar describing it. Returns the new target."""
    fn = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(filename))
    proto = detect_protocol(content)
    if not proto:
        raise ValueError("Không nhận ra định dạng — cần file WireGuard (.conf) hoặc OpenVPN (.ovpn)")
    if not fn.endswith((".conf", ".ovpn")):
        fn += ".conf" if proto == "wireguard" else ".ovpn"
    path = os.path.join(CONFIG_DIR, fn)
    with open(path, "w") as f: f.write(content)
    os.chmod(path, 0o600)
    json.dump({"provider": provider or guess_provider(fn), "protocol": proto,
               "country": guess_country(fn)},
              open(path + ".meta.json", "w"))
    return next(t for t in config_targets() if t["config"] == fn)

def delete_config(key):
    t = targets_index().get(key)
    if not t or not t.get("config"): return
    down([key])
    for p in (os.path.join(CONFIG_DIR, t["config"]),
              os.path.join(CONFIG_DIR, t["config"] + ".meta.json")):
        try: os.remove(p)
        except OSError: pass

def down(keys):
    """Delete: remove the container and drop the port assignment."""
    state = load_state()
    # No keys = every port in state. Fall back to the stored record for a target whose
    # source is gone (config deleted), so its container still gets removed.
    idx = targets_index()
    targets = (resolve_targets(keys) if keys else
               [idx.get(k, {**v, "key": k}) for k, v in list(state.items())])
    stop_gracefully([cname(l["key"]) for l in targets])   # send IKE DELETE first
    for l in targets:
        k = l["key"]
        docker("rm", "-f", cname(k), check=False)
        state.pop(k, None); save_state(state)
        try: os.remove(os.path.join(STATUS_DIR, k + ".json"))
        except OSError: pass
        print("down", k)

def stop(keys):
    """Switch off: close the session, remove the container, keep the port number.
    Start builds a fresh container from the current image, so a stopped port never
    lingers as a stale container running yesterday's code."""
    targets = resolve_targets(keys) or []
    names = [cname(l["key"]) for l in targets]
    for n in names: docker("update", "--restart", "no", n, check=False)
    stop_gracefully(names)
    for l in targets:
        k = l["key"]
        docker("rm", "-f", cname(k), check=False)
        for suffix in (".json", ".wait.json"):
            try: os.remove(os.path.join(STATUS_DIR, k + suffix))
            except OSError: pass
        print("stop", k)

def start(keys):
    allowed, refused = over_quota(resolve_targets(keys) or [])
    clear_failed([l["key"] for l in allowed])
    run = running_containers()
    # Stopped ports have no container any more: build them fresh, in one batch.
    todo = [l["key"] for l in allowed
            if (run.get(l["key"]) or {}).get("state") not in ("running", "restarting")]
    for k in todo: reset_backoff(k)
    if todo: up(todo)
    return {"started": [l["key"] for l in allowed], "refused": refused}

def rotate(keys):
    clear_failed([l["key"] for l in resolve_targets(keys)])
    state = load_state()
    for l in resolve_targets(keys):
        k = l["key"]
        reset_backoff(k)
        docker("restart", "-t", "6", cname(k), check=False)
        if k in state:
            state[k]["last_rotate"] = time.time(); save_state(state)
        try: os.remove(os.path.join(STATUS_DIR, k + ".json"))
        except OSError: pass
        print("rotate", k)

def set_autorotate(keys, minutes):
    """0 disables. Rotation happens in autorotate_loop()."""
    state = load_state()
    for l in resolve_targets(keys):
        k = l["key"]
        if k in state:
            state[k]["rotate_minutes"] = int(minutes)
            state[k].setdefault("last_rotate", time.time())
    save_state(state)
    print(f"auto-rotate = {minutes} min for {len(resolve_targets(keys))} port(s)")

def autorotate_loop():
    while True:
        try:
            state = load_state(); now = time.time()
            due = [k for k, v in state.items()
                   if v.get("rotate_minutes") and
                   now - v.get("last_rotate", 0) >= v["rotate_minutes"] * 60]
            if due:
                log_line(f"auto-rotate: {', '.join(due)}")
                rotate(due)
        except Exception:
            pass
        time.sleep(20)

def log_line(m): print(m, flush=True)

def container_logs(key, n=200):
    r = docker("logs", "--tail", str(n), cname(key), check=False)
    return (r.stdout or "") + (r.stderr or "")

def check_now(key):
    """Run the health probe inside the container right now (same path the watchdog uses)."""
    cr = load_creds()
    auth = f"{cr['user']}:{cr['pass']}@" if cr.get("user") else ""
    r = docker("exec", cname(key), "sh", "-c",
               f"curl -s -m 12 -x socks5h://{auth}127.0.0.1:1080 https://ipinfo.io/json",
               check=False)
    try:
        return {"ok": True, "info": json.loads(r.stdout)}
    except Exception:
        return {"ok": False, "error": (r.stderr or r.stdout or "no response")[:200]}

def test_port(key, speed=False):
    """What a user wants to know about a proxy: does it work, where does it come out,
    how fast. Runs inside the node so it measures the tunnel, not docker's port mapping."""
    cr = load_creds()
    px = f"socks5h://{cr['user']}:{cr['pass']}@127.0.0.1:1080"
    script = (f'P="{px}"; '
              'curl -s -m 20 -o /tmp/t.json -w "%{http_code} %{time_connect} %{time_appconnect} %{time_total}" '
              '-x "$P" https://ipinfo.io/json; echo; cat /tmp/t.json 2>/dev/null | tr -d "\n"; echo')
    if speed:
        script += ('; curl -s -m 30 -o /dev/null -w "%{http_code} %{speed_download} %{size_download}" '
                   '-x "$P" "https://speed.cloudflare.com/__down?bytes=5000000"; echo')
    r = docker("exec", cname(key), "sh", "-c", script, check=False)
    lines = (r.stdout or "").splitlines()
    out = {"key": key, "ok": False}
    try:
        code, tc, ta, tt = lines[0].split()
        out.update(http=int(code), connect_ms=int(float(tc)*1000),
                   tls_ms=int(float(ta)*1000), total_ms=int(float(tt)*1000))
        if code == "200":
            info = json.loads(lines[1])
            out.update(ok=True, ip=info.get("ip"), city=info.get("city"),
                       region=info.get("region"), country=info.get("country"),
                       org=info.get("org"), timezone=info.get("timezone"))
    except Exception:
        out["error"] = ((r.stderr or r.stdout or "không có phản hồi").strip().splitlines() or [""])[-1][:160]
    if speed and len(lines) >= 3:
        try:
            code, sp, size = lines[2].split()
            if code == "200" and int(float(size)) > 0:
                out["mbps"] = round(float(sp) * 8 / 1e6, 1)
        except Exception: pass
    t = targets_index().get(key) or {}
    out["expected_country"] = t.get("country")
    out["geo_match"] = bool(out.get("country")) and out.get("country") == t.get("country")
    return out

# --- live status ------------------------------------------------------------
def read_wait(key):
    try:
        d = json.load(open(os.path.join(STATUS_DIR, key + ".wait.json")))
        return d if d.get("until", 0) > time.time() else None
    except Exception:
        return None

def read_phase(key):
    """Which step a port that is still connecting is in (written by the node)."""
    try: return json.load(open(os.path.join(STATUS_DIR, key + ".phase.json")))
    except Exception: return None

def read_status(key):
    # Each tunnel container writes /status/<key>.json from inside its own netns (the reliable
    # path). We just read + freshness-check it; no cross-container network probing.
    try:
        d = json.load(open(os.path.join(STATUS_DIR, key + ".json")))
        if time.time() - d.get("ts", 0) > 60:
            return {"ip": None, "ok": False, "latency": None}
        info = d.get("info", {})
        return {"ip": info.get("ip"), "country": info.get("country"),
                "city": info.get("city"), "ok": True, "latency": d.get("latency")}
    except Exception:
        return {"ip": None, "ok": False, "latency": None}

FAIL_REASONS = (
    ("không gửi dữ liệu về",          "gateway bắt tay xong nhưng không gửi dữ liệu về"),
    ("IKE_SA_INIT_I: retransmission", "gateway không trả lời (IKE_SA_INIT)"),
    ("authentication failed",          "gateway từ chối chứng chỉ"),
    ("no connection is known",         "cấu hình tunnel sai"),
    ("FATAL:",                         "container không khởi động được"),
    ("Handshake did not complete",     "WireGuard không bắt tay được"),
    ("AUTH_FAILED",                    "sai tài khoản"),
)

def fail_reason(key):
    """A short, human reason pulled from the container's own log."""
    log = container_logs(key, 2000)
    for needle, why in FAIL_REASONS:
        if needle in log: return why
    return "tunnel không lên được"

def give_up(key, state=None):
    """Stop a port that keeps restarting without ever coming up. Docker would otherwise
    retry for ever, which burns CPU and shows a permanent 'connecting' that never ends."""
    state = state if state is not None else load_state()
    if key not in state: return
    why = fail_reason(key)
    docker("update", "--restart", "no", cname(key), check=False)
    docker("stop", "-t", "3", cname(key), check=False)
    try: os.remove(os.path.join(STATUS_DIR, key + ".json"))
    except OSError: pass
    state[key]["failed"] = {"at": int(time.time()), "why": why}
    save_state(state)
    print(f"give-up {key}: {why}", flush=True)

def reset_backoff(key):
    """A user asking for a retry means *now*, not after the node's back-off timer. The
    marker goes through the shared status dir because the node's own /run is out of
    reach while it is stopped; the node consumes it on its next start."""
    open(os.path.join(STATUS_DIR, key + ".now"), "w").close()
    try: os.remove(os.path.join(STATUS_DIR, key + ".wait.json"))
    except OSError: pass

def stop_gracefully(names, timeout=6):
    """SIGTERM so the node sends IKE DELETE; in parallel, because doing fifty in a row
    with a per-container grace period would take minutes."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(lambda n: docker("stop", "-t", str(timeout), n, check=False), names))

def clear_failed(keys):
    state = load_state(); touched = False
    for k in keys:
        if state.get(k, {}).pop("failed", None): touched = True
    if touched: save_state(state)

def supervisor_loop():
    while True:
        time.sleep(30)
        try:
            limit = load_settings()["give_up_after"]
            if limit <= 0: continue
            state = load_state(); run = running_containers()
            for k, v in list(state.items()):
                if v.get("failed"): continue
                info = run.get(k) or {}
                if info.get("state") != "running": continue
                try: n = int(info.get("restarts") or 0)
                except ValueError: continue
                # Restarting that often while never writing a status file means it has
                # never once carried traffic — not a blip.
                if n >= limit and not read_status(k).get("ok"):
                    give_up(k, state)
        except Exception as e:
            print("supervisor:", e, flush=True)

def running_containers():
    out = docker("ps", "-a", "--filter", "label=hma-farm=1",
                 "--format", "{{.Label \"hma-key\"}}\t{{.State}}\t{{.Names}}",
                 check=False)
    r = {}
    for line in out.stdout.strip().splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            rc = docker("inspect", "-f", "{{.RestartCount}}", parts[2],
                        check=False).stdout.strip()
            r[parts[0]] = {"state": parts[1], "restarts": rc or "?"}
    return r

def ls(as_json=False):
    state = load_state(); run = running_containers(); idx = targets_index()
    rows = []
    for k, v in sorted(state.items()):
        st = run.get(k, {}).get("state", "gone")
        s = read_status(k) if st == "running" else {}
        # Display fields come from the live target, not the port's frozen state: editing a
        # config's metadata should re-label the row without having to recreate the port.
        t = idx.get(k, v)
        rows.append({"key": k, "port": v["port"],
                     "name": t.get("countryName") or v["name"],
                     "city": t.get("city") or v["city"],
                     "country": t.get("country") or v["country"],
                     "state": st, "ip": s.get("ip"), "ok": s.get("ok"),
                     "latency": s.get("latency"),
                     "rotate_minutes": v.get("rotate_minutes", 0),
                     "provider": t.get("provider", v.get("provider", "hma")),
                     "protocol": t.get("protocol", v.get("protocol", "ikev2-cert")),
                     "failed": v.get("failed"),
                     "wait": read_wait(k) if st == "running" and not s.get("ok") else None,
                     "phase": read_phase(k) if st == "running" and not s.get("ok") else None,
                     "restarts": run.get(k, {}).get("restarts")})
    if as_json: return rows
    for r in rows:
        print(f"{r['key']:26} :{r['port']}  {r['state']:8} "
              f"{(r['ip'] or '-'):16} {r['country']} / {r['city']}")
    return rows

# --- web UI -----------------------------------------------------------------
UI_FILE = os.path.join(HERE, "ui.html")
_ui_cache = {"mtime": 0, "html": ""}
def ui_html():
    """Re-read when the file changes, so editing ui.html needs no restart."""
    m = os.path.getmtime(UI_FILE)
    if m != _ui_cache["mtime"]:
        with open(UI_FILE, encoding="utf-8") as f:
            _ui_cache.update(mtime=m, html=f.read())
    return _ui_cache["html"]

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        # Everything here is live state; a cached page shows a stale farm (and, after an
        # upgrade, a UI missing the features the user just installed).
        if not ctype.startswith("image/"):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p in ("/", "/index.html"): return self._send(200, ui_html(), "text/html; charset=utf-8")
        if p == "/api/locations":
            return self._send(200, json.dumps({"locations": all_targets()}))
        if p == "/api/status":
            c = load_creds()
            return self._send(200, json.dumps({
                "rows": ls(as_json=True), "bind": load_settings()["bind"],
                "auth": {"user": c["user"], "pass": c["pass"]},
                "rotate_key": rotate_key()}))
        if p == "/api/discover":
            return self._send(200, json.dumps(
                {"found": discover(), "scan": os.environ.get("HMA_SCAN_HOST", SCAN_DIR),
                 "inbox": os.environ.get("HMA_INBOX_HOST", INBOX)}))
        if p == "/api/providers":
            return self._send(200, json.dumps({"providers": providers_list()}))
        if p == "/api/settings":
            st = load_settings()
            return self._send(200, json.dumps({
                "settings": {k: st[k] for k in SETTABLE},
                "rotate_key": st["rotate_key"],
                "paths": {"secrets": SECRETS, "configs": CONFIG_DIR_HOST,
                          "status": STATUS_DIR_HOST, "state": STATE_FILE},
                "running": len(load_state())}))
        if p == "/api/logs":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            k = q.get("key", [""])[0]
            if k not in load_state(): return self._send(404, json.dumps({"error": "unknown port"}))
            return self._send(200, json.dumps({"key": k, "log": container_logs(k, int(q.get("n", ["300"])[0]))}))
        # Webhook: GET /api/rotate?key=<rotate_key>&port=29001  (or &all=1) — for automation
        if p == "/api/rotate":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("key", [""])[0] != rotate_key():
                return self._send(403, json.dumps({"error": "bad key"}))
            state = load_state()
            if q.get("all", [""])[0] in ("1", "true", "yes"):
                targets = list(state)
            else:
                port = q.get("port", [""])[0]
                targets = [k for k, v in state.items() if str(v["port"]) == str(port)]
            if not targets: return self._send(404, json.dumps({"error": "no matching port"}))
            rotate(targets)
            return self._send(200, json.dumps({"rotated": targets}))
        if p.startswith("/flags/"):
            fn = os.path.basename(p)
            fp = os.path.join(FLAGS_DIR, fn)
            if fn.endswith(".png") and os.path.isfile(fp):
                self.send_response(200); self.send_header("Content-Type", "image/png")
                self.send_header("Cache-Control", "max-age=86400")
                b = open(fp, "rb").read(); self.send_header("Content-Length", str(len(b)))
                self.end_headers(); self.wfile.write(b); return
            return self._send(404, "{}")
        return self._send(404, "{}")
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(n) or "{}")
        p = urllib.parse.urlparse(self.path).path
        keys = data.get("keys", [])
        if keys == "*": keys = list(load_state().keys())
        if p == "/api/up":
            return self._send(200, json.dumps({"ok": True, **up(keys)}))
        elif p == "/api/down": down(keys if keys else [])
        elif p == "/api/rotate": rotate(keys)
        elif p == "/api/stop": stop(keys)
        elif p == "/api/start":
            return self._send(200, json.dumps({"ok": True, **start(keys)}))
        elif p == "/api/autorotate": set_autorotate(keys, data.get("minutes", 0))
        elif p == "/api/upload":
            try:
                t = save_config(data.get("name", "config"), data.get("content", ""),
                                data.get("provider"))
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, "target": t}))
        elif p == "/api/delete-config":
            for k in keys: delete_config(k)
        elif p == "/api/settings":
            st = load_settings()
            changed = {k: v for k, v in (data.get("settings") or {}).items()
                       if k in SETTABLE and v not in ("", None) and v != st[k]}
            for k in ("base_port", "mtu", "watchdog_interval", "watchdog_fails"):
                if k in changed:
                    try: changed[k] = int(changed[k])
                    except ValueError: return self._send(400, json.dumps(
                        {"error": f"{k} phải là số"}))
            if data.get("new_rotate_key"):
                import secrets as _s
                changed["rotate_key"] = _s.token_urlsafe(16)
            st.update(changed); save_settings(st)
            # bind/creds/mtu/watchdog live in each container's `docker run` flags, so they
            # only take effect once the ports are recreated. Say so rather than lying.
            # base_port only affects ports created later; rotate_key lives in the manager
            # alone. Neither is baked into a running container, so neither needs a restart.
            needs = [k for k in changed if k not in
                     ("base_port", "rotate_key", "give_up_after")]
            restarted = []
            if needs and data.get("restart"):
                # Only ports that are on: recreating a stopped one would switch it on
                # behind the user's back (and could push a provider over its cap).
                run = running_containers()
                restarted = [k for k in load_state()
                             if (run.get(k) or {}).get("state") in ("running", "restarting")]
                up(restarted)
            return self._send(200, json.dumps(
                {"ok": True, "changed": sorted(changed), "restarted": len(restarted),
                 "needs_restart": bool(needs) and not data.get("restart")}))
        elif p == "/api/provider/hma":
            try:
                st = import_hma(token_text=data.get("token"), p12_b64=data.get("p12"),
                                password=data.get("password"))
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, "status": st}))
        elif p == "/api/discover":
            names = import_found(data.get("paths", []))
            return self._send(200, json.dumps({"ok": True, "imported": names}))
        elif p == "/api/provider/eap":
            try: t = add_eap(data)
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, "target": t}))
        elif p == "/api/provider/delete":
            try: delete_provider(data.get("id", ""))
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
        elif p == "/api/limit":
            try: set_limit(str(data.get("provider", "")).lower(), data.get("limit", 0))
            except (TypeError, ValueError):
                return self._send(400, json.dumps({"error": "giới hạn phải là số"}))
        elif p == "/api/test":
            from concurrent.futures import ThreadPoolExecutor
            ks = [k for k in keys if k in load_state()][:20]
            with ThreadPoolExecutor(max_workers=6) as ex:
                res = list(ex.map(lambda k: test_port(k, bool(data.get("speed"))), ks))
            return self._send(200, json.dumps({"results": res}))
        elif p == "/api/check":
            return self._send(200, json.dumps({k: check_now(k) for k in keys[:8]}))
        else: return self._send(404, "{}")
        return self._send(200, json.dumps({"ok": True}))

def serve():
    ingest_inbox()
    threading.Thread(target=inbox_loop, daemon=True).start()
    threading.Thread(target=autorotate_loop, daemon=True).start()
    threading.Thread(target=supervisor_loop, daemon=True).start()
    httpd = http.server.ThreadingHTTPServer((UI_BIND, UI_PORT), H)
    print(f"Proxy farm UI on http://{UI_BIND}:{UI_PORT}  (proxies bind {BIND}, image {IMAGE})", flush=True)
    httpd.serve_forever()

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    a = sys.argv[2:]
    {"serve": lambda: serve(), "up": lambda: up(a), "down": lambda: down(a),
     "ls": lambda: ls(), "rotate": lambda: rotate(a),
     "stop": lambda: stop(a), "start": lambda: start(a),
     "logs": lambda: print(container_logs(a[0])) if a else print("logs <KEY>"),
     "autorotate": lambda: set_autorotate(a[:-1], a[-1]) if len(a) > 1 else print("autorotate <KEY..> <minutes>"),
     }.get(cmd, lambda: print(__doc__))()
