#!/usr/bin/env python3
"""Preflight for the TestFlight workflow (.github/workflows/testflight.yml), run on a cheap Linux runner before any macOS minute.

It asks the App Store Connect API, with the same key the macOS job signs with, what Xcode cannot fix by itself:
  1. the key works (401 = wrong key ID / issuer / file, 403 = role too low or an agreement is not accepted yet),
  2. the app record for the bundle ID exists (the API cannot create it: that is a step on the website),
  3. at least one iPhone is registered (Xcode's automatic signing needs one for the development profile it archives with),
  4. which build number comes next (one above the highest CFBundleVersion App Store Connect has for this app).
It prints the bundle IDs already registered (Xcode registers the missing ones itself) and writes app_id and build_number to
$GITHUB_OUTPUT. Nothing is created or changed. Only dependency: `cryptography` (ES256 for the token).

Usage: asc_preflight.py --key-file AuthKey_X.p8 --key-id X --issuer-id UUID --bundle-id com.teydralab.autark
                        [--build-number N] [--allow-no-device] [--github-output FILE]
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_token(key_pem: bytes, key_id: str, issuer_id: str, now: int | None = None) -> str:
    """App Store Connect JWT: ES256, kid = key ID, iss = issuer ID, aud appstoreconnect-v1, at most 20 minutes."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    now = int(time.time()) if now is None else now
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    payload = {"iss": issuer_id, "iat": now, "exp": now + 15 * 60, "aud": "appstoreconnect-v1"}
    signing_input = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + \
        b64url(json.dumps(payload, separators=(",", ":")).encode())
    key = serialization.load_pem_private_key(key_pem, password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise SystemExit("::error::ASC_KEY_P8_BASE64 is not an App Store Connect key (expected a P-256 EC private key, .p8)")
    der = key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return signing_input + "." + b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


class ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body


def http_get(token: str, path: str, params: dict[str, str]) -> dict:
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise ApiError(error.code, error.read().decode("utf-8", "replace")) from None


def explain(error: ApiError) -> str:
    try:
        details = "; ".join(f"{e.get('code')}: {e.get('detail') or e.get('title')}" for e in json.loads(error.body).get("errors", []))
    except ValueError:
        details = error.body[:300]
    hint = {
        401: "the key is not accepted – check ASC_KEY_ID, ASC_ISSUER_ID and that ASC_KEY_P8_BASE64 is the base64 of that key's .p8 file",
        403: "the key may not do this – it needs the Admin role (cloud signing), and every agreement in App Store Connect "
             "(Business) must be accepted by the Account Holder",
    }.get(error.status, "App Store Connect answered with an error")
    return f"{hint} ({error}; {details})"


def preflight(get, bundle_id: str, build_number: str, allow_no_device: bool) -> tuple[dict[str, str], list[str], list[str]]:
    """Returns (outputs, errors, notes). `get(path, params)` is the API call (a fake in the tests)."""
    errors: list[str] = []
    notes: list[str] = []
    outputs: dict[str, str] = {}
    try:
        apps = get("/v1/apps", {"filter[bundleId]": bundle_id, "fields[apps]": "name,bundleId,sku"}).get("data", [])
    except ApiError as error:
        return outputs, [explain(error)], notes
    app = next((a for a in apps if a.get("attributes", {}).get("bundleId") == bundle_id), None)
    if app is None:
        errors.append(f"no app record for {bundle_id} in App Store Connect – create it on the website first "
                      "(Apps > + > New App; apps/ios/SIGNING.md step 5). The API cannot create apps.")
    else:
        outputs["app_id"] = app["id"]
        notes.append(f"app record: {app['attributes'].get('name')} (Apple ID {app['id']}, SKU {app['attributes'].get('sku')})")

    try:
        devices = get("/v1/devices", {"filter[platform]": "IOS", "filter[status]": "ENABLED", "limit": "200",
                                      "fields[devices]": "deviceClass"}).get("data", [])
        phones = devices  # any enabled iOS-platform device lets Xcode make the development profile
        if phones:
            notes.append(f"registered devices: {len(phones)}")
        elif allow_no_device:
            notes.append("no registered iPhone – going on because allow_no_device is set (the archive may fail with "
                         "'Your team has no devices from which to generate a provisioning profile')")
        else:
            errors.append("no iPhone is registered in the developer account. Xcode's automatic signing archives with a development "
                          "profile and cannot make one without a device. Register the agreed test iPhone (UDID) under Certificates, "
                          "Identifiers & Profiles > Devices (SIGNING.md step 4), or start the workflow with allow_no_device.")
    except ApiError as error:
        errors.append(explain(error))

    try:
        ids = get("/v1/bundleIds", {"filter[identifier]": bundle_id, "limit": "200", "fields[bundleIds]": "identifier"}).get("data", [])
        known = sorted(b["attributes"]["identifier"] for b in ids if b.get("attributes", {}).get("identifier", "").startswith(bundle_id))
        notes.append("bundle IDs registered: " + (", ".join(known) if known else "none yet (Xcode registers them while archiving)"))
    except ApiError as error:
        notes.append("bundle IDs could not be listed: " + explain(error))

    if "app_id" in outputs:
        highest = 0
        try:
            builds = get("/v1/builds", {"filter[app]": outputs["app_id"], "sort": "-uploadedDate", "limit": "200",
                                        "fields[builds]": "version"}).get("data", [])
            for build in builds:
                version = str(build.get("attributes", {}).get("version", ""))
                if version.isdigit():
                    highest = max(highest, int(version))
        except ApiError as error:
            errors.append(explain(error))
        if build_number:
            if not build_number.isdigit() or int(build_number) < 1:
                errors.append(f"build_number must be a positive whole number, not {build_number!r}")
            elif int(build_number) <= highest:
                errors.append(f"build_number {build_number} is not above the highest uploaded build ({highest}); "
                              "App Store Connect refuses a CFBundleVersion it already has – leave the input empty to use "
                              f"{highest + 1}")
            else:
                outputs["build_number"] = build_number
        else:
            outputs["build_number"] = str(highest + 1)
        notes.append(f"highest uploaded build: {highest or 'none'}; this run builds {outputs.get('build_number', '?')}")
    return outputs, errors, notes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--issuer-id", required=True)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--build-number", default="")
    parser.add_argument("--allow-no-device", action="store_true")
    parser.add_argument("--github-output", default="")
    args = parser.parse_args(argv)

    with open(args.key_file, "rb") as handle:
        token = make_token(handle.read(), args.key_id, args.issuer_id)
    outputs, errors, notes = preflight(lambda path, params: http_get(token, path, params),
                                       args.bundle_id, args.build_number.strip(), args.allow_no_device)
    for note in notes:
        print(note)
    for error in errors:
        print("::error::" + error)
    if args.github_output and not errors:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            for name, value in outputs.items():
                handle.write(f"{name}={value}\n")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
