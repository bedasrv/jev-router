#!/usr/bin/env python3
"""Register every policy.json pool id as a custom model on its OmniRoute node, with the
supportsVision flag from policy.models (flag left unset when unknown).

Why: OmniRoute's vision bridge and combo capability filter treat a custom-node model with no
registered vision flag as "unknown = not vision", so an image request to `paid`/`free` is
hijacked (whole-request vision reroute) before the plugin runs. Registered ids are confirmed.
Dry run by default; --apply writes. Login uses INITIAL_PASSWORD from the compose .env.
Usage: register-models.py [--apply] [--url http://127.0.0.1:20128] [--env ~/Containers/omniroute/.env] [--policy ../policy.json]
"""
import argparse, json, os, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
ap.add_argument("--url", default="http://127.0.0.1:20128")
ap.add_argument("--env", default=os.path.expanduser("~/Containers/omniroute/.env"))
ap.add_argument("--policy", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "policy.json"))
a = ap.parse_args()

def call(method, path, body=None, cookie=None):
    h = {"Content-Type": "application/json"}
    if cookie: h["Cookie"] = cookie
    r = urllib.request.Request(a.url + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    resp = urllib.request.urlopen(r, timeout=30)
    return resp, json.load(resp)

pw = next(l.split("=", 1)[1].strip().strip("\"'") for l in open(a.env) if l.startswith("INITIAL_PASSWORD="))
resp, _ = call("POST", "/api/auth/login", {"password": pw})
cookie = "; ".join(v.split(";")[0] for k, v in resp.getheaders() if k.lower() == "set-cookie")
_, nodes = call("GET", "/api/provider-nodes", cookie=cookie)
node_by_prefix = {n["prefix"]: n["id"] for n in nodes.get("nodes", nodes)}
pol = json.load(open(a.policy))
ids = list(dict.fromkeys(pol["order"]["paid"] + pol["order"]["free"]))
for full in ids:
    prefix, _, model = full.partition("/")
    if prefix not in node_by_prefix:
        print("skip (no node)", full); continue
    v = pol.get("models", {}).get(full, {}).get("vision")
    body = {"provider": node_by_prefix[prefix], "modelId": model, "modelName": model}
    if isinstance(v, bool): body["supportsVision"] = v
    print(("POST" if a.apply else "would POST"), prefix, model, "vision=%s" % v)
    if a.apply: call("POST", "/api/provider-models", body, cookie)
print("done" if a.apply else "dry run only; re-run with --apply")
