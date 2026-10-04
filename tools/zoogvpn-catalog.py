#!/usr/bin/env python3
"""
Rebuild manager/catalogs/zoogvpn.json — the ZoogVPN server list the farm ships.

ZoogVPN has no public server list: the app gets it from an API that signs its requests.
Their IKEv2 gateways do follow a naming scheme though — <cc><n> plus, in the US only,
<cc><n>-<region> (us1-east, us3-central…) — on zoogvpn.com and webunlim.com. We enumerate
those names in DNS, group them by IP, and ask each
IP which name its certificate is really for (an IKE_AUTH with a throwaway identity is
enough: the gateway sends its certificate before it looks at the login). That name is the
identity the farm later checks, so it must come from the certificate, not from DNS.

  python3 tools/zoogvpn-catalog.py            # needs Docker; ~10 minutes

No account is used. Re-run when ZoogVPN adds or moves servers.
"""
import json, os, re, socket, subprocess, sys, tempfile, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "manager", "catalogs", "zoogvpn.json")
DOMAINS = ("zoogvpn.com", "webunlim.com")
CCS = ("us ca uk gb de nl fr be ch at it es pt ie se no dk fi pl cz hu ro bg gr tr ru ua il ae "
       "in sg jp kr hk tw au nz br ar mx cl co za eg vn th my id ph lu lt lv ee is rs hr si sk md "
       "ge am kz pk bd ng ke ma cy mt al ba mk me by az pe ve cr pa sa qa bh ec uy py bo gt hn sv "
       "ni do pr jm tt bs cn mo kh la mm np lk mn uz kg tj tm af iq ir jo lb kw om ye sy tn dz ly "
       "sd et gh ci sn cm ao mz zw zm tz ug rw mg mu sc").split()
REGIONS = ("east", "west", "central", "north", "south")

def resolve(name):
    try: return name, sorted({a[4][0] for a in socket.getaddrinfo(name, None, socket.AF_INET)})
    except OSError: return name, []

PROBE = r'''
apk add -q --no-cache strongswan >/dev/null
mkdir -p /etc/swanctl/conf.d
echo 'charon { port = 0
 port_nat_t = 0
 plugins { revocation { enable_ocsp = no
 enable_crl = no } } }' > /etc/strongswan.d/zz.conf
/usr/lib/strongswan/charon >/tmp/c.log 2>&1 &
sleep 3
for ip in $IPS; do
  cat > /etc/swanctl/conf.d/p.conf <<E
connections { p { version = 2
 remote_addrs = $ip
 local { auth = eap-mschapv2
  eap_id = probe@example.invalid }
 remote { auth = pubkey
  id = %any }
 children { p { remote_ts = 0.0.0.0/0 } } } }
secrets { eap-p { id = probe@example.invalid
 secret = x } }
E
  swanctl --load-all >/dev/null 2>&1
  : > /tmp/c.log
  timeout 20 swanctl --initiate --child p --timeout 15 >/dev/null 2>&1
  cn=$(sed -n 's/.*received end entity cert "CN=\([^"]*\)".*/\1/p' /tmp/c.log | head -1)
  echo "$ip ${cn:--}"
  swanctl --terminate --ike p --force >/dev/null 2>&1
done
'''

def probe(ips):
    r = subprocess.run(["docker", "run", "--rm", "--cap-add", "NET_ADMIN", "-e", "IPS=" + " ".join(ips),
                        "alpine:3.22", "sh", "-c", PROBE], capture_output=True, text=True, timeout=1800)
    out = {}
    for line in r.stdout.splitlines():
        ip, _, cn = line.partition(" ")
        if cn and cn != "-": out[ip] = cn
    return out

def geo(ip):
    try:
        with urllib.request.urlopen(f"https://ipinfo.io/{ip}/json", timeout=10) as f:
            d = json.load(f)
        return d.get("city") or "", d.get("country") or ""
    except Exception:
        return "", ""

def main():
    names = [f"{cc}{n}.{d}" for d in DOMAINS for cc in CCS for n in [""] + list(range(1, 13))]
    # The US pool is split by region instead of numbered straight through.
    names += [f"{cc}{n}-{r}.{d}" for d in DOMAINS for cc in CCS
              for n in range(1, 13) for r in REGIONS]
    print(f"DNS: {len(names)} tên…", file=sys.stderr)
    with ThreadPoolExecutor(64) as ex:
        found = {n: ips for n, ips in ex.map(resolve, names) if ips}
    by_ip = {}
    for n, ips in found.items():
        for ip in ips: by_ip.setdefault(ip, set()).add(n)
    ips = sorted(by_ip)
    print(f"{len(found)} tên trên {len(ips)} IP; đọc chứng chỉ từng IP…", file=sys.stderr)
    chunks = [ips[i::8] for i in range(8)]
    certs = {}
    with ThreadPoolExecutor(8) as ex:
        for part in ex.map(probe, chunks): certs.update(part)
    print(f"{len(certs)} IP trả về chứng chỉ; định vị…", file=sys.stderr)
    servers = []
    with ThreadPoolExecutor(8) as ex:
        geos = dict(zip(ips, ex.map(geo, ips)))
    for ip in ips:
        cn = certs.get(ip)
        if not cn: continue                      # no IKEv2 answer: not a gateway we can use
        city, gcc = geos[ip]
        cc = re.match(r"[a-z]+", cn).group(0).upper()
        region = re.search(r"\d+-([a-z]+)\.", cn)
        cc = {"UK": "GB"}.get(cc, cc)
        # The name says which country the server is sold as; geo-IP says where its entry
        # address sits. When they differ the location is virtual and the city is unknown.
        virtual = bool(gcc) and {"UK": "GB"}.get(gcc, gcc) != cc
        servers.append({"host": cn, "ip": ip, "country": cc,
                        "city": "" if virtual else (city or (region.group(1).title() if region else "")),
                        "virtual": virtual})
    # Merge with what we already shipped. DNS hands out a different slice of the pool on
    # every run, so a host missing from this scan usually just wasn't returned — dropping
    # it would rename the farm's ports (ZG-NL2 vanishing takes a running port with it).
    try:
        with open(OUT, encoding="utf-8") as f: old = json.load(f).get("servers", [])
    except (OSError, ValueError): old = []
    by_host = {s["host"]: s for s in old}
    added = 0
    for s in servers:
        if s["host"] not in by_host: added += 1
        by_host[s["host"]] = s                    # fresh scan wins for ip/city/virtual
    merged = sorted(by_host.values(), key=lambda s: (s["country"], s["host"]))
    json.dump({"updated": time.strftime("%Y-%m-%d"), "servers": merged},
              open(OUT, "w"), indent=1, ensure_ascii=False)
    print(f"đã ghi {len(merged)} máy chủ ({added} mới, {len(old)} giữ lại) "
          f"vào {os.path.relpath(OUT)}", file=sys.stderr)

if __name__ == "__main__":
    main()
