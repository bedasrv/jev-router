#!/usr/bin/env python3
"""Raise OmniRoute's global request queue. The default (60/min, 350 ms between requests, 6 concurrent)
serialises traffic: six parallel requests finish 0.35 s apart and sustained load is capped at 1 req/s.
Prints the current values and the new ones; --apply PATCHes /api/resilience {requestQueue}.
Rollback: run again with --rpm 60 --min-gap-ms 350 --concurrent 6 --max-wait-ms 30000."""
import argparse, json, os, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
ap.add_argument("--url", default="http://127.0.0.1:20128")
ap.add_argument("--env", default=os.path.expanduser("~/Containers/omniroute/.env"))
ap.add_argument("--password")
ap.add_argument("--rpm", type=int, default=600)
ap.add_argument("--min-gap-ms", type=int, default=0)
ap.add_argument("--concurrent", type=int, default=16)
ap.add_argument("--max-wait-ms", type=int, default=60000)
a = ap.parse_args()

def call(method, path, body=None, cookie=None):
    h = {"Content-Type": "application/json"}
    if cookie: h["Cookie"] = cookie
    r = urllib.request.Request(a.url + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    resp = urllib.request.urlopen(r, timeout=30)
    return resp, json.load(resp)

pw = a.password or next(l.split("=", 1)[1].strip().strip("\"'") for l in open(a.env) if l.startswith("INITIAL_PASSWORD="))
resp, _ = call("POST", "/api/auth/login", {"password": pw})
cookie = "; ".join(v.split(";")[0] for k, v in resp.getheaders() if k.lower() == "set-cookie")
_, cur = call("GET", "/api/resilience", cookie=cookie)
rq = cur.get("requestQueue") or cur.get("settings", {}).get("requestQueue")
print("current requestQueue:", json.dumps(rq))
new = {"requestsPerMinute": a.rpm, "minTimeBetweenRequestsMs": a.min_gap_ms, "concurrentRequests": a.concurrent, "maxWaitMs": a.max_wait_ms}
print("new requestQueue:    ", json.dumps(new))
if a.apply:
    _, out = call("PATCH", "/api/resilience", {"requestQueue": new}, cookie)
    _, after = call("GET", "/api/resilience", cookie=cookie)
    print("applied; now:", json.dumps(after.get("requestQueue") or after.get("settings", {}).get("requestQueue")))
else:
    print("dry run only; re-run with --apply")
