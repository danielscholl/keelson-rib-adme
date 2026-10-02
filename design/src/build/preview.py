#!/usr/bin/env python3
"""Preview and check ONE fragment. Usage: python3 preview.py <fragment-name> [width] [height] [state]
Writes preview/<name>.html and preview/<name>.png (headless Chrome, dark theme) and prints checks.
state is connected (default), expired or firstrun: elements whose data-when lacks the state are hidden."""
import re, sys, os, subprocess, html.parser
B = os.path.dirname(os.path.abspath(__file__)) + "/"
name = sys.argv[1]; W = sys.argv[2] if len(sys.argv) > 2 else "1500"; H = sys.argv[3] if len(sys.argv) > 3 else "2200"
state = sys.argv[4] if len(sys.argv) > 4 else "connected"
shell = open(B + "shell.tpl.html").read()
styles = "".join(re.findall(r"<style>.*?</style>", shell, re.S))
f = open(B + "frag/" + name + ".html").read()
for _ in range(3):
    f = re.sub(r"@@FRAG:([a-z0-9-]+)@@", lambda m: open(B+"frag/"+m.group(1)+".html").read() if os.path.exists(B+"frag/"+m.group(1)+".html") else "", f)
tmp = B + "frag/.__preview_" + name + ".html"
is_doc = name.startswith("doc-"); is_overlay = name.startswith("drawer-") or name == "modals"
if is_doc: body = '<div class="doc doc--tail">' + f + "</div>"
elif is_overlay: body = '<div class="proto-window" style="height:%spx" data-state="%s" data-op="idle"><div class="proto-scroll"></div>%s</div>' % (H, state, f.replace(" hidden", ""))
else: body = '<div class="proto-window" style="height:auto;overflow:visible" data-state="%s" data-op="idle"><div class="proto-scroll" style="height:auto;overflow:visible"><div class="wrap">%s</div></div></div>' % (state, f)
js = "<script>document.querySelectorAll('[data-when]').forEach(function(e){if(e.getAttribute('data-when').split(/\\s+/).indexOf('%s')<0)e.hidden=true});document.querySelectorAll('[data-lens]').forEach(function(e,i){});</script>" % state
page = '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"></head><body>' + styles + body + js + "</body></html>"
open(tmp, "w").write(page)
import importlib.util
spec = importlib.util.spec_from_file_location("b", B + "build.py")
src = open(B + "build.py").read()
# reuse macro expansion from build.py without running the whole build
ns = {}
m = re.search(r"def spark\(m\):.*?\nt = re\.sub\(r\"@@SPARK.*?\n", src, re.S); t = page
exec("import re\n" + m.group(0), {"t": t, "re": re}, ns); t = ns["t"]
m2 = re.search(r"chrome = '''.*?'''", src, re.S); exec(m2.group(0), {}, ns); t = t.replace("@@CHROME@@", ns["chrome"])
t = t.replace("@@CSS@@", open(B + "../chrome/keelson-chrome.css").read())
out = B + "preview/" + name + ".html"; open(out, "w").write(t); os.remove(tmp)
png = B + "preview/" + name + ("" if state == "connected" else "-" + state) + ".png"
subprocess.run(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", f"--window-size={W},{H}", f"--screenshot={png}", "file://" + out], capture_output=True, timeout=90)
print("preview:", out); print("screenshot:", png, "exists" if os.path.exists(png) else "MISSING")
css_classes = set(re.findall(r"\.([a-zA-Z][\w-]*)", re.sub(r"\{[^}]*\}", "{}", "\n".join(re.findall(r"<style>(.*?)</style>", t, re.S)))))
frag_only = f
html_classes = set(c for mm in re.finditer(r'class="([^"]+)"', frag_only) for c in mm.group(1).split())
print("classes with no CSS rule:", sorted(c for c in html_classes if c not in css_classes))
print("unresolved macros:", sorted(set(re.findall(r"@@[A-Za-z:0-9-]+", t.split("</style>")[-1]))))
VOID = {"br","img","input","hr","meta","link","line","circle","path","rect","polyline","use","stop","ellipse","polygon","col","source"}
class P(html.parser.HTMLParser):
    def __init__(s): super().__init__(); s.st=[]; s.err=[]
    def handle_starttag(s, tag, a):
        if tag not in VOID: s.st.append((tag, s.getpos()[0]))
    def handle_startendtag(s, tag, a): pass
    def handle_endtag(s, tag):
        if tag in VOID: return
        if s.st and s.st[-1][0] == tag: s.st.pop()
        else: s.err.append(f"line {s.getpos()[0]}: </{tag}> but open is {s.st[-1] if s.st else None}")
p = P(); p.feed(frag_only)
print("tag balance errors:", p.err[:8], "unclosed:", p.st[:8])
print("em/en dashes:", frag_only.count("—") + frag_only.count("–"), "(allowed only as the null-cell placeholder in tables)")
print("fragment bytes:", len(frag_only.encode()))
