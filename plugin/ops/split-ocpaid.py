#!/usr/bin/env python3
"""Split the single `ocpaid` OmniRoute node (one connection = one failure domain) into several nodes
that point at the same sidecar, so a 402/limit/410 on one cannot cool the others.

  ocgoa, ocgob : the paid Go ids, alternating by their rank in policy.order.paid (adjacent candidates
                 sit on different connections, so a hop always crosses connections)
  ocpv         : the unlimited free previews served by the Go sidecar (`*-free` ids)

For every new prefix: create the node, create + test the connection (key from the sidecar env file),
register each id as a custom model with its vision flag (OmniRoute treats unregistered custom ids as
non-vision), then rewrite the stored `free`/`paid` combos with vision-capable members. The old `ocpaid`
node is left untouched (rollback). `--rewrite-policy OUT` only writes a new policy.json locally.
Dry run by default; --apply writes to OmniRoute.
"""
import argparse, json, os, re, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
ap.add_argument("--url", default="http://127.0.0.1:20128")
ap.add_argument("--env", default=os.path.expanduser("~/Containers/omniroute/.env"), help="compose .env with INITIAL_PASSWORD")
ap.add_argument("--password", help="override the dashboard password (throwaway instances only)")
ap.add_argument("--sidecar-env", default=os.path.expanduser("~/.config/opencode/oc-paid-proxy.env"))
ap.add_argument("--key-var", default="PROXY_API_KEY")
ap.add_argument("--base-url", default="http://127.0.0.1:4097/v1")
ap.add_argument("--policy", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "policy.json"))
ap.add_argument("--old-prefix", default="ocpaid")
ap.add_argument("--rewrite-policy", metavar="OUT", help="write the policy with split prefixes to OUT and exit (no OmniRoute access)")
ap.add_argument("--combo-paid", default="ocgoa/opencode-go/deepseek-v4.1-flash,ocfree/opencode/muse-spark-1.3-contributor-free,ocgob/opencode-go/qwen3.8-flash")
ap.add_argument("--combo-free", default="ocfree/opencode/muse-spark-1.3-contributor-free,ocpv/opencode-go/longcat-2.5-preview-free,ocfree/opencode/muse-spark-1.2-contributor-free")
a = ap.parse_args()

pol = json.load(open(a.policy))
OLD = a.old_prefix + "/"
paid_old = [i for i in pol["order"]["paid"] if i.startswith(OLD)]
is_preview = lambda i: i.endswith("-free")
main = [i for i in paid_old if not is_preview(i)]
mapping = {}
for n, i in enumerate(main): mapping[i] = ("ocgoa" if n % 2 == 0 else "ocgob") + "/" + i[len(OLD):]
for i in paid_old:
    if is_preview(i): mapping[i] = "ocpv/" + i[len(OLD):]
# free-pool and last_resort entries that point at the old prefix
for i in pol["order"]["free"]:
    if i.startswith(OLD): mapping.setdefault(i, ("ocpv/" if is_preview(i) else "ocgoa/") + i[len(OLD):])
sub = lambda i: mapping.get(i, i)

if a.rewrite_policy:
    new = json.loads(json.dumps(pol))
    new["order"] = {k: [sub(i) for i in v] for k, v in pol["order"].items()}
    new["models"] = {sub(k): v for k, v in pol.get("models", {}).items()}
    new["denylist"] = [sub(i) for i in pol.get("denylist", [])]
    srcs = [s for s in pol.get("sources", []) if s["prefix"] != a.old_prefix]
    old_src = next((s for s in pol.get("sources", []) if s["prefix"] == a.old_prefix), None)
    if old_src:
        for p in ("ocgoa", "ocgob", "ocpv"): srcs.append({**old_src, "prefix": p})
    new["sources"] = srcs
    json.dump(new, open(a.rewrite_policy, "w"), indent=1)
    print("wrote", a.rewrite_policy, "(%d ids remapped)" % len(mapping)); raise SystemExit

prefixes = sorted({v.split("/")[0] for v in mapping.values()})
print("mapping:"); [print("  ", k, "->", v) for k, v in mapping.items()]
print("new nodes:", prefixes)

def call(method, path, body=None, cookie=None):
    h = {"Content-Type": "application/json"}
    if cookie: h["Cookie"] = cookie
    r = urllib.request.Request(a.url + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    resp = urllib.request.urlopen(r, timeout=60)
    return resp, json.load(resp)

if not a.apply:
    print("dry run only; re-run with --apply"); raise SystemExit
pw = a.password or next(l.split("=", 1)[1].strip().strip("\"'") for l in open(a.env) if l.startswith("INITIAL_PASSWORD="))
resp, _ = call("POST", "/api/auth/login", {"password": pw})
cookie = "; ".join(v.split(";")[0] for k, v in resp.getheaders() if k.lower() == "set-cookie")
key = next(re.match(r"\s*%s=(.*)" % a.key_var, l).group(1).strip().strip("\"'") for l in open(a.sidecar_env) if re.match(r"\s*%s=" % a.key_var, l))

_, d = call("GET", "/api/provider-nodes", cookie=cookie)
nodes = {n["prefix"]: n["id"] for n in d.get("nodes", d)}
for p in prefixes:
    if p in nodes: print("node exists", p); continue
    _, n = call("POST", "/api/provider-nodes", {"type": "openai-compatible", "name": p, "prefix": p, "baseUrl": a.base_url, "apiType": "chat"}, cookie)
    nodes[p] = (n.get("node") or n)["id"]; print("created node", p)
_, d = call("GET", "/api/providers", cookie=cookie)
conns = {c["provider"] for c in d.get("connections", d)}
for p in prefixes:
    if nodes[p] in conns: print("connection exists", p); continue
    _, c = call("POST", "/api/providers", {"provider": nodes[p], "name": p, "apiKey": key}, cookie)
    cid = (c.get("connection") or c)["id"]
    try: call("POST", f"/api/providers/{cid}/test", {}, cookie); print("created + tested connection", p)
    except Exception as e: print("created connection", p, "but test failed:", e)
for old, new in mapping.items():
    p, _, model = new.partition("/")
    v = pol.get("models", {}).get(old, {}).get("vision")
    body = {"provider": nodes[p], "modelId": model, "modelName": model}
    if isinstance(v, bool): body["supportsVision"] = v
    call("POST", "/api/provider-models", body, cookie)
print("registered", len(mapping), "models")
_, d = call("GET", "/api/combos", cookie=cookie)
combos = {c["name"]: c for c in d.get("combos", d)}
for name, items in (("paid", a.combo_paid), ("free", a.combo_free)):
    if name not in combos: print("combo", name, "not found, skipped"); continue
    ids = items.split(",")
    models = [{"id": f"{name}-model-{n+1}-" + m.replace("/", "-").replace(".", "-"), "kind": "model", "model": m, "providerId": m.split("/")[0], "weight": 0} for n, m in enumerate(ids)]
    call("PUT", f"/api/combos/{combos[name]['id']}", {"models": models, "isActive": True}, cookie)
    print("combo", name, "->", ids)
print("done")
