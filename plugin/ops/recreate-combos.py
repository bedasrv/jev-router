#!/usr/bin/env python3
"""Rewrite the stored `free` and `paid` combos (the fail-open / degraded mode) with members that
are registered as vision-capable (see register-models.py) and activate them. A stored combo whose
members are not all vision-proven makes OmniRoute's vision bridge describe or hijack images.
Order alternates connections where the pool allows it (paid: ocpaid, ocfree, ocpaid). Dry run by
default; --apply writes. Login uses INITIAL_PASSWORD from the compose .env."""
import argparse, json, os, urllib.request

PLAN = {
    "paid": ["ocpaid/opencode-go/deepseek-v4.1-flash", "ocfree/opencode/muse-spark-1.3-contributor-free", "ocpaid/opencode-go/kimi-k3"],
    "free": ["ocfree/opencode/muse-spark-1.3-contributor-free", "ocfree/opencode/ling-3.1-flash-free", "ocfree/opencode/muse-spark-1.2-contributor-free"],
}
ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
ap.add_argument("--url", default="http://127.0.0.1:20128")
ap.add_argument("--env", default=os.path.expanduser("~/Containers/omniroute/.env"))
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
_, d = call("GET", "/api/combos", cookie=cookie)
combos = {c["name"]: c for c in d.get("combos", d)}
for name, items in PLAN.items():
    c = combos[name]
    models = [{"id": f"{name}-model-{i+1}-" + m.replace("/", "-").replace(".", "-"), "kind": "model", "model": m, "providerId": m.split("/")[0], "weight": 0} for i, m in enumerate(items)]
    print(("PUT" if a.apply else "would PUT"), name, c["id"], "active:", c.get("isActive"), "->", True)
    print("   was:", [m["model"] for m in c["models"]])
    print("   new:", items)
    if a.apply: call("PUT", f"/api/combos/{c['id']}", {"models": models, "isActive": True}, cookie)
print("done" if a.apply else "dry run only; re-run with --apply")
