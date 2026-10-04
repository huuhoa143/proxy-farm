#!/usr/bin/env python3
"""
Proxy Farm manager — turns VPN subscriptions (HMA, Surfshark, ZoogVPN, or any
WireGuard/OpenVPN/IKEv2 config) into many per-location SOCKS5/HTTP proxy ports, each a
Docker container running one tunnel + gost (see ../node). Shells out to `docker`.

  python3 farm.py serve                 # web UI on :8080 (default)
  python3 farm.py up <KEY|CC> ...        # start tunnels for locations/countries
  python3 farm.py down [KEY ...]         # stop (all if none given)
  python3 farm.py ls                     # list running proxies + exit IPs
  python3 farm.py rotate <KEY>           # reconnect (new gateway IP)

State: farm-state.json (chosen locations -> assigned port). Ports from BASE_PORT.
"""
import json, os, re, base64, subprocess, sys, time, threading, http.server, urllib.parse, socket
import vendors
import hma_activation

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.environ.get("PF_STATE", os.path.join(HERE, "farm-state.json"))
IMAGE = os.environ.get("PF_IMAGE", "proxy-farm-node")
SECRETS = os.environ.get("PF_SECRETS", os.path.expanduser("~/proxy-farm/secrets"))  # host path for -v
# Where the manager itself reads/writes the certificate. Same as SECRETS when it runs with
# host networking and no mount indirection; a published container must mount it.
COMPOSE_PROJECT = os.environ.get("PF_COMPOSE_PROJECT", "")
SECRETS_DIR = os.environ.get("PF_SECRETS_DIR", SECRETS)
BASE_PORT = int(os.environ.get("PF_BASE_PORT", "29001"))
FLAGS_DIR = os.environ.get("PF_FLAGS", os.path.join(HERE, "flags"))
STATUS_DIR = os.environ.get("PF_STATUS_DIR", os.path.join(HERE, "status"))   # in-container path
STATUS_DIR_HOST = os.environ.get("PF_STATUS_HOST", STATUS_DIR)               # host path for -v mounts
os.makedirs(STATUS_DIR, exist_ok=True)
BIND = os.environ.get("PF_BIND", "127.0.0.1")          # host iface proxies listen on
UI_PORT = int(os.environ.get("PF_UI_PORT", "8090"))
# Where the UI socket itself binds. Same as BIND when the manager runs with host
# networking; when it runs as a published container it must bind 0.0.0.0 inside the
# container and let `-p 127.0.0.1:...` do the restricting.
UI_BIND = os.environ.get("PF_UI_BIND", BIND)

# Drop zone on disk: anything left here is imported automatically. run.sh seeds it with
# the HMA device token when the app is installed on this machine.
INBOX = os.environ.get("PF_INBOX", "")
# Read-only directories scanned for VPN configs. Findings are only ever *suggested*;
# nothing outside INBOX is imported without the user asking.
SCAN_DIR = os.environ.get("PF_SCAN", "")

CONFIG_DIR = os.environ.get("PF_CONFIG_DIR", os.path.join(HERE, "configs"))
CONFIG_DIR_HOST = os.environ.get("PF_CONFIG_HOST", CONFIG_DIR)
os.makedirs(CONFIG_DIR, exist_ok=True)
# Configs the farm writes itself (one per Surfshark location), next to the uploaded ones
# so the same read-only mount serves both. Hidden from the upload list.
GEN_DIR = os.path.join(CONFIG_DIR, ".gen")
DATA_DIR = os.path.dirname(os.path.abspath(STATE_FILE))

# ---- targets -----------------------------------------------------------------
# A "target" is anything that can become a proxy port. Two sources:
#   vendor   — a built-in provider (vendors.py): its server list, one entry per location,
#              shown once no matter how many accounts the pool holds
#   config   — a .conf/.ovpn the user uploaded; one file = one location

def detect_protocol(text):
    if "[Interface]" in text and "PrivateKey" in text: return "wireguard"
    if re.search(r"^\s*remote\s+\S+", text, re.M): return "openvpn"
    return None

_CC = {f[:-4].upper() for f in os.listdir(FLAGS_DIR) if f.endswith(".png")} \
      if os.path.isdir(FLAGS_DIR) else set()
CC_NAME = {**vendors.COUNTRY_NAMES,
           **{l["country"]: l["countryName"] for l in vendors.HMA_LOCATIONS}}

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

# Each HMA account owns one folder of certificate files, mounted read-only into the
# ports it runs. The node always reads /secrets/client.pem, so the folder name is the
# only thing that differs between accounts.
def hma_secrets_dir(aid): return os.path.join(SECRETS_DIR, aid)
def hma_secrets_host(aid): return os.path.join(SECRETS, aid)

def cert_info(pem):
    """Subject CN (the device UDID) and expiry of a certificate on disk."""
    out = {}
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

def remove_hma_secrets(aid):
    d = hma_secrets_dir(aid)
    for f in os.listdir(d) if os.path.isdir(d) else []:
        try: os.remove(os.path.join(d, f))
        except OSError: pass
    try: os.rmdir(d)
    except OSError: pass

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

def import_hma(token_text=None, p12_b64=None, password=None, code=None, license_meta=None):
    """Install an HMA device certificate as an account. Accepts either the macOS app's
    tokenCoreSE.json (which carries the PKCS#12 *and* its password) or a raw .p12.
    Re-importing the same device refreshes that account instead of adding another.

    `code` (activation code) and `license_meta` (validate_code() result) are stored on
    the account when supplied, so the account is identified by the code the user typed
    and the farm can re-check expiry/slots later."""
    meta = {}
    if code:
        meta["code"] = hma_activation.normalize_code(code)
    if license_meta:
        meta["license"] = {k: license_meta.get(k) for k in
                           ("license_id", "product", "schema", "mode",
                            "expires_date", "devices_used", "devices_max")}
    if token_text:
        try:
            outer = json.loads(token_text)
            dev = json.loads(base64.b64decode(outer["DeviceManager.device"]))
            p12_b64 = dev["credentials"]["certificate"]
            password = dev["credentials"]["certificatePassword"]
            meta.update(udid=dev.get("udid", ""),
                        dns_format=(dev.get("dnsFormat") or [""])[0])
        except Exception as e:
            raise ValueError(f"Không đọc được tokenCoreSE.json: {e}")
    if not p12_b64:
        raise ValueError("Thiếu chứng chỉ")
    try: raw = base64.b64decode(p12_b64)
    except Exception: raise ValueError("Chứng chỉ không phải base64 hợp lệ")

    os.makedirs(SECRETS_DIR, exist_ok=True)
    tmp = os.path.join(SECRETS_DIR, ".import.p12")
    staged = {}
    with open(tmp, "wb") as f: f.write(raw)
    os.chmod(tmp, 0o600)
    try:
        leaf = _PEM_CERT.search(_openssl_p12(tmp, password or "", "-nokeys", "-clcerts"))
        key = _PEM_KEY.search(_openssl_p12(tmp, password or "", "-nocerts", "-nodes"))
        chain = _PEM_CERT.findall(_openssl_p12(tmp, password or "", "-nokeys", "-cacerts"))
        if not leaf or not key:
            raise ValueError("Chứng chỉ thiếu phần client hoặc khoá riêng")
        # Keep everything in memory until every part parsed, so a bad import can't
        # half-replace a working certificate and take the whole farm down.
        staged = {"client.pem": leaf.group(0) + "\n", "client.key": key.group(0) + "\n",
                  "ca-int.pem": "\n".join(chain) + "\n" if chain else ""}
    finally:
        try: os.remove(tmp)
        except OSError: pass

    udid = meta.get("udid") or ""
    # The same device re-imported (run.sh does this on every start) updates its account.
    a = next((x for x in accounts("hma") if udid and x.get("udid") == udid), None)
    if not a:
        a = add_account("hma", {"udid": udid}, udid[:18] + "…" if len(udid) > 19 else udid)
    else:
        prov = load_providers()
        for x in prov["accounts"]:
            if x["id"] == a["id"]: x.update(imported=int(time.time()), **meta)
        save_providers(prov)
    d = hma_secrets_dir(a["id"])
    os.makedirs(d, mode=0o700, exist_ok=True)
    for name, body in staged.items():
        if not body.strip(): continue
        path = os.path.join(d, name)
        with open(path, "w") as f: f.write(body)
        os.chmod(path, 0o600)
    prov = load_providers()
    for x in prov["accounts"]:
        if x["id"] == a["id"]: x.update(imported=int(time.time()), **meta)
    save_providers(prov)
    clear_acct_state(a["id"], "broken")
    info = cert_info(os.path.join(d, "client.pem"))
    return {"id": a["id"], "name": account_name(a), "locations": len(vendors.HMA_LOCATIONS),
            "accounts": len(accounts("hma")), **info}

def onboard_by_code(code, token_text=None, p12_b64=None, password=None, require_hma=True):
    """Onboard an HMA subscription by its activation code.

    Step 1 (always, off-device): validate the code against Avast's licensing backend.
    Step 2 (if a cert is supplied): install the device certificate and tag the account
    with the code + licence info, so from then on the farm runs it on any platform.

    When no cert is supplied we still validate and return the licence info, plus a
    `needs_cert` flag and instructions — the device certificate cannot be minted from
    the code alone (see hma_activation docstring / README: the Avast CCT wall)."""
    v = hma_activation.validate_code(code)          # raises ActivationError if bad
    if require_hma and not v.get("is_hma"):
        raise ValueError("Code hợp lệ nhưng không phải license HMA")
    v = {k: val for k, val in v.items() if k != "raw"}   # keep responses lean
    if not (token_text or p12_b64):
        return {"validated": True, "needs_cert": True, "license": v,
                "message": ("Code hợp lệ. Cần nạp chứng chỉ thiết bị MỘT lần "
                            "(tokenCoreSE.json hoặc .p12) — xem tools/hma-bootstrap-cert.sh. "
                            "Sau đó farm chạy đa nền tảng, không cần app HMA.")}
    st = import_hma(token_text=token_text, p12_b64=p12_b64, password=password,
                    code=v["code"], license_meta=v)
    return {"validated": True, "needs_cert": False, "license": v, "status": st}


def migrate_layout():
    """Bring a farm created before accounts existed up to date, once:
      secrets/client.pem            -> secrets/hma-1/client.pem + an 'hma-1' account
      ports with no account         -> bound to the only account of their vendor
    Re-running is harmless: each step is skipped when its result is already there."""
    prov = load_providers()
    changed = False
    root_pem = os.path.join(SECRETS_DIR, "client.pem")
    if os.path.exists(root_pem) and not [a for a in prov.get("accounts", []) if a["vendor"] == "hma"]:
        info = cert_info(root_pem)
        udid = info.get("udid") or prov.get("hma", {}).get("udid", "")
        a = {"id": "hma-1", "vendor": "hma", "n": 1, "udid": udid,
             "note": (udid[:18] + "…") if len(udid) > 19 else udid,
             "added": prov.get("hma", {}).get("imported") or int(time.time())}
        prov.setdefault("accounts", []).append(a)
        prov.pop("hma", None)
        d = hma_secrets_dir("hma-1")
        os.makedirs(d, mode=0o700, exist_ok=True)
        for f in ("client.pem", "client.key", "ca-int.pem"):
            src = os.path.join(SECRETS_DIR, f)
            if os.path.exists(src): os.replace(src, os.path.join(d, f))
        changed = True
        print("migrate: chứng chỉ HMA cũ -> tài khoản hma-1", flush=True)
    if changed: save_providers(prov)

    # Ports created before pooling carry no account; give them the one account their
    # vendor has. With several, rebalance() spreads them instead.
    state = load_state(); idx = targets_index(); orphan = []
    for k, v in state.items():
        if v.get("account"): continue
        t = idx.get(k)
        if t and t.get("vendor"): orphan.append(k)
    if orphan:
        done = rebalance(orphan)
        print(f"migrate: gán tài khoản cho {len(done)}/{len(orphan)} cổng cũ", flush=True)

# ---- automatic discovery ------------------------------------------------------
def _cert_mtime():
    """When the newest HMA certificate was written. The inbox token is re-imported only
    when it is newer, so this must look where certificates live now: one folder per
    account (the single secrets/client.pem layout is migrated away on start)."""
    newest = 0
    for a in accounts("hma"):
        try: newest = max(newest, os.path.getmtime(os.path.join(hma_secrets_dir(a["id"]), "client.pem")))
        except OSError: pass
    return newest

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

# ---- account pools -------------------------------------------------------------
# A built-in provider is a pool: the user adds one or more accounts, every location is
# listed once, and a port is bound to an account when it starts. Capacity, not copies.
def accounts(vendor=None):
    a = load_providers().get("accounts", [])
    return [x for x in a if not vendor or x["vendor"] == vendor]

def account(aid):
    return next((a for a in accounts() if a["id"] == aid), None)

def account_name(a):
    v = vendors.VENDORS.get(a["vendor"], {})
    n = a.get("n", 1)
    return v.get("name", a["vendor"]) + ("" if n == 1 else f" #{n}")

def vendor_targets():
    """Every location of every provider the user has at least one account for."""
    out = []
    for vid, v in vendors.VENDORS.items():
        if not accounts(vid): continue
        out += v["targets"](DATA_DIR)
    return out

def add_account(vid, clean, note):
    """Store a validated account. Returns it."""
    prov = load_providers()
    accts = prov.setdefault("accounts", [])
    if any(a["vendor"] == vid and all(a.get(k) == clean[k] for k in clean) for a in accts):
        raise ValueError(f"Tài khoản {vendors.VENDORS[vid]['name']} này đã có rồi")
    n = next(i for i in range(1, 1000) if i not in {a.get("n", 1) for a in accts if a["vendor"] == vid})
    a = {"id": f"{vid}-{n}", "vendor": vid, "n": n, "note": note,
         "added": int(time.time()), **clean}
    accts.append(a)
    save_providers(prov)
    return a

def add_vendor_account(d):
    vid = d.get("vendor")
    v = vendors.VENDORS.get(vid)
    if not v or not v.get("fields"): raise ValueError("Nhà cung cấp không hỗ trợ")
    clean, note = v["check"](d)
    first = not accounts(vid)
    a = add_account(vid, clean, note)
    if vid == "surfshark": vendors.surfshark_clusters(DATA_DIR, refresh=True)
    ts = v["targets"](DATA_DIR)
    if not ts:
        delete_account(a["id"])
        raise ValueError("Chưa tải được danh sách máy chủ của nhà cung cấp — thử lại sau")
    return {"id": a["id"], "name": account_name(a), "first": first,
            "accounts": len(accounts(vid)),
            "locations": len(ts), "countries": len({t["country"] for t in ts})}

# ---- which account runs a port --------------------------------------------------
def acct_state():
    """Per-account notes the farm learned at runtime: a measured session cap, or an
    account the provider rejected. Kept out of providers.json's secrets on purpose? No —
    same file, but under its own key so a rewrite of the account list cannot lose it."""
    return load_providers().get("acct_state", {})

def set_acct_state(aid, **kw):
    prov = load_providers()
    st = prov.setdefault("acct_state", {}).setdefault(aid, {})
    st.update({k: v for k, v in kw.items() if v is not None})
    save_providers(prov)

def clear_acct_state(aid, *keys):
    prov = load_providers()
    st = prov.get("acct_state", {}).get(aid)
    if not st: return
    for k in (keys or list(st)): st.pop(k, None)
    save_providers(prov)

def acct_capacity(a):
    """How many ports this account may hold: the user's limit, else what the provider
    turned out to allow, else the vendor default (0 = no limit)."""
    lim = get_limits()
    if a["id"] in lim: return int(lim[a["id"]])
    learned = acct_state().get(a["id"], {}).get("cap")
    if learned is not None: return int(learned)
    if a["vendor"] in lim: return int(lim[a["vendor"]])
    return DEFAULT_LIMITS.get(a["vendor"], 0)

def acct_usable(a):
    return not acct_state().get(a["id"], {}).get("broken")

def acct_load(state=None, run=None, exclude=None):
    """Ports currently assigned to each account. Only ports that are switched on count:
    a stopped port holds no session at the provider."""
    state = state if state is not None else load_state()
    run = run if run is not None else running_containers()
    out = {}
    for k, v in state.items():
        if k == exclude or not v.get("account"): continue
        if (run.get(k) or {}).get("state") not in ("running", "restarting"): continue
        out[v["account"]] = out.get(v["account"], 0) + 1
    return out

# A provider can accept an account on some servers and refuse it on others (ZoogVPN's
# cheaper plans cover only part of the network). The refusal is remembered per
# (account, server) and re-checked after a week, in case the plan changes.
REFUSAL_TTL = 7 * 86400

def refused_by(aid):
    now = time.time()
    return {k for k, t in (acct_state().get(aid, {}).get("refused") or {}).items()
            if now - t < REFUSAL_TTL}

def note_refusal(aid, key, ok):
    prov = load_providers()
    st = prov.setdefault("acct_state", {}).setdefault(aid, {})
    ref = st.setdefault("refused", {})
    if ok: ref.pop(key, None)
    else: ref[key] = int(time.time())
    save_providers(prov)

def blocked_keys(vendor):
    """Servers no usable account of this vendor can use."""
    accs = [a for a in accounts(vendor) if acct_usable(a)]
    if not accs: return set()
    out = None
    for a in accs:
        r = refused_by(a["id"])
        out = r if out is None else out & r
    return out or set()

def pick_account(vendor, load, prefer=None, key=None):
    """The emptiest usable account of this vendor that still has room, counting `load`
    (mutated as ports are assigned). `prefer` wins ties so a restart keeps its account;
    accounts the provider refused for `key` are skipped."""
    free = []
    for a in accounts(vendor):
        if not acct_usable(a): continue
        if key and key in refused_by(a["id"]): continue
        cap = acct_capacity(a)
        used = load.get(a["id"], 0)
        if cap and used >= cap: continue
        free.append((used, 0 if prefer == a["id"] else 1, a["n"], a))
    if not free: return None
    free.sort(key=lambda x: x[:3])
    a = free[0][3]
    load[a["id"]] = load.get(a["id"], 0) + 1
    return a

def bind_target(t, acct):
    """Turn (location, account) into the extra docker args that port needs."""
    v = vendors.VENDORS[t["vendor"]]
    b = v["bind"](t, acct) or {}
    if b.get("config_text"):
        os.makedirs(GEN_DIR, mode=0o700, exist_ok=True)
        path = os.path.join(CONFIG_DIR, t["config"])
        with open(path, "w") as f: f.write(b["config_text"])
        os.chmod(path, 0o600)
    return b

def delete_account(aid, reassign=True):
    """Remove one account. Its ports move to another account of the same vendor; ports
    with nowhere to go are switched off, and the last account of a vendor takes its
    ports with it."""
    a = account(aid)
    if not a: return {}
    prov = load_providers()
    prov["accounts"] = [x for x in prov.get("accounts", []) if x["id"] != aid]
    prov.get("acct_state", {}).pop(aid, None)
    prov.get("limits", {}).pop(aid, None)
    save_providers(prov)
    if a["vendor"] == "hma": remove_hma_secrets(aid)
    mine = [k for k, v in load_state().items() if v.get("account") == aid]
    if not mine: return {"moved": 0, "stopped": 0, "removed": 0}
    if not accounts(a["vendor"]):          # vendor gone entirely: its ports go with it
        down(mine); return {"moved": 0, "stopped": 0, "removed": len(mine)}
    if not reassign:
        stop(mine); return {"moved": 0, "stopped": len(mine), "removed": 0}
    moved = rebalance(mine)
    left = [k for k in mine if k not in moved]
    if left: stop(left)
    return {"moved": len(moved), "stopped": len(left), "removed": 0}

def rebalance(keys):
    """Give each of these ports a new account and recreate the running ones. Returns the
    keys that found one."""
    idx = targets_index(); state = load_state(); run = running_containers()
    load = acct_load(state, run, exclude=None)
    for k in keys: load[state.get(k, {}).get("account")] = max(
        0, load.get(state.get(k, {}).get("account"), 0) - 1)
    ok, live = [], []
    for k in keys:
        t = idx.get(k)
        if not t or not t.get("vendor"): continue
        a = pick_account(t["vendor"], load, key=k)
        if not a: continue
        state[k]["account"] = a["id"]; ok.append(k)
        if (run.get(k) or {}).get("state") in ("running", "restarting"): live.append(k)
    save_state(state)
    if live: up(live)
    return ok

def delete_provider(pid, reassign=True):
    """Remove a whole provider card: a pool (every account), an uploaded-config provider,
    or a manually added IKEv2 provider. Deleting one account goes through delete_account."""
    if pid in vendors.VENDORS:
        res = {"moved": 0, "stopped": 0, "removed": 0}
        for a in list(accounts(pid)):
            r = delete_account(a["id"], reassign=reassign)
            for k in res: res[k] += r.get(k, 0)
        return res
    prov = load_providers()
    gone = [e for e in prov.get("eap", []) if slug(e["name"]) == pid]
    if gone:
        down(["EAP-" + e["id"] for e in gone])
        prov["eap"] = [e for e in prov["eap"] if slug(e["name"]) != pid]
        save_providers(prov)
    else:                 # a file-based provider: every config tagged with this name
        for t in config_targets():
            if t["provider"] == pid: delete_config(t["key"])
    return {}

# ---- per-provider port limits --------------------------------------------------
# Most providers cap simultaneous connections per account, so the farm refuses to start
# more than the cap rather than let the provider kick sessions. 0 = no limit.
# HMA: no limit — 20+ concurrent ran stable; what broke big farms was stuck reconnects,
# not the count. HMA ends every session after ~4.5 h; the watchdog reconnects in seconds.
DEFAULT_LIMITS = {"hma": 0, "protonvpn": 10, "proton": 10, "nordvpn": 10, "mullvad": 5,
                  "expressvpn": 8, "cyberghost": 7, "surfshark": 0, "zoogvpn": 0, "pia": 0,
                  "ipvanish": 0, "windscribe": 0, "custom": 0}

def limit_key(t):
    """What a target's cap is counted against. Pool providers are capped per *account*,
    which is only known once a port is bound, so the pool as a whole is the unit here."""
    if t.get("vendor"): return t["vendor"]
    return (t.get("provider") or "custom").lower()

def default_limit(key):
    # "surfshark-2" is an account of the surfshark pool: same default as its vendor.
    return DEFAULT_LIMITS.get(key, DEFAULT_LIMITS.get(key.rsplit("-", 1)[0], 0))

def pool_capacity(vendor):
    """Total ports a pool can hold: the sum of its usable accounts. 0 = no limit."""
    caps = [acct_capacity(a) for a in accounts(vendor) if acct_usable(a)]
    return 0 if not caps or any(c == 0 for c in caps) else sum(caps)

def get_limits():
    return load_providers().get("limits", {})

def limit_for(key):
    lim = get_limits()
    return int(lim[key]) if key in lim else default_limit(key)

def set_limit(key, n):
    prov = load_providers()
    prov.setdefault("limits", {})[key] = max(0, int(n))
    save_providers(prov)

def min_limit(*xs):
    """Smallest non-zero limit; 0 (unlimited) only wins when everything is unlimited."""
    real = [x for x in xs if x]
    return min(real) if real else 0

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
        lk = limit_key(t)
        lim = min_limit(pool_capacity(lk), limit_for(lk)) if t.get("vendor") else limit_for(lk)
        if lim and used.get(lk, 0) >= lim:
            refused.append({"key": t["key"], "provider": lk, "limit": lim})
        else:
            used[lk] = used.get(lk, 0) + 1; ok.append(t)
    return ok, refused

def providers_list():
    """One card per provider. A built-in provider is a pool and carries its accounts."""
    out = []
    state = load_state(); run = running_containers()
    load = acct_load(state, run)
    astate = acct_state()
    # Countries each account is serving right now, for "9 cổng · 7 nước" on its row.
    acct_cc = {}
    for k, v in state.items():
        if v.get("account") and (run.get(k) or {}).get("state") in ("running", "restarting"):
            acct_cc.setdefault(v["account"], set()).add(v.get("country"))
    for vid, v in vendors.VENDORS.items():
        mine = accounts(vid)
        if not mine: continue
        ts = v["targets"](DATA_DIR)
        accs = []
        for a in mine:
            cap = acct_capacity(a)
            row = {"id": a["id"], "name": account_name(a), "n": a.get("n", 1),
                   "note": a.get("note", ""),
                   "used": load.get(a["id"], 0), "limit": cap,
                   "used_countries": len(acct_cc.get(a["id"], ())),
                   "refused": len(refused_by(a["id"])),
                   "limit_default": DEFAULT_LIMITS.get(vid, 0),
                   "learned": astate.get(a["id"], {}).get("cap") is not None,
                   "broken": astate.get(a["id"], {}).get("broken")}
            if vid == "hma":
                row.update(note="", **cert_info(os.path.join(hma_secrets_dir(a["id"]), "client.pem")))
                if a.get("code"): row["code_tail"] = a["code"][-4:]   # never the full code
                if a.get("license"): row["license"] = a["license"]
            accs.append(row)
        out.append({"id": vid, "kind": v["protocol"], "name": v["name"], "vendor": vid,
                    "pool": True, "ready": True, "accounts": accs,
                    "locations": len(ts), "countries": len({t["country"] for t in ts}),
                    "country_set": sorted({t["country"] for t in ts}),
                    "limit_key": vid, "used": sum(a["used"] for a in accs),
                    "capacity": pool_capacity(vid)})
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
    used = usage(run)
    for p in out:
        lk = p.get("limit_key") or (p["name"].lower())
        p["limit_key"] = lk
        p["limit"] = limit_for(lk)
        p.setdefault("limit_default", default_limit(lk))
        p.setdefault("used", used.get(lk, 0))
    return out

def all_targets():
    # No account = no locations, so a fresh install shows an honest empty farm instead
    # of hundreds of ports that would all fail to start.
    return vendor_targets() + config_targets() + eap_targets()

def targets_index():
    return {t["key"]: t for t in all_targets()}

def load_state():
    try: return json.load(open(STATE_FILE))
    except Exception: return {}
def save_state(s): json.dump(s, open(STATE_FILE, "w"), indent=1)

SETTINGS_FILE = os.path.join(os.path.dirname(STATE_FILE), "settings.json")
CREDS_FILE = os.path.join(os.path.dirname(STATE_FILE), "creds.json")   # pre-settings layout

# Environment gives the defaults; settings.json (written by the UI) overrides them, so a
# user who never opens Settings behaves exactly as the docker run flags say.
DEFAULTS = {
    "proxy_user": os.environ.get("PF_PROXY_USER", "proxy"),
    "proxy_pass": os.environ.get("PF_PROXY_PASS", ""),
    "rotate_key": "",
    "bind": BIND,
    "base_port": BASE_PORT,
    "mtu": int(os.environ.get("PF_MTU", "1400")),
    "watchdog_interval": int(os.environ.get("PF_WATCHDOG_INTERVAL", "15")),
    "watchdog_fails": int(os.environ.get("PF_WATCHDOG_FAILS", "3")),
    # Nodes already back off to one attempt per 30 min, which is cheap and self-heals
    # when a gateway lifts its block. Giving up for good is therefore opt-in.
    "give_up_after": int(os.environ.get("PF_GIVE_UP_AFTER", "0")),
    "dns": os.environ.get("PF_TUNNEL_DNS", "1.1.1.1 8.8.8.8"),
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
def cname(key): return "pf-" + key.lower()

def used_ports(state):
    return {v["port"] for v in state.values()}
def next_port(state):
    used = used_ports(state)
    p = load_settings()["base_port"]
    while p in used: p += 1
    return p

def resolve_targets(args):
    """Expand KEY / country-code / 'all' into a list of target dicts.

    A port can outlive its catalog entry (the provider renamed or retired that server).
    Such a port still has everything it needs in farm-state.json, so fall back to that:
    otherwise the user could neither stop nor delete what is plainly on their screen."""
    idx = targets_index()
    state = load_state()
    out, seen = [], set()
    for a in args:
        if a == "all": picks = list(idx.values())
        elif a in idx: picks = [idx[a]]
        elif a in state: picks = [{**state[a], "key": a, "orphan": True}]
        elif any(t["country"] == a.upper() for t in idx.values()):
            picks = [t for t in idx.values() if t["country"] == a.upper()]
        else:
            print(f"unknown location/country: {a}", file=sys.stderr); continue
        for l in picks:
            if l["key"] not in seen: seen.add(l["key"]); out.append(l)
    return out

def up(keys, pin_account=None):
    """`pin_account` (optional) pins every port of that account's vendor to it; other
    vendors in the same batch are still spread automatically."""
    targets, refused = over_quota(resolve_targets(keys))
    for r in refused:
        print(f"skip {r['key']}: {r['provider']} đã đủ {r['limit']} cổng", flush=True)
    clear_failed([l["key"] for l in targets])
    stop_gracefully([cname(l["key"]) for l in targets])
    state = load_state()
    st = load_settings()
    cr = load_creds()
    # Bind every pool port to an account before starting any, so one call spreads the
    # batch across the pool instead of filling the first account and failing the rest.
    run = running_containers()
    load = acct_load(state, run, exclude=None)
    mine = {l["key"] for l in targets}
    for k in mine: load[state.get(k, {}).get("account")] = max(
        0, load.get(state.get(k, {}).get("account"), 0) - 1)
    load.pop(None, None)
    bound, nofree = {}, []
    for l in targets:
        if not l.get("vendor"): continue
        pin = account(pin_account) if pin_account else None
        if pin and pin["vendor"] == l["vendor"] and acct_usable(pin) \
                and l["key"] not in refused_by(pin["id"]):
            a = pin; load[a["id"]] = load.get(a["id"], 0) + 1
        else:
            a = pick_account(l["vendor"], load, prefer=state.get(l["key"], {}).get("account"),
                             key=l["key"])
        if a: bound[l["key"]] = a
        else: nofree.append(l)
    for l in nofree:
        v = vendors.VENDORS[l["vendor"]]
        plan = l["key"] in blocked_keys(l["vendor"])
        refused.append({"key": l["key"], "provider": l["vendor"],
                        "limit": pool_capacity(l["vendor"]),
                        "reason": "plan" if plan else "full"})
        print(f"skip {l['key']}: " + (f"không tài khoản {v['name']} nào được dùng máy chủ này"
              if plan else f"{v['name']} không còn tài khoản trống"), flush=True)
    targets = [l for l in targets if not l.get("vendor") or l["key"] in bound]
    for l in targets:                 # only what the cap allowed, never the raw request
        k = l["key"]
        proto = l.get("protocol", "ikev2-cert")
        port = state.get(k, {}).get("port") or next_port(state)
        acct = bound.get(k)
        state[k] = {"port": port, "country": l["country"], "city": l["city"],
                    "name": l.get("countryName", l.get("provider", "")),
                    "provider": l.get("provider", "hma"), "protocol": proto,
                    "fqdn": l.get("fqdn"), "config": l.get("config"),
                    "account": acct["id"] if acct else None,
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
                "--label", "proxy-farm.port=1", "--label", f"proxy-farm.key={k}"]
        if COMPOSE_PROJECT:   # group the ports under the compose project in Docker Desktop
            args += ["--label", f"com.docker.compose.project={COMPOSE_PROJECT}",
                     "--label", "com.docker.compose.service=port",
                     "--label", "com.docker.compose.oneoff=False"]
        extra = bind_target(l, acct) if acct else {}
        for env, val in (extra.get("env") or {}).items():
            args += ["-e", f"{env}={val}"]
        if proto in ("wireguard", "openvpn"):
            args += ["-e", f"CONFIG=/config/{l['config']}",
                     "-v", f"{CONFIG_DIR_HOST}:/config:ro"]
            for env in ("OVPN_USER", "OVPN_PASS"):
                if os.environ.get(env): args += ["-e", f"{env}={os.environ[env]}"]
        else:  # ikev2-cert / ikev2-eap
            sec = hma_secrets_host(extra["secrets"]) if extra.get("secrets") else SECRETS
            args += ["-e", f"SERVER={l['fqdn']}", "-v", f"{sec}:/secrets:ro"]
            for env, field in (("EAP_USER", "eap_user"), ("EAP_PASS", "eap_pass"),
                               ("SERVER_ID", "server_id"), ("SERVER_IP", "server_ip")):
                v = l.get(field) or os.environ.get(env)
                if v and not any(x == f"{env}={v}" for x in args): args += ["-e", f"{env}={v}"]
        docker("rm", "-f", cname(k), check=False)   # already stopped gracefully above
        docker(*args, IMAGE)
        save_state(state)
        print(f"up  {k:28} :{port}  ({proto}  {l['country']} / {l['city']}"
              + (f"  {acct['id']}" if acct else "") + ")")
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
    ("máy chủ từ chối phiên này",      "đăng nhập đúng nhưng nhà cung cấp từ chối phiên"),
    ("sai email hoặc mật khẩu",        "sai email hoặc mật khẩu"),
    ("đã đổi so với lần trước",        "khoá máy chủ đã đổi — từ chối kết nối"),
    ("không do CA hợp lệ cấp",         "chứng chỉ máy chủ không hợp lệ"),
    ("WireGuard không bắt tay được",   "WireGuard không bắt tay được (key sai hoặc hết gói?)"),
)

def fail_reason(key):
    """A short, human reason pulled from the container's own log."""
    log = container_logs(key, 2000)
    for needle, why in FAIL_REASONS:
        if needle in log: return why
    return "tunnel không lên được"

def give_up(key, state=None, why=None):
    """Stop a port that keeps restarting without ever coming up. Docker would otherwise
    retry for ever, which burns CPU and shows a permanent 'connecting' that never ends."""
    state = state if state is not None else load_state()
    if key not in state: return
    why = why or fail_reason(key)
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

def learn_from_failures():
    """Keep the pool honest about its accounts:
      badlogin   the provider rejected the password itself -> stop handing ports to it
      online     any port of an account works -> whatever was noted against it is wrong
    Deliberately NOT done: inferring a connection cap from refusals. Refusals also come
    from sessions the server still holds after a restart, or from rate limits; a cap
    "learned" that way once turned a working account into "1 connection". Caps are
    only what the user sets."""
    state = load_state(); run = running_containers()
    noted = acct_state()
    online = set()
    for k, v in state.items():
        a = v.get("account")
        if a and (run.get(k) or {}).get("state") == "running" and read_status(k).get("ok"):
            online.add(a)
    for aid in online:
        if noted.get(aid, {}).get("broken"):
            clear_acct_state(aid, "broken")
            log_line(f"pool: {aid} đang chạy bình thường — xoá ghi chú lỗi cũ")
    # A server that works for an account is no longer "refused" for it.
    for k, v in state.items():
        aid = v.get("account")
        if aid and k in refused_by(aid) and read_status(k).get("ok"):
            note_refusal(aid, k, ok=True)
    move, dead = [], []
    for k, v in state.items():
        aid = v.get("account")
        if not aid or (run.get(k) or {}).get("state") != "running" or read_status(k).get("ok"):
            continue
        if (read_wait(k) or {}).get("why") == "refused":
            if k not in refused_by(aid):
                note_refusal(aid, k, ok=False)
                log_line(f"pool: {aid} không được dùng máy chủ {k}")
            (move if pick_account(v.get("provider"), {}, key=k) else dead).append(k)
    for k, v in state.items():
        aid = v.get("account")
        if not aid or aid in online or (run.get(k) or {}).get("state") != "running": continue
        if (read_wait(k) or {}).get("why") == "badlogin" and not noted.get(aid, {}).get("broken"):
            set_acct_state(aid, broken="badlogin")
            log_line(f"pool: {aid} sai email/mật khẩu — ngừng dùng")
            move += [x for x, y in state.items() if y.get("account") == aid]
    if move:
        moved = rebalance(sorted(set(move)))
        if moved: log_line(f"pool: chuyển {len(moved)} cổng sang tài khoản khác")
    # No account of yours may use this server: retrying forever would only keep asking
    # the provider for something your plan does not include. Switch it off and say why.
    for k in dead:
        give_up(k, why="gói của bạn không cho dùng máy chủ này — chọn vị trí khác")

def reap_strays():
    """Remove port containers the farm no longer knows about. One shows up when a request
    to start a port lands after the port was deleted (a slow client, a retry): nothing in
    farm-state.json points at it, so nothing would ever stop it — and with an IKEv2/EAP
    provider it silently holds one of the account's sessions."""
    state = load_state()
    out = docker("ps", "-a", "--filter", "label=proxy-farm.port=1",
                 "--format", "{{.Label \"proxy-farm.key\"}}\t{{.Names}}", check=False)
    for line in (out.stdout or "").strip().splitlines():
        key, _, name = line.partition("\t")
        if key and key not in state:
            docker("stop", "-t", "6", name, check=False)   # SIGTERM first: IKE DELETE
            docker("rm", "-f", name, check=False)
            log_line(f"reap: xoá container lạc {name} (cổng {key} không còn trong danh sách)")

def supervisor_loop():
    while True:
        time.sleep(30)
        try:
            reap_strays()
            learn_from_failures()
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
    out = docker("ps", "-a", "--filter", "label=proxy-farm.port=1",
                 "--format", "{{.Label \"proxy-farm.key\"}}\t{{.State}}\t{{.Names}}",
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
                     "vendor": t.get("vendor", v.get("provider")),
                     "account": v.get("account"),
                     # The catalog no longer lists this server: the port still runs, but
                     # nothing will recreate it, so the UI must offer a way out.
                     "orphan": k not in idx,
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
            # Logins stay server-side; the browser only needs to know the location exists.
            blocked = {}
            for vid in vendors.VENDORS: blocked[vid] = blocked_keys(vid)
            return self._send(200, json.dumps({"locations": [
                {**{k: v for k, v in t.items() if k not in ("eap_pass", "eap_user")},
                 **({"blocked": True} if t["key"] in blocked.get(t.get("vendor"), ()) else {})}
                for t in all_targets()]}))
        if p == "/api/status":
            c = load_creds()
            return self._send(200, json.dumps({
                "rows": ls(as_json=True), "bind": load_settings()["bind"],
                "auth": {"user": c["user"], "pass": c["pass"]},
                "rotate_key": rotate_key()}))
        if p == "/api/discover":
            return self._send(200, json.dumps(
                {"found": discover(), "scan": os.environ.get("PF_SCAN_HOST", SCAN_DIR),
                 "inbox": os.environ.get("PF_INBOX_HOST", INBOX)}))
        if p == "/api/providers":
            pl = providers_list()
            cc = set()
            for x in pl: cc.update(x.pop("country_set", []) or [])
            cc.update(t["country"] for t in config_targets() + eap_targets())
            summary = {"providers": len(pl),
                       "accounts": sum(len(x.get("accounts") or [1]) for x in pl),
                       "servers": sum(x.get("locations") or 0 for x in pl),
                       "countries": len(cc),
                       "running": sum(x.get("used") or 0 for x in pl)}
            return self._send(200, json.dumps({"providers": pl, "summary": summary}))
        if p == "/api/vendors":
            return self._send(200, json.dumps({"vendors": vendors.public()}))
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
            return self._send(200, json.dumps({"ok": True, **up(keys, data.get("account"))}))
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
        elif p == "/api/provider/hma-sync":
            # Import the HMA certificate a host-side helper dropped in the inbox (the app
            # keeps it outside anything Docker Desktop shares, so the container cannot read
            # it directly). Force-imports even an unchanged token so the button is reliable.
            tok = os.path.join(INBOX, "tokenCoreSE.json") if INBOX else ""
            found = bool(tok and os.path.isfile(tok))
            imported = False
            if found:
                try:
                    st = import_hma(token_text=open(tok, encoding="utf-8").read())
                    imported = True
                except Exception as e:
                    return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, "found": found,
                "imported": imported, "has_cert": bool(accounts("hma")),
                "inbox": os.environ.get("PF_INBOX_HOST", INBOX),
                "status": (st if imported else None)}))
        elif p == "/api/provider/hma-tag":
            # Attach a validated activation code to the HMA account that already has a
            # certificate. No shell, no background work — just records the code + licence.
            try:
                v = hma_activation.validate_code(data.get("code", ""))
            except hma_activation.ActivationError as e:
                return self._send(400, json.dumps({"error": str(e), "kind": "activation"}))
            accs = accounts("hma")
            if not accs:
                return self._send(400, json.dumps({"error": "Chưa có chứng chỉ HMA để gắn code",
                                                   "needs_cert": True}))
            aid = data.get("id") or accs[0]["id"]
            prov = load_providers()
            for x in prov["accounts"]:
                if x["id"] == aid:
                    x["code"] = v["code"]
                    x["license"] = {k: v.get(k) for k in ("license_id", "product", "schema",
                                    "mode", "expires_date", "devices_used", "devices_max")}
            save_providers(prov)
            return self._send(200, json.dumps({"ok": True, "license":
                {k: v[k] for k in v if k != "raw"}, "account": aid}))
        elif p == "/api/provider/hma-code":
            try:
                r = onboard_by_code(data.get("code", ""), token_text=data.get("token"),
                                    p12_b64=data.get("p12"), password=data.get("password"))
            except hma_activation.ActivationError as e:
                return self._send(400, json.dumps({"error": str(e), "kind": "activation"}))
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, **r}))
        elif p == "/api/discover":
            names = import_found(data.get("paths", []))
            return self._send(200, json.dumps({"ok": True, "imported": names}))
        elif p == "/api/provider/account":
            try: r = add_vendor_account(data)
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, **r}))
        elif p == "/api/provider/eap":
            try: t = add_eap(data)
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, "target": t}))
        elif p == "/api/provider/delete":
            try: r = delete_provider(data.get("id", ""))
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, **(r or {})}))
        elif p == "/api/account/delete":
            try: r = delete_account(data.get("id", ""))
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"ok": True, **(r or {})}))
        elif p == "/api/account/rebalance":
            keys = keys or [k for k, v in load_state().items() if v.get("account")]
            return self._send(200, json.dumps({"ok": True, "moved": rebalance(keys)}))
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
    try: migrate_layout()
    except Exception as e: print("migrate:", e, flush=True)
    ingest_inbox()
    threading.Thread(target=inbox_loop, daemon=True).start()
    threading.Thread(target=autorotate_loop, daemon=True).start()
    threading.Thread(target=supervisor_loop, daemon=True).start()
    httpd = http.server.ThreadingHTTPServer((UI_BIND, UI_PORT), H)
    print(f"Proxy farm UI on http://{UI_BIND}:{UI_PORT}  (proxies bind {BIND}, image {IMAGE})", flush=True)
    httpd.serve_forever()

def _cli_validate_code(a):
    if not a:
        print("validate-code <ACTIVATION-CODE>"); return
    try:
        v = hma_activation.validate_code(a[0])
    except hma_activation.ActivationError as e:
        print("✗", e); sys.exit(2)
    print("✓ hợp lệ" + ("" if v["is_hma"] else "  (CẢNH BÁO: không phải HMA)"))
    print(" ", hma_activation.summary_line(v))


def _cli_onboard_code(a):
    """onboard-code <CODE> [tokenCoreSE.json | cert.p12] [p12-password]"""
    if not a:
        print("onboard-code <CODE> [tokenCoreSE.json | cert.p12] [p12-password]"); return
    code = a[0]
    token_text = p12_b64 = password = None
    if len(a) > 1 and os.path.exists(a[1]):
        path = a[1]
        if path.endswith(".json"):
            token_text = open(path).read()
        else:
            p12_b64 = base64.b64encode(open(path, "rb").read()).decode()
            password = a[2] if len(a) > 2 else ""
    try:
        r = onboard_by_code(code, token_text=token_text, p12_b64=p12_b64, password=password)
    except hma_activation.ActivationError as e:
        print("✗ code:", e); sys.exit(2)
    except Exception as e:
        print("✗", e); sys.exit(2)
    print("✓", hma_activation.summary_line(r["license"]))
    if r.get("needs_cert"):
        print(" ", r["message"])
    else:
        s = r["status"]
        print(f"  Đã nạp chứng chỉ → account {s['id']} ({s['name']}), "
              f"{s['accounts']} account HMA, {s['locations']} vị trí sẵn sàng.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    a = sys.argv[2:]
    {"serve": lambda: serve(), "up": lambda: up(a), "down": lambda: down(a),
     "ls": lambda: ls(), "rotate": lambda: rotate(a),
     "stop": lambda: stop(a), "start": lambda: start(a),
     "logs": lambda: print(container_logs(a[0])) if a else print("logs <KEY>"),
     "validate-code": lambda: _cli_validate_code(a),
     "onboard-code": lambda: _cli_onboard_code(a),
     "autorotate": lambda: set_autorotate(a[:-1], a[-1]) if len(a) > 1 else print("autorotate <KEY..> <minutes>"),
     }.get(cmd, lambda: print(__doc__))()
