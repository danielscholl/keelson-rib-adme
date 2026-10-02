import subprocess, os, sys
B=os.path.dirname(os.path.abspath(__file__))+"/"
page=open(B+"adme-admin-mockup.html").read()
S={ # name: (js, proto height, window h, hide doc, theme)
 "access":("",3300,3400,True,"dark"),
 "access-light":("",3300,3400,True,"light"),
 "matrix":("click('[data-lens-target=matrix]')",3300,3400,True,"dark"),
 "grants":("click('[data-lens-target=grants]')",3300,3400,True,"dark"),
 "seismic":("click('[data-tab-target=seismic]')",2400,2500,True,"dark"),
 "data":("click('[data-tab-target=data]')",2200,2300,True,"dark"),
 "expired":("click('[data-state-target=expired]')",3600,3700,True,"dark"),
 "firstrun":("click('[data-state-target=firstrun]')",1300,1400,True,"dark"),
 "person":("click('[data-open-drawer=person]')",1350,1450,True,"dark"),
 "plan":("click('[data-open-drawer=plan]')",1500,1600,True,"dark"),
 "explain":("click('[data-open-drawer=explain]')",1150,1250,True,"light"),
 "modal-apply":("click('[data-open-drawer=plan]');click('[data-drawer=plan] [data-open-modal=apply]')",900,1000,True,"dark"),
 "modal-remove":("click('[data-open-modal=remove-person]')",900,1000,True,"dark"),
 "running":("click('[data-open-drawer=plan]');click('[data-drawer=plan] [data-open-modal=apply]');click('[data-apply]')",1700,1800,True,"dark"),
 "doc":("",0,9000,False,"dark"),
 "doc-light":("",0,9000,False,"light"),
}
only=sys.argv[1:]
for n,(js,ph,wh,hide,theme) in S.items():
    if only and n not in only: continue
    extra="<style>"+(".doc{display:none}" if hide else "")+(f".proto-window{{height:{ph}px !important}}" if ph else "")+"</style><script>function click(s){var e=document.querySelector(s);if(!e){document.title='MISSING '+s;return}e.click()};document.documentElement.setAttribute('data-theme','"+theme+"');"+js+"</script>"
    p=B+"preview/_shot_"+n+".html"; open(p,"w").write(page.replace("</body>",extra+"</body>"))
    png=B+"preview/shot-"+n+".png"
    subprocess.run(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","--headless=new","--hide-scrollbars","--force-device-scale-factor=1",f"--window-size=1560,{wh}",f"--screenshot={png}","file://"+p],capture_output=True,timeout=120)
    print(n, os.path.exists(png))
