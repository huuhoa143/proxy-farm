"""HMA activation-code onboarding — the off-device half.

Goal: let a user turn an HMA subscription into proxy ports by typing an *activation
code* (the wallet key printed on the card / in the order mail), without installing
the HMA desktop app and on any platform.

What this module does entirely off-device, stdlib-only:
  * validate_code(code)  — ask Avast's licensing backend whether the code is a real,
    active HMA subscription, and read back the plan, expiry and device-slot usage.

What it deliberately does NOT do: mint the device certificate (the PKCS#12 the IKEv2
tunnels authenticate with) from the code alone. HMA issues that cert through Avast's
proprietary "connect token" (CCT) flow — a protobuf message bus to *.ff.avast.com
plus an AWS-SigV4-signed POST to api.se-platform.com/passage/v6/devices. Neither has
a public schema and the desktop app caches the result in three places (system
keychain, login keychain, token files) so it cannot be re-triggered for capture
without a destructive full app reset. That wall is documented in README + memory.

So onboarding is two steps:
  1. validate_code(code)                     — off-device, here.  Proves ownership.
  2. provide the device cert bundle once      — bootstrap_cert.sh on a machine that
     has the app, OR paste a tokenCoreSE.json / .p12.  The farm then runs it on any
     platform forever (the cert is valid until the subscription expires).

The code is stored alongside the cert so the account is identified by the thing the
user actually typed, and so the farm can re-validate expiry/slots at any time.
"""

import json
import gzip
import os
import ssl
import uuid
import urllib.request
import urllib.error

# These identify the HMA *app build* (same for every macOS install of this version),
# NOT the user — safe to ship. The only per-user secret is the activation code itself.
# The device-id is intentionally a random UUID (the licence query accepts any value and
# we must not ship a real machine's hardware id); override with PF_HMA_DEVICE_ID if you
# want it stable across runs.
VAAR_HOST = "https://my-mac.ff.avast.com/v1/query/get-exact-application-licenses"
DEVICE_ID = os.environ.get("PF_HMA_DEVICE_ID") or str(uuid.uuid4()).upper()
DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "vaar-version": "0",
    "vaar-header-device-id": DEVICE_ID,
    "vaar-header-device-platform": "OSX",
    "vaar-header-app-build-version": "26.8.0-4a965be03a72",
    "vaar-header-app-id": "F7E7C838-3F3E-4C9E-AA17-B1AE76901C36",
    "vaar-header-app-ipm-product": "249",
    "vaar-header-app-product-brand": "PRIVAX",
    "vaar-header-app-product-mode": "PAID",
    "vaar-header-app-package-name": "com.privax.osx.provpn",
}

# HMA activation codes are three groups of six, e.g. XXXXXX-XXXXXX-XXXXXX.
# Normalise loosely: strip spaces, upper-case.
def normalize_code(code):
    return (code or "").strip().upper().replace(" ", "")


class ActivationError(Exception):
    pass


def _post(code, timeout=20):
    body = json.dumps({"walletKeys": [code]}).encode()
    req = urllib.request.Request(VAAR_HOST, data=body, method="POST",
                                 headers=DEFAULT_HEADERS)
    ctx = ssl.create_default_context()
    try:
        r = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise ActivationError(f"Máy chủ cấp phép trả lỗi {e.code}")
    except urllib.error.URLError as e:
        raise ActivationError(f"Không kết nối được máy chủ cấp phép: {e.reason}")
    except Exception as e:
        raise ActivationError(f"Phản hồi cấp phép không đọc được: {e}")


def validate_code(code):
    """Return a dict describing the subscription behind an activation code, or raise
    ActivationError if the code is unknown / not an HMA licence.

    Keys: valid, code, license_id, product, schema, mode, expires (unix ms),
          expires_date (YYYY-MM-DD), devices_used, devices_max, is_hma, raw.
    """
    code = normalize_code(code)
    if not code:
        raise ActivationError("Thiếu activation code")
    data = _post(code)
    lic = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
    if not lic or not lic.get("id"):
        raise ActivationError("Activation code không hợp lệ hoặc không có license")

    product = lic.get("product", {}) or {}
    families = product.get("familyCodes", []) or []
    is_hma = ("HideMyAss" in families) or str(product.get("id", "")).startswith("hma")
    dev = next((x for x in lic.get("resources", []) if x.get("name") == "devices"), {}) or {}
    expires_ms = lic.get("expires")
    expires_date = None
    if expires_ms:
        import datetime
        expires_date = datetime.datetime.fromtimestamp(expires_ms / 1000,
                                                       datetime.timezone.utc).strftime("%Y-%m-%d")
    return {
        "valid": True,
        "code": code,
        "license_id": lic.get("id"),
        "subscription_id": lic.get("subscriptionId"),
        "product": product.get("name"),
        "schema": lic.get("schemaId"),
        "mode": lic.get("mode"),
        "expires": expires_ms,
        "expires_date": expires_date,
        "devices_used": int(dev.get("currentValue", 0) or 0),
        "devices_max": int(dev.get("originalValue", 0) or 0),
        "is_hma": is_hma,
        "raw": lic,
    }


def summary_line(v):
    """One-line human summary of a validate_code() result."""
    return (f"{v.get('product') or 'HMA'} · hết hạn {v.get('expires_date') or '?'} · "
            f"thiết bị {v.get('devices_used')}/{v.get('devices_max')} · "
            f"license {str(v.get('license_id'))[:12]}…")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: hma_activation.py <ACTIVATION-CODE>")
        sys.exit(1)
    try:
        v = validate_code(sys.argv[1])
    except ActivationError as e:
        print("✗", e)
        sys.exit(2)
    print("✓ hợp lệ" + ("" if v["is_hma"] else "  (CẢNH BÁO: không phải license HMA)"))
    print(" ", summary_line(v))
    print(json.dumps({k: v[k] for k in ("code", "license_id", "product", "schema",
          "mode", "expires_date", "devices_used", "devices_max", "is_hma")},
          ensure_ascii=False, indent=2))
