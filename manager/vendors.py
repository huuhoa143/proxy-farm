"""
Built-in VPN providers. Each one is a *pool*: the user adds one or more accounts, the farm
already knows the provider's servers, and every location is listed once. Which account a
port runs on is decided when it starts (see farm.py: pick_account), so adding an account
adds capacity rather than a second copy of every location.

A vendor declares:
  setup     what the user must fetch and where: `needs` (one line, shown on the chooser),
            numbered `steps`, and an optional `link` to the provider's own page
  fields    the form the UI draws for a new account (HMA has its own: a certificate drop)
  check     validate what the user typed -> (stored fields, short label shown in the UI)
  targets   the provider's locations, independent of any account
  bind      what one port needs from the account it was given: env, a generated config,
            a secrets folder

  hma        IKEv2 with the device certificate the HMA app holds (imported in farm.py).
  surfshark  WireGuard. A private key is registered to the account, not to a server, and
             Surfshark publishes each server's public key: the farm writes the config for
             a location when its port starts. Server list: their public API.
  zoogvpn    IKEv2 with the account e-mail/password (EAP). Server list: catalogs/zoogvpn.json,
             rebuilt with tools/zoogvpn-catalog.py since ZoogVPN does not publish one.
"""
import base64, json, os, re, threading, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGS = os.path.join(HERE, "catalogs")

def _load(path):
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except (OSError, ValueError): return {}

COUNTRY_NAMES = _load(os.path.join(CATALOGS, "countries.json"))

# ---- HMA ------------------------------------------------------------------------
# Location keys stay exactly as they were before accounts existed (e.g. DE-16-BERLIN), so
# ports created by older versions keep their numbers.
HMA_LOCATIONS = _load(os.path.join(HERE, "locations.json")).get("locations", [])

def hma_targets(data_dir):
    return [{**l, "vendor": "hma", "provider": "hma", "protocol": "ikev2-cert",
             "label": l["countryName"] + " " + l["city"]} for l in HMA_LOCATIONS]

def hma_bind(t, acct):
    return {"secrets": acct["id"]}           # its own certificate folder under SECRETS

# ---- Surfshark ------------------------------------------------------------------
SURFSHARK_API = "https://api.surfshark.com/v4/server/clusters/all"
SURFSHARK_TTL = 12 * 3600          # servers come and go; keys rarely change
# Every Surfshark account gets the same inner address; the server tells peers apart by key.
SURFSHARK_ADDR = "10.14.0.2/16"
_ss_lock = threading.Lock()

def _ss_cache(data_dir): return os.path.join(data_dir, "surfshark-clusters.json")

def surfshark_clusters(data_dir, refresh=False):
    """Their server list, cached. Falls back to the last good copy when the API is down,
    and refreshes in the background so a poll of the UI never waits on the network."""
    path = _ss_cache(data_dir)
    cached = _load(path) or None
    stale = not cached or time.time() - cached.get("fetched", 0) > SURFSHARK_TTL
    if refresh or not cached:
        _ss_fetch(path)
        cached = _load(path) or cached
    elif stale and _ss_lock.acquire(blocking=False):
        def bg():
            try: _ss_fetch(path)
            finally: _ss_lock.release()
        threading.Thread(target=bg, daemon=True).start()
    return (cached or {}).get("clusters", [])

def _ss_fetch(path):
    try:
        req = urllib.request.Request(SURFSHARK_API, headers={"User-Agent": "proxy-farm"})
        with urllib.request.urlopen(req, timeout=20) as f: data = json.load(f)
        keep = [c for c in data if c.get("pubKey") and c.get("type") in ("generic", "static")]
        if not keep: return
        tmp = path + ".tmp"
        with open(tmp, "w") as f: json.dump({"fetched": int(time.time()), "clusters": keep}, f)
        os.replace(tmp, path)
    except Exception as e:
        print(f"surfshark: không tải được danh sách máy chủ: {e}", flush=True)

def surfshark_check(d):
    key = (d.get("private_key") or "").strip()
    try: raw = base64.b64decode(key, validate=True)
    except Exception: raw = b""
    if len(raw) != 32:
        raise ValueError("Private key không đúng: cần chuỗi base64 44 ký tự (kết thúc bằng =), "
                         "lấy ở my.surfshark.com → Manual setup → WireGuard")
    return {"private_key": key}, "key …" + key[-4:]

def surfshark_targets(data_dir):
    out = []
    for c in surfshark_clusters(data_dir):
        host = c["connectionName"]
        static = c.get("type") == "static"
        virtual = "virtual" in (c.get("tags") or [])
        key = f"SS-{host.split('.')[0].upper()}"
        out.append({
            "key": key, "vendor": "surfshark", "provider": "surfshark",
            "protocol": "wireguard", "config": f".gen/{key}.conf",
            "country": c["countryCode"],
            "countryName": c.get("country") or COUNTRY_NAMES.get(c["countryCode"], c["countryCode"]),
            "city": c.get("location", "") + (" · IP tĩnh" if static else ""),
            "tags": (["static"] if static else []) + (["virtual"] if virtual else []),
            "label": host, "wg_host": host, "wg_pubkey": c["pubKey"],
        })
    return out

def surfshark_bind(t, acct):
    return {"config_text":
            f"[Interface]\nPrivateKey = {acct['private_key']}\nAddress = {SURFSHARK_ADDR}\n\n"
            f"[Peer]\nPublicKey = {t['wg_pubkey']}\nAllowedIPs = 0.0.0.0/0\n"
            f"Endpoint = {t['wg_host']}:51820\n"}

# ---- ZoogVPN --------------------------------------------------------------------
def zoogvpn_check(d):
    user, pw = (d.get("user") or "").strip(), d.get("pass") or ""
    if "@" not in user or not pw:
        raise ValueError("Cần email và mật khẩu tài khoản ZoogVPN")
    return {"user": user, "pass": pw}, user

def zoogvpn_targets(data_dir):
    out = []
    for s in _load(os.path.join(CATALOGS, "zoogvpn.json")).get("servers", []):
        cc = s["country"]
        out.append({
            "key": f"ZG-{s['host'].split('.')[0].upper()}", "vendor": "zoogvpn",
            "provider": "zoogvpn", "protocol": "ikev2-eap",
            "fqdn": s["host"], "server_ip": s["ip"],
            "country": cc, "countryName": COUNTRY_NAMES.get(cc, cc),
            # Virtual locations have no real city; number them like the provider does.
            "city": s.get("city") or "Máy chủ " + (re.sub(r"\D", "", s["host"].split(".")[0]) or "1"),
            "tags": ["virtual"] if s.get("virtual") else [],
            "label": s["host"],
        })
    return out

def zoogvpn_bind(t, acct):
    return {"env": {"EAP_USER": acct["user"], "EAP_PASS": acct["pass"]}}

# ---- registry -------------------------------------------------------------------
VENDORS = {
    "surfshark": {
        "name": "Surfshark", "protocol": "wireguard",
        "blurb": "Một private key WireGuard dùng được cho mọi máy chủ, không giới hạn thiết bị. "
                 "Thêm nhiều key/tài khoản thì farm chia cổng đều cho chúng.",
        "setup": {
            "needs": "1 private key WireGuard",
            "link": "https://my.surfshark.com/vpn/manual-setup/router",
            "note": "Mỗi tài khoản Surfshark tạo được nhiều cặp khoá. Một khoá đã đủ cho "
                    "mọi vị trí — chỉ cần thêm khoá/tài khoản nếu bạn muốn tách luồng.",
            "steps": ["Đăng nhập **my.surfshark.com**.",
                      "Vào **VPN → Manual setup → Desktop or mobile**, chọn **WireGuard**.",
                      "Bấm **I don't have a key pair** rồi **Generate new key pair**.",
                      "Chép dòng **Private key** (44 ký tự, kết thúc bằng `=`) và dán xuống dưới."],
        },
        "fields": [{"id": "private_key", "label": "Private key WireGuard", "type": "password",
                    "mono": True, "placeholder": "44 ký tự, kết thúc bằng ="}],
        "check": surfshark_check, "targets": surfshark_targets, "bind": surfshark_bind,
    },
    "zoogvpn": {
        "name": "ZoogVPN", "protocol": "ikev2-eap",
        "blurb": "Đăng nhập IKEv2 bằng đúng email và mật khẩu của app ZoogVPN.",
        "setup": {
            "needs": "email + mật khẩu tài khoản",
            "link": "https://zoogvpn.com/members/clientarea/",
            "note": "Không giới hạn số kết nối (đã chạy 6 cổng trên một tài khoản). Gói rẻ có thể "
                    "chỉ cho dùng một phần máy chủ: máy chủ nào bị từ chối, farm tự ghi nhận và "
                    "đánh dấu *gói không hỗ trợ*.",
            "steps": ["Dùng đúng **email và mật khẩu** bạn đăng nhập app ZoogVPN.",
                      "Không cần cài app, không cần tải file cấu hình.",
                      "Farm tự biết 165 máy chủ của ZoogVPN."],
        },
        "fields": [{"id": "user", "label": "Email", "type": "text", "placeholder": "ban@email.com"},
                   {"id": "pass", "label": "Mật khẩu", "type": "password"}],
        "check": zoogvpn_check, "targets": zoogvpn_targets, "bind": zoogvpn_bind,
    },
    "hma": {
        "name": "HMA / SurfEasy", "protocol": "ikev2-cert",
        "blurb": "Chứng chỉ thiết bị lấy từ app HMA. Mỗi chứng chỉ là một tài khoản.",
        "setup": {
            "needs": "chứng chỉ từ app HMA trên máy này",
            "note": "HMA không cho tải file cấu hình, nhưng app đã giữ sẵn chứng chỉ thiết bị. "
                    "Mỗi máy/tài khoản HMA cho một chứng chỉ khác nhau.",
            "steps": ["Cài **app HMA VPN** trên chính máy này và đăng nhập ít nhất một lần.",
                      "Chạy lại `./run.sh` — chứng chỉ được nạp tự động.",
                      "Hoặc kéo thả **tokenCoreSE.json** vào ô bên dưới."],
        },
        "fields": None,                       # imported from the app, see farm.import_hma
        "targets": hma_targets, "bind": hma_bind,
    },
}

def public():
    """What the UI needs to draw each provider's form."""
    return [{"id": k, "name": v["name"], "protocol": v["protocol"], "blurb": v["blurb"],
             "setup": v.get("setup", {}), "fields": v["fields"]} for k, v in VENDORS.items()]
