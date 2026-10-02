#!/usr/bin/env python3
"""Assemble the mockup: shell + fragments + Keelson chrome CSS. Usage: python3 build.py [fragment-name]
With a fragment name, builds a preview of just that fragment inside the shell (missing fragments become empty)."""
import re, sys, os
B = os.path.dirname(os.path.abspath(__file__)) + "/"
C = B + "../chrome/"
t = open(B + "shell.tpl.html").read()
css = open(C + "keelson-chrome.css").read()

def frag(m):
    p = B + "frag/" + m.group(1) + ".html"
    return open(p).read() if os.path.exists(p) else f"<!-- missing fragment {m.group(1)} -->"
for _ in range(3):  # fragments may include fragments (region-connection, region-firstrun)
    t = re.sub(r"@@FRAG:([a-z0-9-]+)@@", frag, t)

def spark(m):
    vals = [float(v) for v in m.group(1).split(",")]; tone = m.group(2).strip()
    W, H, P = 64, 18, 2; mn, mx = min(vals), max(vals); sp = mx - mn; step = (W - 2 * P) / (len(vals) - 1)
    sy = lambda v: H / 2 if sp == 0 else P + (1 - (v - mn) / sp) * (H - 2 * P)
    pts = " ".join(f"{P + i * step:.1f},{sy(v):.1f}" for i, v in enumerate(vals))
    ex = P + (len(vals) - 1) * step
    tone_attr = f' data-tone="{tone}"' if tone and tone != "none" else ""
    return f'<svg class="cvb-stat-spark"{tone_attr} width="{W}" height="{H}" viewBox="0 0 {W} {H}" aria-hidden="true"><polyline points="{pts}"/><circle cx="{ex:g}" cy="{sy(vals[-1]):g}" r="2"/></svg>'
t = re.sub(r"@@SPARK\(([^|]+)\|([^)]*)\)@@", spark, t)

chrome = '''<button type="button" class="surface-region-action surface-region-icon" aria-label="Explore in chat" title="Explore this in chat"><span aria-hidden="true">✦</span></button>
<input type="checkbox" class="surface-region-action surface-region-select" aria-label="Select panel for multi-panel explore" title="Select for multi-panel explore">
<button type="button" class="surface-region-action surface-region-icon" aria-label="Expand" title="Open full view"><span aria-hidden="true">⤢</span></button>'''
t = t.replace("@@CHROME@@", chrome)
t = t.replace("@@CSS@@", css)
left = sorted(set(re.findall(r"@@[A-Z:a-z0-9-]+(?:\([^)]*\))?@@", t)))
out = B + "adme-admin-mockup.body.html"
open(out, "w").write(t)
full = '<!doctype html>\n<html lang="en" data-theme="dark">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>ADME access desk</title>\n</head>\n<body>\n' + t + "\n</body>\n</html>\n"
open(B + "adme-admin-mockup.html", "w").write(full)

body = t.split("</style>")[-1] if "</style>" in t else t
html_classes = set(c for m in re.finditer(r'class="([^"]+)"', t) for c in m.group(1).split())
all_css = "\n".join(re.findall(r"<style>(.*?)</style>", t, re.S))
css_classes = set(re.findall(r"\.([a-zA-Z][\w-]*)", re.sub(r"\{[^}]*\}", "{}", all_css)))
print("bytes:", len(t.encode()), "(canvas_publish cap 524288)")
print("unresolved macros:", left)
print("HTML classes with no CSS rule:", sorted(c for c in html_classes if c not in css_classes))
for bad in ["—", "–"]:
    n = body.count(bad)
    if n: print(f"dash U+{ord(bad):04X} occurrences in body:", n)
print("em/en dashes in body text:", sum(body.count(b) for b in ["—", "–"]))
