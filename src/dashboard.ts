const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCode Telemetry</title>
  <link rel="stylesheet" href="/dashboard/style.css">
  <script src="/dashboard/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">◆</span><span>OPENCODE</span><b>TELEMETRY</b></div>
    <div class="top-stats" id="top-stats"></div>
    <div class="connection"><span class="pulse" id="pulse"></span><span id="connection">LOCKED</span></div>
  </header>
  <div class="layout">
    <aside class="rail">
      <div class="rail-heading"><span>SESSIONS</span><span id="session-count">0</span></div>
      <div class="sessions" id="sessions"></div>
    </aside>
    <main class="workspace">
      <section class="empty" id="empty">
        <div class="empty-glyph">⌁</div>
        <h1>No session selected</h1>
        <p>Choose a live or recent OpenCode session from the rail.</p>
      </section>
      <section class="detail hidden" id="detail">
        <div class="session-head">
          <div><div class="eyebrow" id="session-node"></div><h1 id="session-title"></h1><div class="session-meta" id="session-meta"></div></div>
          <span class="status" id="session-status"></span>
        </div>
        <div class="metrics" id="metrics"></div>
        <div class="columns">
          <section class="panel timeline-panel"><div class="panel-title"><span>ACTIVITY</span><span id="activity-count"></span></div><div class="timeline" id="timeline"></div></section>
          <section class="side-stack">
            <section class="panel"><div class="panel-title"><span>TODOS</span><span id="todo-count"></span></div><div class="todos" id="todos"></div></section>
            <section class="panel context-panel"><div class="panel-title"><span>CONTEXT</span></div><dl id="context"></dl></section>
          </section>
        </div>
      </section>
    </main>
  </div>
  <div class="gate" id="gate">
    <form class="gate-card" id="gate-form">
      <div class="gate-icon">◆</div><div class="eyebrow">READ-ONLY HUB ACCESS</div><h1>Open telemetry</h1>
      <p>Enter the dashboard token. It stays only in this tab's memory.</p>
      <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="oct_dash_..." required>
      <button type="submit">CONNECT <span>→</span></button><div class="gate-error" id="gate-error"></div>
    </form>
  </div>
</body>
</html>`

const css = `:root{color-scheme:dark;--bg:#090a0a;--panel:#101211;--panel2:#151715;--line:#252824;--muted:#777d75;--text:#e7e9e3;--amber:#f2a51a;--green:#71d08b;--red:#ef6a67;--blue:#75a7ff;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 var(--mono);overflow:hidden}.topbar{height:54px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 18px;gap:24px;background:#0c0d0d}.brand{letter-spacing:.08em;display:flex;gap:8px;align-items:center;white-space:nowrap}.brand-mark{color:var(--amber)}.brand b{font-size:10px;color:var(--muted);font-weight:500}.top-stats{display:flex;gap:24px;margin-left:auto}.top-stat{display:flex;gap:7px;color:var(--muted)}.top-stat b{color:var(--text);font-weight:500}.connection{min-width:100px;text-align:right;color:var(--muted);font-size:11px}.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#555;margin-right:8px}.pulse.live{background:var(--green);box-shadow:0 0 10px #71d08b66}.layout{display:grid;grid-template-columns:290px 1fr;height:calc(100vh - 54px)}.rail{border-right:1px solid var(--line);background:#0d0f0e;min-height:0}.rail-heading,.panel-title{height:42px;padding:0 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.14em;color:var(--muted)}.sessions{overflow:auto;height:calc(100% - 42px)}.session-card{width:100%;display:block;text-align:left;border:0;border-bottom:1px solid #1b1e1b;background:transparent;color:inherit;padding:13px 14px;cursor:pointer;font:inherit}.session-card:hover{background:#131513}.session-card.active{background:#181a17;box-shadow:inset 2px 0 var(--amber)}.session-card-top{display:flex;align-items:center;gap:8px}.session-card-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.dot{width:6px;height:6px;border-radius:50%;background:#555}.dot.busy{background:var(--amber);box-shadow:0 0 8px #f2a51a66}.dot.online{background:var(--green)}.session-card-sub{font-size:11px;color:var(--muted);margin:4px 0 0 14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace{overflow:auto;min-width:0}.empty{height:100%;display:grid;place-content:center;text-align:center;color:var(--muted)}.empty-glyph{font-size:54px;color:#31352f}.empty h1{font-size:16px;color:var(--text);font-weight:500;margin:10px 0 2px}.empty p{margin:0}.hidden{display:none!important}.detail{padding:28px;max-width:1500px;margin:auto}.session-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}.eyebrow{font-size:10px;letter-spacing:.15em;color:var(--amber);text-transform:uppercase}.session-head h1{font-size:25px;line-height:1.2;margin:7px 0 6px;font-weight:500}.session-meta{color:var(--muted);font-size:11px}.status{border:1px solid var(--line);border-radius:2px;padding:5px 9px;text-transform:uppercase;font-size:10px;letter-spacing:.12em}.status.busy{color:var(--amber);border-color:#684b18}.status.idle{color:var(--green);border-color:#2c5938}.status.offline{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(6,minmax(100px,1fr));border:1px solid var(--line);margin-bottom:18px}.metric{padding:13px 15px;border-right:1px solid var(--line);min-width:0}.metric:last-child{border:0}.metric-label{color:var(--muted);font-size:9px;letter-spacing:.12em}.metric-value{font-size:17px;margin-top:4px;overflow:hidden;text-overflow:ellipsis}.columns{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,.8fr);gap:18px}.panel{border:1px solid var(--line);background:var(--panel);min-width:0}.timeline-panel{min-height:450px}.timeline{padding:5px 0;max-height:calc(100vh - 260px);overflow:auto}.activity{display:grid;grid-template-columns:18px 1fr;gap:8px;padding:10px 14px;position:relative}.activity:before{content:"";position:absolute;left:22px;top:27px;bottom:-10px;border-left:1px solid var(--line)}.activity:last-child:before{display:none}.activity-icon{z-index:1;color:var(--muted);background:var(--panel);text-align:center}.activity.thought .activity-icon,.activity.thought .activity-title{color:var(--amber)}.activity.tool.running .activity-icon{color:var(--blue)}.activity.tool.completed .activity-icon{color:var(--green)}.activity.tool.error .activity-icon{color:var(--red)}.activity-title-row{display:flex;gap:12px;align-items:baseline}.activity-title{font-weight:500}.activity-time{margin-left:auto;color:var(--muted);font-size:10px}.activity-detail{white-space:pre-wrap;overflow-wrap:anywhere;color:#aeb3aa;margin-top:4px;max-height:220px;overflow:auto;font-size:12px}.side-stack{display:grid;gap:18px;align-content:start}.todos{padding:8px 0;max-height:300px;overflow:auto}.todo{display:grid;grid-template-columns:18px 1fr;gap:7px;padding:6px 12px}.todo-mark{color:var(--muted)}.todo.completed{color:var(--muted);text-decoration:line-through}.todo.in_progress .todo-mark{color:var(--amber)}.context-panel dl{margin:0;padding:9px 13px}.context-panel div{display:grid;grid-template-columns:90px 1fr;padding:5px 0;border-bottom:1px solid #1b1e1b}.context-panel div:last-child{border:0}.context-panel dt{color:var(--muted)}.context-panel dd{margin:0;overflow-wrap:anywhere}.gate{position:fixed;inset:0;background:#090a0af2;display:grid;place-items:center;z-index:10}.gate-card{width:min(420px,calc(100vw - 32px));border:1px solid var(--line);background:var(--panel);padding:34px}.gate-icon{color:var(--amber);font-size:26px;margin-bottom:22px}.gate-card h1{font-size:24px;font-weight:500;margin:7px 0}.gate-card p{color:var(--muted);margin:0 0 22px}.gate-card input{width:100%;background:#090a0a;border:1px solid #333831;color:var(--text);font:inherit;padding:12px;outline:none}.gate-card input:focus{border-color:var(--amber)}.gate-card button{margin-top:12px;width:100%;border:0;background:var(--amber);color:#171007;padding:11px;font:600 11px var(--mono);letter-spacing:.12em;cursor:pointer}.gate-card button span{float:right}.gate-error{color:var(--red);min-height:20px;margin-top:10px;font-size:11px}@media(max-width:900px){body{overflow:auto}.top-stats{display:none}.layout{grid-template-columns:1fr;height:auto}.rail{height:260px;border-right:0;border-bottom:1px solid var(--line)}.workspace{overflow:visible}.detail{padding:18px}.metrics{grid-template-columns:repeat(3,1fr)}.metric:nth-child(3){border-right:0}.columns{grid-template-columns:1fr}.timeline{max-height:none}.connection{margin-left:auto}}`

const js = `(()=>{let token="",snapshot=null,selected=null,timer=null;const $=id=>document.getElementById(id);const text=(tag,value,cls)=>{const el=document.createElement(tag);if(cls)el.className=cls;el.textContent=value??"";return el};const fmt=n=>new Intl.NumberFormat("en",{notation:n>9999?"compact":"standard",maximumFractionDigits:2}).format(n||0);const age=n=>{const s=Math.max(0,Math.round((Date.now()-n)/1000));return s<60?s+"s ago":s<3600?Math.floor(s/60)+"m ago":Math.floor(s/3600)+"h ago"};async function load(){const res=await fetch("/v1/dashboard/snapshot",{headers:{authorization:"Bearer "+token},cache:"no-store"});if(!res.ok)throw new Error(res.status===401?"Invalid dashboard token":"Dashboard unavailable");snapshot=await res.json();$("gate").classList.add("hidden");$("pulse").className="pulse live";$("connection").textContent="LIVE";render();clearTimeout(timer);timer=setTimeout(()=>load().catch(disconnected),3000)}function disconnected(){$("pulse").className="pulse";$("connection").textContent="RETRYING";clearTimeout(timer);timer=setTimeout(()=>load().catch(disconnected),5000)}function render(){const sessions=snapshot.sessions||[];if(!selected||!sessions.some(s=>s.key===selected))selected=sessions[0]?.key||null;$("session-count").textContent=String(sessions.length);const list=$("sessions");list.replaceChildren();for(const s of sessions){const card=text("button","","session-card"+(s.key===selected?" active":""));card.type="button";card.onclick=()=>{selected=s.key;render()};const top=text("div","","session-card-top");top.append(text("span","","dot "+(s.status==="busy"?"busy":s.connected?"online":"")),text("span",s.title||s.sessionId,"session-card-title"));card.append(top,text("div",s.nodeName+" · "+age(s.updatedAt),"session-card-sub"));list.append(card)}const totals=snapshot.totals||{};const ts=$("top-stats");ts.replaceChildren();for(const [label,value] of [["NODES",totals.connectedNodes+"/"+totals.nodes],["SESSIONS",String(totals.sessions)],["RUNNING",String(totals.busy)],["COST","$"+Number(totals.cost||0).toFixed(3)]]){const x=text("div","","top-stat");x.append(text("span",label),text("b",value));ts.append(x)}const s=sessions.find(x=>x.key===selected);if(!s){$("empty").classList.remove("hidden");$("detail").classList.add("hidden");return}$("empty").classList.add("hidden");$("detail").classList.remove("hidden");$("session-node").textContent=s.nodeName+" / "+s.project;$("session-title").textContent=s.title;$("session-meta").textContent=s.sessionId+(s.directory?" · "+s.directory:"");const status=$("session-status");status.textContent=s.connected?s.status:"offline";status.className="status "+(s.connected?s.status:"offline");const metrics=$("metrics");metrics.replaceChildren();for(const [label,value] of [["INPUT",fmt(s.tokens.input)],["OUTPUT",fmt(s.tokens.output)],["REASONING",fmt(s.tokens.reasoning)],["CACHE READ",fmt(s.tokens.cacheRead)],["CACHE WRITE",fmt(s.tokens.cacheWrite)],["COST","$"+Number(s.cost).toFixed(4)]]){const m=text("div","","metric");m.append(text("div",label,"metric-label"),text("div",value,"metric-value"));metrics.append(m)}renderTimeline(s);renderTodos(s);const context=$("context");context.replaceChildren();for(const [k,v] of [["Capture",s.capture],["Agent",s.agent||"—"],["Model",s.model||"—"],["Provider",s.provider||"—"],["Updated",new Date(s.updatedAt).toLocaleString()],["Connection",s.connected?"online":"offline"]]){const row=document.createElement("div");row.append(text("dt",k),text("dd",v));context.append(row)}}function renderTimeline(s){const box=$("timeline");box.replaceChildren();const rows=s.activities||[];$("activity-count").textContent=String(rows.length);if(!rows.length){box.append(text("div",s.capture==="metadata"?"Activity capture is metadata-only":"No captured activity","session-card-sub"));return}for(const a of rows){const row=text("article","","activity "+a.type+" "+(a.status||""));const icon={thought:"+",tool:"*",text:"›",retry:"↻",compaction:"◇"}[a.type]||"·";row.append(text("div",icon,"activity-icon"));const body=text("div","");const title=text("div","","activity-title-row");title.append(text("span",a.title,"activity-title"),text("span",a.status||"","activity-status"),text("span",a.startedAt?new Date(a.startedAt).toLocaleTimeString():"","activity-time"));body.append(title);if(a.detail)body.append(text("div",a.detail,"activity-detail"));row.append(body);box.append(row)}}function renderTodos(s){const box=$("todos");box.replaceChildren();const todos=s.todos||[];$("todo-count").textContent=String(todos.length);if(!todos.length){box.append(text("div",s.capture==="metadata"?"Todo capture is metadata-only":"No todos","session-card-sub"));return}for(const t of todos){const row=text("div","","todo "+t.status);row.append(text("span",t.status==="completed"?"[✓]":t.status==="in_progress"?"[→]":"[ ]","todo-mark"),text("span",t.content));box.append(row)}}$("gate-form").addEventListener("submit",e=>{e.preventDefault();token=$("token").value.trim();$("gate-error").textContent="";load().catch(err=>{$("gate-error").textContent=err.message})})})();`

const servedJs = js
  .replace('$("session-title").textContent=s.title;', '$("session-title").textContent=s.title||s.sessionId;')
  .replace(
    'if(!res.ok)throw new Error(res.status===401?"Invalid dashboard token":"Dashboard unavailable");',
    'if(!res.ok){if(res.status===401){token="";snapshot=null;selected=null;clearTimeout(timer);$("token").value="";$("token").focus();$("gate").classList.remove("hidden");$("gate-error").textContent="Dashboard token expired or was rotated";$("pulse").className="pulse";$("connection").textContent="LOCKED";return}throw new Error("Dashboard unavailable")}',
  )

const headers = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}

export function dashboardAsset(pathname: string) {
  if (pathname === "/dashboard" || pathname === "/dashboard/")
    return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } })
  if (pathname === "/dashboard/style.css")
    return new Response(css, { headers: { ...headers, "content-type": "text/css; charset=utf-8" } })
  if (pathname === "/dashboard/app.js")
    return new Response(servedJs, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } })
  return undefined
}

export function dashboardApiHeaders() {
  return {
    ...headers,
    "cache-control": "no-store",
    vary: "Authorization",
  }
}
