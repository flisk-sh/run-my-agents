// The kitchen tabs in the main panel: Queue (orders on a belt), Kitchen (Discovery and Delivery islands joined by
// the pass) and Lanes (one column per stage). All three draw /api/tasks plus the sessions the board already loaded
// (S, C, face, esc, post, toast and state come from the page's own script).

export const KITCHEN_CSS = String.raw`
.ktabs{display:flex;gap:4px;padding:var(--p2) var(--p2) 0;flex:none}
.ktab{font:600 12px var(--body);color:var(--muted);background:none;border:0;border-radius:var(--r-row);padding:6px 12px;cursor:pointer}
.ktab:hover{color:var(--text);background:#1e1e28}.ktab.on{color:var(--text);background:#26263a;box-shadow:inset 0 -2px 0 var(--green)}
.ktab i{font-style:normal;font:10px var(--mono);color:var(--mint);margin-left:5px}
.main.kmode>#hd,.main.kmode>#actbar,.main.kmode>#meter,.main.kmode>#skills,.main.kmode>#roles,.main.kmode>#warns,.main.kmode>#feed,.main.kmode>#newpill,.main.kmode>#box{display:none!important}
#kview{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:12px}
.kbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.kbar input,.kbar select{background:#0b0b10;color:var(--text);border:1px solid var(--line);border-radius:var(--r-row);padding:7px 10px;font:13px var(--body)}
.kbar input{flex:1;min-width:180px}
.kbtn{background:#26263a;color:var(--text);border:1px solid var(--line);border-radius:var(--r-row);padding:6px 10px;font:600 12px var(--body);cursor:pointer}
.kbtn:hover{background:#30304a}.kbtn.go{background:linear-gradient(#22c55e,#16a34a);border-color:transparent;color:#04130a}
.kbtn.sm{padding:2px 7px;font-size:11px}.kbtn.bad{color:#fca5a5}
.kstats{display:flex;gap:6px;flex-wrap:wrap;font:11px var(--mono);color:var(--muted)}.kstats span{background:#15151f;border-radius:var(--r-chip);padding:3px 7px}
.kstats b{color:var(--text)}
.belt{position:relative;flex:none;align-items:flex-start;display:flex;gap:10px;overflow-x:auto;padding:16px 12px 22px;border-radius:var(--r-panel);background:repeating-linear-gradient(90deg,#1a1d26 0 22px,#151821 22px 44px);box-shadow:inset 0 -6px 0 #2a2f3c,inset 0 6px 0 #2a2f3c;animation:kbelt 1.6s linear infinite}
@keyframes kbelt{to{background-position:-44px 0}}
.belt:empty::after{content:"No orders yet. Type one above and it lands here.";color:var(--muted);padding:20px}
.ord{flex:none;width:200px;background:#f6f1e7;color:#22180e;border-radius:10px;padding:9px;display:grid;gap:6px;box-shadow:0 4px 0 #8a5a2e;font-size:12px;cursor:grab}
.ord.next{outline:3px solid #fbbf24;outline-offset:3px}
.ord.stuck{box-shadow:0 4px 0 #b91c1c;animation:kshake .4s infinite}
@keyframes kshake{25%{translate:-2px 0}75%{translate:2px 0}}
.ord .top{display:flex;justify-content:space-between;align-items:center;font:700 11px var(--mono)}
.ord .t{font-weight:700;font-size:13.5px;line-height:1.25;word-break:break-word}
.pri{font:700 10px var(--mono);border-radius:4px;padding:0 5px;cursor:pointer}.pri.P0{background:#ef4444;color:#fff}.pri.P1{background:#f59e0b;color:#22180e}.pri.P2{background:#64748b;color:#fff}
.pips{display:flex;gap:3px}.pips i{flex:1;height:7px;border-radius:3px;background:#e2d6bf}.pips i.d{background:#22c55e}.pips i.n{background:#f59e0b}
.ochips{display:flex;gap:4px;flex-wrap:wrap}.ochips span{font:10px var(--mono);border-radius:5px;padding:1px 5px;background:#334155;color:#fff}
.sks{display:flex;gap:4px;flex-wrap:wrap;border-top:1px dashed #cdbb9c;padding-top:5px}
.skc{font:10px var(--mono);border-radius:5px;padding:1px 5px;border:1.5px solid;display:inline-flex;gap:3px;align-items:center}
.skc.ok{border-color:#16a34a;color:#166534}.skc.get{border-color:#d97706;color:#92400e}.skc.miss{border-color:#dc2626;color:#991b1b;cursor:pointer}
.skc.get::before{content:"";width:7px;height:7px;border-radius:50%;border:2px solid #d97706;border-top-color:transparent;animation:kspin .8s linear infinite}
@keyframes kspin{to{transform:rotate(360deg)}}
.oacts{display:flex;gap:4px;flex-wrap:wrap}.ord .kbtn{background:#efe6d4;color:#22180e;border-color:#cdbb9c}.ord .kbtn.go{background:#22c55e;color:#04130a}
.who{display:flex;align-items:center;gap:6px;font-size:11px}.who .av{animation:none;filter:none}
/* Kitchen: two islands and the pass */
.isles{display:grid;grid-template-columns:minmax(0,3fr) 90px minmax(0,4fr);gap:0;align-items:stretch;min-height:330px}
.isle{position:relative;border-radius:18px;padding:30px 10px 10px;background:repeating-linear-gradient(90deg,#c99a5e 0 34px,#b5854a 34px 36px);box-shadow:inset 0 0 0 8px #6b4423,0 14px 0 rgba(0,0,0,.35);display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px}
.isle h3{position:absolute;top:6px;left:14px;margin:0;font:700 12px var(--mono);color:#fff6e6;letter-spacing:.06em;text-transform:uppercase}
.stn{background:rgba(20,14,8,.25);border-radius:12px;padding:8px 6px;display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0}
.stn b{font:700 10px var(--mono);color:#fff;background:#475569;border-radius:6px;padding:3px 8px;box-shadow:inset 0 -3px 0 rgba(0,0,0,.3)}
.stn.fire b{background:#b91c1c;animation:kfl .5s infinite alternate}@keyframes kfl{to{filter:brightness(1.4)}}
.chef{display:flex;flex-direction:column;align-items:center;gap:2px;font:10px var(--mono);color:#fff6e6;text-align:center;max-width:100%}
.chef .ring{border-radius:50%;padding:3px;border:3px solid transparent}.chef.work .ring{border-color:#22c55e;border-top-color:transparent;animation:kspin 1.2s linear infinite}
.chef.work .ring>*{animation:kspin 1.2s linear infinite reverse}.chef.hot .ring{border-color:#ef4444}
.plate{background:#fff;color:#22180e;border:3px solid #d6cbb6;border-radius:999px;padding:1px 7px;font:700 10px var(--mono);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pass{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:repeating-linear-gradient(90deg,#8b5e34 0 12px,transparent 12px 16px);background-size:100% 26px;background-repeat:no-repeat;background-position:center;padding:6px}
.pass .gate{background:#fbbf24;color:#22180e;border-radius:8px;font:700 10px var(--mono);padding:3px 6px;text-align:center}
.idle{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--muted)}
.kgame{border-radius:var(--r-panel);overflow:hidden;box-shadow:0 0 0 1px var(--line)}.kgame canvas{display:block;width:100%;height:auto}
.khud{display:flex;justify-content:space-between;font:600 18px var(--mono)}.khud span{background:#15151f;border-radius:var(--r-row);padding:4px 12px}
/* Scores: bowling sheets ranking agents, pairs and skills by served orders */
.sctabs{display:flex;gap:4px}.sctab{background:#15151f;color:var(--muted);border:0;border-radius:var(--r-row);padding:5px 12px;font:600 12px var(--body);cursor:pointer}.sctab.on{background:#26263a;color:var(--text);box-shadow:inset 0 -2px 0 #fbbf24}
.sheet{display:grid;gap:6px;overflow-x:auto;align-content:start;grid-auto-rows:min-content;flex:none}
.srow{display:grid;grid-template-columns:34px minmax(110px,1.4fr) repeat(10,minmax(30px,1fr)) 54px;gap:3px;align-items:stretch;min-width:560px;height:44px}.srow.head{height:auto}
.srow.head{font:600 10px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.srow.head>*{padding:0 4px;text-align:center}.srow.head>:nth-child(2){text-align:left}
.srank{display:grid;place-items:center;font:800 15px var(--mono);border-radius:var(--r-row);background:#15151f}
.srow:nth-child(2) .srank{background:linear-gradient(#fde68a,#f59e0b);color:#3b2400}.srow:nth-child(3) .srank{background:linear-gradient(#e5e7eb,#9ca3af);color:#111}.srow:nth-child(4) .srank{background:linear-gradient(#fdba74,#c2410c);color:#2a1000}
.swho{background:#15151f;border-radius:var(--r-row);padding:4px 8px;min-width:0}.swho small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.swho b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}.swho small{color:var(--muted);font:10px var(--mono)}
.sfr{background:#f6f1e7;color:#22180e;border-radius:4px;display:grid;grid-template-rows:18px 22px;overflow:hidden}
.sfr .mk{justify-self:end;width:18px;height:18px;display:grid;place-items:center;font:800 12px var(--mono);border-left:1.5px solid #cdbb9c;border-bottom:1.5px solid #cdbb9c}
.sfr .mk.X{background:#16a34a;color:#fff}.sfr .mk.s{background:#f59e0b;color:#22180e}.sfr .mk.g{background:#ef4444;color:#fff}
.sfr .tt{display:grid;place-items:center;font:700 13px var(--mono)}.sfr.empty{background:#1a1a24}
.stot{display:grid;place-items:center;border-radius:var(--r-row);background:#26263a;font:800 18px var(--mono);color:#fbbf24}
.slegend{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}.slegend b{font:800 11px var(--mono);border-radius:3px;padding:0 5px;color:#fff}
/* Crew: model policy, skill sets per stage, agent containers (ReplicaSets of agents) */
.pol{display:flex;gap:8px;flex-wrap:wrap}.pol span{background:#15151f;border-radius:var(--r-row);padding:6px 10px;font-size:12px}.pol b{font:700 11px var(--mono)}
.mchip{font:700 10px var(--mono);border-radius:4px;padding:1px 6px;color:#0b0b10}.mchip.haiku{background:#6ee7a0}.mchip.sonnet{background:#38bdf8}.mchip.opus{background:#fbbf24}
.sets{display:grid;gap:6px}.setrow{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;background:#12121a;border-radius:var(--r-row);padding:6px 8px}
.setrow h5{margin:0;font:700 11px var(--mono);text-transform:uppercase;letter-spacing:.05em;display:grid;gap:3px}
.chipz{display:flex;gap:4px;flex-wrap:wrap}.sk2{font:11px var(--mono);border-radius:5px;padding:2px 6px;background:#1e1e2a;display:inline-flex;gap:4px;align-items:center}.sk2 i{font-style:normal;font-size:9px;border-radius:3px;padding:0 3px;background:#6ee7a0;color:#062}
.crewgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.crewbox{background:#12121a;border-radius:var(--r-panel);padding:10px;display:grid;gap:8px;box-shadow:inset 0 0 0 1px var(--line)}
.crewbox .bh{display:flex;justify-content:space-between;align-items:center;gap:8px}.crewbox .bh b{font-size:14px}.crewbox .bh small{color:var(--muted);font:10px var(--mono)}
.rep{display:flex;align-items:center;gap:6px;font:700 13px var(--mono)}.rep button{width:24px;height:24px;border-radius:6px;border:1px solid var(--line);background:#26263a;color:var(--text);cursor:pointer;font-weight:800}
.rep .bar{flex:1;display:flex;gap:3px}.rep .bar i{flex:1;height:8px;border-radius:3px;background:#2a2a38}.rep .bar i.r{background:#22c55e}.rep .bar i.s{background:#f59e0b;animation:kfl .6s infinite alternate}
.pods{display:grid;gap:4px}.pod{display:grid;grid-template-columns:28px 1fr auto auto;gap:6px;align-items:center;background:#1a1a24;border-radius:var(--r-row);padding:4px 6px;font-size:11.5px}
.pod.dead{opacity:.55;background:repeating-linear-gradient(135deg,#1a1a24 0 6px,#20141a 6px 12px)}.pod .nm2{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.strk{display:flex;gap:2px}.strk i{width:8px;height:8px;border-radius:50%;background:#2a2a38}.strk i.on{background:#ef4444}
.ghost{width:24px;height:24px;border-radius:50%;background:#2a2a38;display:grid;place-items:center;font-size:12px}
.mk2{display:grid;gap:8px;background:#12121a;border-radius:var(--r-panel);padding:10px}.mk2 .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.mk2 input{background:#0b0b10;color:var(--text);border:1px solid var(--line);border-radius:var(--r-row);padding:6px 9px;font:13px var(--body);min-width:0}
.pick{font:600 11px var(--body);border-radius:999px;padding:3px 9px;background:#1e1e2a;color:var(--muted);cursor:pointer;border:1px solid transparent}.pick.on{color:var(--text);border-color:var(--green);background:#16261c}
.kh{margin:4px 0 0;font:700 12px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.passbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:linear-gradient(90deg,#3b2a05,#241a06);border:1px solid #f59e0b;border-radius:var(--r-row);padding:8px 10px;font-size:12.5px}.passbar b{color:#fbbf24}.passbar .plist{display:flex;gap:4px;flex-wrap:wrap;flex:1;min-width:0}.passbar .plist span{background:#0b0b10;border-radius:5px;padding:2px 7px;font:11px var(--mono);cursor:pointer}.passbar .plist span:hover{outline:1px solid #fbbf24}
.rates{display:grid;gap:4px}.rrow{display:grid;grid-template-columns:30px minmax(120px,1.4fr) repeat(6,minmax(52px,.6fr)) 120px;gap:4px;align-items:center;background:#12121a;border-radius:var(--r-row);padding:5px 8px;font-size:12px;min-width:620px}.rrow.head{background:none;font:600 10px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.05em}.rrow .n{font:700 12px var(--mono);text-align:center}.rmeter{height:10px;border-radius:5px;background:#2a2a38;overflow:hidden;position:relative}.rmeter i{display:block;height:100%}.rnum{font:800 14px var(--mono);text-align:right}
.ttime{font:600 10.5px var(--mono);color:#5b4a35;display:flex;gap:6px;flex-wrap:wrap}.ttime b{color:#22180e}.ttime .slow{color:#b91c1c}
.flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}.flow div{background:#12121a;border-radius:var(--r-row);padding:8px 10px;display:grid;gap:2px}.flow small{color:var(--muted);font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.05em}.flow b{font:800 18px var(--mono)}.flow i{font-style:normal;color:var(--muted);font-size:11px}
.zgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;border-top:1px dashed #cdbb9c;padding-top:5px}.zgrid div{background:#efe6d4;border-radius:4px;padding:3px 5px;min-width:0}.zgrid small{display:block;font:700 8.5px var(--mono);letter-spacing:.06em;color:#8a6a3a;text-transform:uppercase}.zgrid span{display:block;font-size:10.5px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.qchip{background:#7c3aed!important}.answer{background:#ede9fe;color:#2e1065;border-radius:6px;padding:5px 7px;font-size:12px;line-height:1.35;white-space:pre-wrap;word-break:break-word;max-height:7.5em;overflow:auto}
.crewtable{display:grid;gap:8px}.crewrow{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"type lessons" "skills skills" "agents agents";gap:8px 12px;align-items:start;background:#12121a;border-radius:var(--r-panel);padding:10px;box-shadow:inset 0 0 0 1px var(--line)}.crewtype{grid-area:type;display:flex;gap:10px;align-items:center;min-width:0}.crewtype b{font-size:15px;margin-right:6px}.crewtype small{display:block;color:var(--muted);font-size:11px;margin-top:3px}.crewrow>.chipz{grid-area:skills}.crewagents{grid-area:agents;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;min-width:0}.crewfolder{display:grid;gap:4px;align-content:start;min-width:0}.crewfolder .cf{font:600 11px var(--mono);color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.crewlessons{grid-area:lessons;display:grid;gap:4px;justify-items:end}.crewlessons small{color:var(--muted);font:11px var(--mono)}
/* Lanes */
.lanes{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:8px;overflow-x:auto}
.lane{background:#12121a;border-radius:var(--r-row);padding:8px;display:flex;flex-direction:column;gap:6px;min-height:220px;box-shadow:inset 0 0 0 1px var(--line)}
.lane.over{box-shadow:inset 0 0 0 2px var(--green)}
.lane h4{margin:0 0 4px;font:700 11px var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:flex;justify-content:space-between}
.lane.gap{border-left:3px dashed #fbbf24}
.card{background:#1c1c28;border-radius:var(--r-chip);padding:7px;font-size:12px;cursor:grab;display:grid;gap:4px;box-shadow:inset 0 0 0 1px var(--line)}
.card.stuck{box-shadow:inset 0 0 0 1px #ef4444}.card small{color:var(--muted);font:10px var(--mono)}
.knote{color:var(--muted);font-size:11.5px;max-width:80ch}
`;

export const KITCHEN_HTML = String.raw`<div class="ktabs" id="ktabs"></div><div id="kview" hidden></div>`;

export const KITCHEN_JS = String.raw`
const KT=[["chat","Chat"],["queue","Queue"],["kitchen","Kitchen"],["lanes","Lanes"],["scores","Scores"],["crew","Crew"]];
let CR=null,SS=null,NB={name:"",role:"Code",stages:["build"],replicas:2,model:"haiku",strikes:3};
let SC=null,scBy=(()=>{try{return localStorage.getItem("rma-scby")||"agents"}catch(e){return"agents"}})();
let ktab=(()=>{try{return localStorage.getItem("rma-ktab")||"chat"}catch(e){return"chat"}})();
let kpri="P1",KD={stages:[],roles:{},tasks:[]},kauto=true,kdrag="",kbusy=false;
const STN={inbox:"Inbox",spec:"Spec",build:"Build",test:"Test",review:"Review",done:"Served"};
function kTabs(){const n=KD.tasks.filter(t=>t.stage!=="done").length;
 $("ktabs").innerHTML=KT.map(([k,l])=>'<button class="ktab'+(ktab===k?" on":"")+'" data-ktab="'+k+'">'+l+(k!=="chat"&&n?"<i>"+n+"</i>":"")+"</button>").join("");
 document.querySelector(".main").classList.toggle("kmode",ktab!=="chat");$("kview").hidden=ktab==="chat"}
const sess=id=>S.find(s=>s.id===id);
const kFace=(s,n)=>s?face(s,n):"";
/* An agent is done with its step when it went quiet after the order was sent. */
const kReady=t=>{const s=sess(t.assignee);return !!(s&&t.sentAt&&!s.sending&&state(s)!=="y"&&s.updatedAt>t.sentAt+3000&&Date.now()-s.updatedAt>8000)};
const kSaid=t=>{const s=sess(t.assignee),m=s&&s.feed&&s.feed.filter(x=>x.who==="agent").at(-1);return m?String(m.text||""):""};
const kVerdict=t=>{const w=kSaid(t).slice(-400);return /\bFAIL\b/.test(w)?false:/\bPASS\b/.test(w)?true:null};
function kPips(t){const i=KD.stages.indexOf(t.stage);return '<div class="pips">'+KD.stages.slice(0,5).map((_,j)=>'<i class="'+(j<i?"d":j===i?"n":"")+'"></i>').join("")+"</div>"}
function kSkills(t){return t.skills.length?'<div class="sks">'+t.skills.map(k=>'<span class="skc '+k.state+'"'+(k.state==="miss"?' data-kskill="'+t.id+'" title="Not installed. Click to try again."':"")+">"+(k.state==="ok"?"✓ ":k.state==="miss"?"✕ ":"")+esc(k.name)+"</span>").join("")+"</div>":""}
function kActs(t){const s=sess(t.assignee),r=[];
 if(t.stuck)r.push('<button class="kbtn sm" data-krequeue="'+t.id+'">\u21bb Requeue</button><button class="kbtn sm go" data-kserve="'+t.id+'">Serve anyway</button><button class="kbtn sm" data-kmove="'+t.id+'" data-to="build">Back to build</button>');

 if(!t.stuck&&t.stage!=="done"&&!t.assignee)r.push(t.stage==="spec"&&t._atPass?'<button class="kbtn sm go" data-kapprove="'+t.id+'">Approve at the pass</button>':'<button class="kbtn sm go" data-kgo="'+t.id+'">Dispatch</button>');
 if(t.assignee&&(t.stage==="test"||t.stage==="review"))r.push('<button class="kbtn sm go" data-kserve="'+t.id+'">Pass</button><button class="kbtn sm bad" data-kfail="'+t.id+'">Fail</button>');
 else if(t.assignee)r.push('<button class="kbtn sm go" data-kserve="'+t.id+'">Done →</button>');
 if(s)r.push('<button class="kbtn sm" data-kopen="'+s.id+'">Open</button>');
 r.push('<button class="kbtn sm" data-kdrop="'+t.id+'">Drop</button>');return '<div class="oacts">'+r.join("")+"</div>"}
function kWho(t){const s=sess(t.assignee);if(!s&&t.why)return '<div class="who" style="color:#92400e">\u23f8 '+esc(t.why)+"</div>";if(!s)return t.stuck?'<div class="who">⚠ sent back '+t.rounds+" times</div>":"";return '<div class="who">'+kFace(s,22)+esc(s.role)+(kReady(t)?" · ready":" · cooking")+"</div>"}
/* Lead time: ordered to served (or now). Cycle time: first picked up to served. Plus time in the current stage. */
const kDur=ms=>{if(!(ms>0))return "0s";const s=Math.round(ms/1e3);if(s<60)return s+"s";const m=Math.round(s/60);if(m<60)return m+"m";const h=Math.floor(m/60);return h<24?h+"h "+(m%60)+"m":Math.floor(h/24)+"d "+(h%24)+"h"};
function kTimes(t){const end=t.stage==="done"&&t.servedAt?t.servedAt:Date.now(),lead=end-t.created,cyc=t.startedAt?end-t.startedAt:0,inSt=t.stageAt&&t.stage!=="done"?Date.now()-t.stageAt:0;return{lead,cyc,inSt}}
function kTimeLine(t){const x=kTimes(t);return '<div class="ttime" title="Lead time: since ordered. Cycle time: since an agent first picked it up.">\u23f1 <span>lead <b>'+kDur(x.lead)+"</b></span>"+(x.cyc?"<span>cycle <b>"+kDur(x.cyc)+"</b></span>":"")+(x.inSt?'<span class="'+(x.inSt>15*60e3?"slow":"")+'">in '+STN[t.stage]+" <b>"+kDur(x.inSt)+"</b></span>":"")+"</div>"}
/* The Zachman card from intake triage: What, How, Where, Who, When, Why. */
function kZach(t){const z=t.zachman;if(!z||t.kind==="question")return "";return '<div class="zgrid" title="Zachman card from intake">'+[["What",z.what],["How",z.how],["Where",z.where],["Who",z.who],["When",z.when],["Why",z.why]].map(([k,v])=>"<div><small>"+k+'</small><span title="'+esc(v)+'">'+esc(v)+"</span></div>").join("")+"</div>"}
function kOrder(t,next){return '<div class="ord'+(next?" next":"")+(t.stuck?" stuck":"")+'" draggable="true" data-kid="'+t.id+'"><div class="top">#'+t.n+' <span class="pri '+t.priority+'" data-kpri="'+t.id+'" title="Click to change priority">'+t.priority+'</span></div><div class="t">'+esc(t.title)+"</div>"+(t.kind==="question"?"":kPips(t))+kTimeLine(t)+'<div class="ochips">'+(t.kind==="question"?'<span class="qchip">Question</span>':t.lane==="fast"?'<span style="background:#0e7490" title="Small task: build, test, served. No spec or review.">\u26a1 Fast lane</span>':"")+"<span>"+esc(STN[t.stage])+"</span><span>→ "+esc(t.stage==="build"?t.route:(KD.roles[t.stage]||[])[0]||"you")+"</span>"+(t.rounds?"<span>round "+(t.rounds+1)+"</span>":"")+"</div>"+kSkills(t)+kZach(t)+(t.answer?'<div class="answer">'+esc(t.answer)+"</div>":"")+kWho(t)+kActs(t)+"</div>"}
/* Orders waiting at the pass, shown on every kitchen tab so approving is never hidden. */
function kPassBar(){const w=KD.tasks.filter(t=>t.atPass);if(!w.length)return "";return '<div class="passbar"><b>\u23f8 '+w.length+" at the pass</b><span>Specs done. Approve to send to build:</span><div class=\"plist\">"+w.map(t=>'<span data-kapprove="'+t.id+'" title="Approve #'+t.n+'">#'+t.n+" "+esc(t.title.slice(0,40))+" \u2713</span>").join("")+'</div><button class="kbtn sm go" data-kapproveall>Approve all</button></div>'}
function kAdd(){return '<div id="kaddw" style="display:grid;gap:8px">'+kPassBar()+'<form class="kbar" id="kform"><input id="ktitle" maxlength="2000" placeholder="New order: what should the agents do?" autocomplete="off"><span class="kstats">'+["P0","P1","P2"].map(p=>'<span class="pri '+p+'" data-knewpri="'+p+'" style="opacity:'+(kpri===p?1:.35)+'">'+p+"</span>").join("")+'</span><button class="kbtn go">Add order</button><button type="button" class="kbtn'+(kauto?" go":"")+'" data-kauto>Autopilot '+(kauto?"on":"off")+"</button></form></div>"}
function kStats(){const open=KD.tasks.filter(t=>t.stage!=="done"),wait=open.filter(t=>!t.assignee),idle=S.filter(s=>!s.hidden&&!KD.tasks.some(t=>t.assignee===s.id)&&state(s)==="z");
 return '<div class="kstats"><span>waiting <b>'+wait.length+"</b></span><span>cooking <b>"+open.filter(t=>t.assignee).length+"</b></span><span>at the pass <b>"+open.filter(t=>t._atPass).length+"</b></span><span>stuck <b>"+open.filter(t=>t.stuck).length+"</b></span><span>served <b>"+KD.tasks.filter(t=>t.stage==="done").length+"</b></span><span>idle chefs <b>"+idle.length+"</b></span></div>"}
/* The last orders served, newest first, with a question's answer. */
function kServed(){const d=KD.tasks.filter(t=>t.stage==="done").sort((a,b)=>(b.servedAt||b.updated)-(a.servedAt||a.updated)).slice(0,6);if(!d.length)return "";return '<div class="kh">Just served</div><div class="belt" style="animation:none">'+d.map(t=>{return '<div class="ord" style="cursor:default'+(t.failed?";box-shadow:0 4px 0 #b91c1c":"")+'"><div class="top">#'+t.n+" <span>"+(t.failed?"failed":t.kind==="question"?"answered":"served")+(t.requeued?" \u00b7 try "+(t.requeued+1):"")+'</span></div><div class="t">'+esc(t.title)+"</div>"+kTimeLine(t)+(t.answer?'<div class="answer">'+esc(t.answer)+"</div>":"")+'<div class="oacts"><button class="kbtn sm'+(t.failed?" go":"")+'" data-krequeue="'+t.id+'" title="Not what you asked for? Send it back to the inbox as new.">\u21bb Requeue</button></div></div>'}).join("")+"</div>"}
function kQueue(){const open=KD.tasks.filter(t=>t.stage!=="done");const first=open.find(t=>!t.assignee&&!t.stuck);
 return kAdd()+kStats()+'<div class="belt" id="kbelt">'+open.map(t=>kOrder(t,t===first)).join("")+'</div>'+kServed()+'<p class="knote">Intake sorts each order: a question gets one short answer; a task gets a Zachman card and goes spec, build, test, review. P0 first, then the oldest. With Autopilot on, specs cross the pass and failed orders close by themselves. Not what you asked for? Requeue it.</p>'}
function kKitchen(){return kAdd()+'<div class="kgame"><canvas id="kcv" width="1000" height="580" aria-label="Kitchen: agents cooking orders"></canvas></div><p class="knote">Click a chef to open its chat. Click a plate on the bridge to approve it across the pass. Fire means two agents are editing the same file.</p>'}
/* ---------- the kitchen game scene: a canvas drawn every frame from KD and S ---------- */
const KG={chefs:{},parts:[],clouds:[0,1,2,3,4].map(i=>({x:i*240,y:30+((i*97)%380),w:90+(i*37)%80,v:6+i%3*4})),hits:[],t0:performance.now(),raf:0};
/* Stations in scene units (1000 x 580). Island 1 is Discovery, island 2 is Delivery. */
const ISL=[{x:40,y:150,w:330,h:330,name:"DISCOVERY"},{x:560,y:120,w:400,h:380,name:"DELIVERY"}];
const ST={inbox:{x:110,y:205,kind:"crate"},spec:{x:290,y:205,kind:"board"},build:{x:630,y:175,kind:"stove"},test:{x:760,y:175,kind:"taste"},review:{x:890,y:175,kind:"sink"},done:{x:890,y:440,kind:"hatch"}};
const PASS={x:465,y:300};
function kRR(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
function kIsland(c,I,t){/* shadow, basket rim, planks, wall */
 c.fillStyle="rgba(20,40,70,.28)";kRR(c,I.x+14,I.y+30,I.w,I.h,26);c.fill();
 c.fillStyle="#7a4a22";kRR(c,I.x-10,I.y-10,I.w+20,I.h+34,28);c.fill();
 for(let i=0;i<I.w+20;i+=14){c.fillStyle=i%28?"#8d5a2b":"#6b3f1c";c.fillRect(I.x-10+i,I.y+I.h+6,7,16)}
 c.save();kRR(c,I.x,I.y,I.w,I.h,20);c.clip();
 for(let i=0;i<I.h;i+=26){for(let j=-((i/26)%2)*40;j<I.w;j+=80){c.fillStyle=((i/26+j/80)|0)%2?"#e3b273":"#d9a564";c.fillRect(I.x+j,I.y+i,79,25)}}
 c.fillStyle="rgba(120,70,30,.25)";for(let i=0;i<I.h;i+=26)c.fillRect(I.x,I.y+i+24,I.w,2);
 c.restore();
 c.fillStyle="#b7773d";kRR(c,I.x-4,I.y-4,I.w+8,18,9);c.fill();
 c.fillStyle="#fff6e6";c.font="700 13px "+getComputedStyle(document.body).getPropertyValue("--mono");c.fillText(I.name,I.x+12,I.y-16)}
function kBunting(c,x1,y1,x2,y2,t){c.strokeStyle="#6b3f1c";c.lineWidth=2;c.beginPath();c.moveTo(x1,y1);c.quadraticCurveTo((x1+x2)/2,(y1+y2)/2+30,x2,y2);c.stroke();
 const cols=["#ef4444","#22c55e","#f59e0b","#3b82f6"];for(let i=1;i<12;i++){const u=i/12,x=(1-u)*(1-u)*x1+2*u*(1-u)*(x1+x2)/2+u*u*x2,y=(1-u)*(1-u)*y1+2*u*(1-u)*((y1+y2)/2+30)+u*u*y2,sw=Math.sin(t*2+i)*2;
  c.fillStyle=cols[i%4];c.beginPath();c.moveTo(x-7,y);c.lineTo(x+7,y);c.lineTo(x+sw,y+15);c.fill()}}
function kBridge(c,t){const y=PASS.y;c.fillStyle="rgba(20,40,70,.2)";c.fillRect(372,y+16,190,10);
 for(let x=372;x<560;x+=13){c.fillStyle=(x/13|0)%2?"#a8723c":"#93612f";c.save();c.translate(x,y+Math.sin(t*1.6+x/30)*1.5);c.fillRect(0,-14,10,30);c.restore()}
 c.strokeStyle="#e8d2a6";c.lineWidth=3;for(const o of[-16,18]){c.beginPath();c.moveTo(370,y+o);c.quadraticCurveTo(465,y+o+8+Math.sin(t*1.6)*2,562,y+o);c.stroke()}
 /* the pass: a bell on a little counter */
 c.fillStyle="#475569";kRR(c,PASS.x-34,y-58,68,26,6);c.fill();c.fillStyle="#fbbf24";c.beginPath();c.arc(PASS.x,y-58,11,Math.PI,0);c.fill();c.fillRect(PASS.x-13,y-59,26,3);
 c.fillStyle="#fff";c.font="700 10px monospace";c.textAlign="center";c.fillText("PASS",PASS.x,y-40);c.textAlign="left"}
function kStation(c,k,s,t,hot,busy){const x=s.x,y=s.y;
 c.fillStyle="rgba(0,0,0,.18)";kRR(c,x-44,y-24,92,62,10);c.fill();
 c.fillStyle=hot?"#7f1d1d":"#5b6573";kRR(c,x-46,y-30,92,58,10);c.fill();c.fillStyle=hot?"#991b1b":"#6f7a89";kRR(c,x-46,y-30,92,10,6);c.fill();
 if(s.kind==="stove"){for(const dx of[-22,22]){c.fillStyle="#1f2937";c.beginPath();c.arc(x+dx,y,15,0,7);c.fill();c.fillStyle=busy?"#f97316":"#374151";c.beginPath();c.arc(x+dx,y,10,0,7);c.fill()}
  if(busy){c.fillStyle="#94a3b8";kRR(c,x-38,y-12,32,22,6);c.fill();c.fillStyle="#cbd5e1";c.fillRect(x-40,y-14,36,4)}}
 else if(s.kind==="board"){c.fillStyle="#c08a4e";kRR(c,x-34,y-16,68,34,6);c.fill();c.fillStyle="#e5e7eb";c.save();c.translate(x+14,y);c.rotate(busy?Math.sin(t*14)*.5:0);c.fillRect(-3,-18,6,22);c.fillStyle="#4b5563";c.fillRect(-3,4,6,10);c.restore();
  if(busy)for(let i=0;i<4;i++){c.fillStyle=["#22c55e","#ef4444","#f59e0b","#22c55e"][i];c.fillRect(x-24+i*8,y+4,6,6)}}
 else if(s.kind==="crate"){c.fillStyle="#a16207";kRR(c,x-32,y-18,64,38,5);c.fill();c.strokeStyle="#713f12";c.lineWidth=3;c.strokeRect(x-30,y-16,60,34);c.beginPath();c.moveTo(x-30,y-16);c.lineTo(x+30,y+18);c.stroke()}
 else if(s.kind==="taste"){c.fillStyle="#e2e8f0";c.beginPath();c.ellipse(x,y,26,16,0,0,7);c.fill();c.fillStyle="#22c55e";c.beginPath();c.ellipse(x,y,16,9,0,0,7);c.fill();c.fillStyle="#b45309";c.fillRect(x+12,y-22,4,22)}
 else if(s.kind==="sink"){c.fillStyle="#cbd5e1";kRR(c,x-30,y-16,60,32,8);c.fill();c.fillStyle="#7dd3fc";kRR(c,x-24,y-10,48,20,6);c.fill();c.fillStyle="#94a3b8";c.fillRect(x-3,y-24,6,14)}
 else if(s.kind==="hatch"){c.fillStyle="#1f2937";kRR(c,x-34,y-18,68,36,6);c.fill();c.fillStyle="#22c55e";for(let i=0;i<5;i++){c.fillRect(x-30+((i*14+t*30)%60),y-3,8,6)}}
 c.fillStyle="#0f172a";kRR(c,x-34,y+32,68,16,5);c.fill();c.fillStyle="#fff";c.font="700 10px monospace";c.textAlign="center";c.fillText(STN[k].toUpperCase(),x,y+44);c.textAlign="left";
 if(busy&&(s.kind==="stove"||s.kind==="board")&&Math.random()<.25)KG.parts.push({x:x-20+Math.random()*20,y:y-18,vx:(Math.random()-.5)*8,vy:-24-Math.random()*16,life:1.4,kind:"steam"});
 if(hot&&Math.random()<.7)KG.parts.push({x:x-30+Math.random()*60,y:y-20,vx:(Math.random()-.5)*14,vy:-40-Math.random()*40,life:.9,kind:"fire"})}
function kPlate(c,x,y,label,glow){c.fillStyle="rgba(0,0,0,.2)";c.beginPath();c.ellipse(x+2,y+5,17,8,0,0,7);c.fill();
 if(glow){c.strokeStyle="#fbbf24";c.lineWidth=3;c.beginPath();c.arc(x,y,21,0,7);c.stroke()}
 c.fillStyle="#fff";c.beginPath();c.arc(x,y,16,0,7);c.fill();c.strokeStyle="#d6cbb6";c.lineWidth=3;c.beginPath();c.arc(x,y,12,0,7);c.stroke();
 c.fillStyle="#22180e";c.font="700 10px monospace";c.textAlign="center";c.fillText(label,x,y+4);c.textAlign="left"}
function kChefDraw(c,ch,s,t){c.save();c.translate(ch.x,ch.y);c.scale(1.45,1.45);const x=0,y=0,walk=Math.hypot(ch.tx-ch.x,ch.ty-ch.y)>3,bob=walk?Math.abs(Math.sin(t*10+ch.seed))*4:Math.sin(t*2+ch.seed)*1.5,col=(s.face&&s.face.color)||"#60a5fa";
 c.fillStyle="rgba(0,0,0,.22)";c.beginPath();c.ellipse(x,y+16,16,6,0,0,7);c.fill();
 if(ch.ring){c.strokeStyle=ch.ring;c.lineWidth=4;c.beginPath();c.ellipse(x,y+14,22,9,0,0,7);c.stroke()}
 /* feet */c.fillStyle="#1f2937";const fs=walk?Math.sin(t*12+ch.seed)*4:0;c.beginPath();c.ellipse(x-7,y+12+fs,5,4,0,0,7);c.ellipse(x+7,y+12-fs,5,4,0,0,7);c.fill();
 const yy=y-bob;c.fillStyle=col;c.beginPath();c.arc(x,yy,15,0,7);c.fill();c.fillStyle="rgba(255,255,255,.25)";c.beginPath();c.arc(x-5,yy-6,6,0,7);c.fill();
 /* apron */c.fillStyle="#f8fafc";c.beginPath();c.arc(x,yy+4,10,0,Math.PI);c.fill();
 /* eyes look where it walks */const lx=Math.max(-2,Math.min(2,(ch.tx-ch.x)/20));c.fillStyle="#0b0b10";c.beginPath();c.arc(x-5+lx,yy-3,2.4,0,7);c.arc(x+5+lx,yy-3,2.4,0,7);c.fill();
 /* hat */c.fillStyle="#fff";c.fillRect(x-9,yy-22,18,8);c.beginPath();c.arc(x-6,yy-24,6,0,7);c.arc(x+6,yy-24,6,0,7);c.arc(x,yy-28,7,0,7);c.fill();
 /* working arm */if(ch.work){c.strokeStyle=col;c.lineWidth=5;c.lineCap="round";const a=Math.sin(t*12+ch.seed)*.8;c.beginPath();c.moveTo(x+12,yy+2);c.lineTo(x+12+Math.cos(a)*12,yy+2+Math.sin(a)*12);c.stroke()}
 c.fillStyle="rgba(11,11,16,.75)";const nm=(s.role||"Agent").slice(0,10);c.font="700 10px monospace";const w=c.measureText(nm).width+10;kRR(c,x-w/2,y+22,w,15,5);c.fill();c.fillStyle="#fff";c.textAlign="center";c.fillText(nm,x,y+33);c.textAlign="left";
 if(ch.plate)kPlate(c,x+18,yy-18,ch.plate,false);
 c.restore();KG.hits.push({x:ch.x,y:ch.y,r:30,act:"open",id:s.id})}
function kTickets(c,t){const open=KD.tasks.filter(x=>x.stage!=="done").slice(0,6);open.forEach((o,i)=>{const x=14+i*112,y=12;
 c.fillStyle="#7a4a22";kRR(c,x,y+3,104,60,8);c.fill();c.fillStyle="#fff8ec";kRR(c,x,y,104,58,8);c.fill();
 c.fillStyle=o.priority==="P0"?"#ef4444":o.priority==="P1"?"#f59e0b":"#64748b";kRR(c,x+6,y+6,22,12,3);c.fill();c.fillStyle="#fff";c.font="700 9px monospace";c.fillText(o.priority,x+9,y+15);
 c.fillStyle="#22180e";c.font="700 10px monospace";c.fillText("#"+o.n+" "+STN[o.stage],x+32,y+15);
 c.font="600 10px sans-serif";c.fillText(o.title.slice(0,18),x+6,y+29);const tm=kTimes(o);c.font="600 9px monospace";c.fillStyle=tm.inSt>15*60e3?"#b91c1c":"#5b4a35";c.fillText("\u23f1 "+kDur(tm.lead)+(tm.inSt?" \u00b7 "+STN[o.stage]+" "+kDur(tm.inSt):""),x+6,y+39);
 const age=(Date.now()-o.created)/6e5,left=Math.max(0,1-age);c.fillStyle="#e2d6bf";kRR(c,x+6,y+45,92,7,3);c.fill();c.fillStyle=o.stuck||left<.25?"#ef4444":left<.5?"#f59e0b":"#22c55e";kRR(c,x+6,y+45,Math.max(6,92*left),7,3);c.fill();
 if(o.stuck){c.save();c.translate(x+52,y+29);c.rotate(Math.sin(t*20)*.03);c.restore()}})}
function kHud(c,t){const tok=S.reduce((a,s)=>a+(s.tokens?s.tokens.used:0),0),served=KD.tasks.filter(x=>x.stage==="done").length;
 c.fillStyle="#334155";kRR(c,14,520,200,46,12);c.fill();c.fillStyle="#fbbf24";c.beginPath();c.arc(40,543,15,0,7);c.fill();c.fillStyle="#b45309";c.beginPath();c.arc(40,543,9,0,7);c.fill();
 c.fillStyle="#fff";c.font="700 22px monospace";c.fillText(kt(tok),64,551);c.font="10px monospace";c.fillText("tokens",150,551);
 c.fillStyle="#334155";kRR(c,786,520,200,46,12);c.fill();c.fillStyle="#fff";c.font="700 22px monospace";c.fillText(served+" served",800,551);
 const m=Math.floor((Date.now()-KG.t0wall)/1000);c.font="700 14px monospace";c.fillText(String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0"),930,537)}
KG.t0wall=Date.now();
function kFrame(now){const cv=$("kcv");if(!cv||ktab!=="kitchen"){KG.raf=0;return}KG.raf=requestAnimationFrame(kFrame);
 const c=cv.getContext("2d"),t=now/1000,dt=Math.min(.25,(now-(KG.last||now))/1000);KG.last=now;KG.hits=[];
 const sky=c.createLinearGradient(0,0,0,580);sky.addColorStop(0,"#8fd0f7");sky.addColorStop(1,"#4ea3dd");c.fillStyle=sky;c.fillRect(0,0,1000,580);
 for(const cl of KG.clouds){cl.x+=cl.v*dt;if(cl.x>1060)cl.x=-cl.w-40;c.fillStyle="rgba(255,255,255,.7)";c.beginPath();c.ellipse(cl.x,cl.y,cl.w/2,cl.w/5,0,0,7);c.ellipse(cl.x+cl.w/4,cl.y-cl.w/8,cl.w/4,cl.w/6,0,0,7);c.fill()}
 kBunting(c,40,140,370,140,t);kBunting(c,560,110,960,110,t);
 ISL.forEach(I=>kIsland(c,I,t));kBridge(c,t);
 /* who is where */
 const live=S.filter(s=>!s.hidden),hotIds=new Set(C.flatMap(x=>x.sessions)),byStage={};
 for(const o of KD.tasks)if(o.assignee)byStage[o.stage]=(byStage[o.stage]||[]).concat(o);
 for(const k of Object.keys(ST)){const busy=(byStage[k]||[]).length>0,hot=(byStage[k]||[]).some(o=>hotIds.has(o.assignee));kStation(c,k,ST[k],t,hot,busy)}
 /* orders waiting at a station with no chef sit on its counter */
 for(const k of Object.keys(ST)){const w=KD.tasks.filter(o=>o.stage===k&&!o.assignee&&!o._atPass&&(k!=="done"||o.updated>Date.now()-864e5)).slice(0,4);w.forEach((o,i)=>kPlate(c,ST[k].x-30+i*20,ST[k].y-40-(i%2)*6,"#"+o.n,false))}
 /* plates at the pass sit on the bridge, waiting for your OK */
 KD.tasks.filter(o=>o._atPass).forEach((o,i)=>{const x=PASS.x-30+i*30,y=PASS.y+(i%2?6:-6)+Math.sin(t*3+i)*2;kPlate(c,x,y,"#"+o.n,true);KG.hits.push({x,y,r:18,act:"approve",id:o.id})});
 /* chefs walk to their station, idle ones wander their island */
 const seen=new Set();
 live.slice(0,14).forEach((s,i)=>{seen.add(s.id);const o=KD.tasks.find(x=>x.assignee===s.id);let ch=KG.chefs[s.id];
  const home=s.role==="Planner"||s.role==="Calls"||s.role==="Calendar"?ISL[0]:ISL[1];
  if(!ch)ch=KG.chefs[s.id]={x:home.x+home.w/2,y:home.y+home.h-60,tx:0,ty:0,seed:i*1.7,next:0};
  if(o){const st=ST[o.stage]||ST.inbox,n=(byStage[o.stage]||[]).indexOf(o);ch.tx=st.x-30+n*44;ch.ty=st.y+88;ch.work=Math.hypot(ch.tx-ch.x,ch.ty-ch.y)<6&&!kReady(o);ch.plate="#"+o.n}
  else{ch.work=false;ch.plate="";if(now>ch.next){ch.tx=home.x+40+Math.random()*(home.w-80);ch.ty=home.y+home.h-130+Math.random()*90;ch.next=now+3000+Math.random()*4000}}
  ch.ring=hotIds.has(s.id)?"#ef4444":ch.work?"#22c55e":o&&kReady(o)?"#fbbf24":"";
  /* chefs cross between islands over the bridge, never through the sky */
  let gx=ch.tx,gy=ch.ty;if((ch.x<465)!==(ch.tx<465)){const near=ch.x<465?365:565,far=ch.x<465?565:365;gx=Math.abs(ch.y-PASS.y)>4&&Math.abs(ch.x-near)>4&&(ch.x<360||ch.x>570)?near:far;gy=PASS.y}
  const dx=gx-ch.x,dy=gy-ch.y,d=Math.hypot(dx,dy),sp=130*dt;if(d>sp){ch.x+=dx/d*sp;ch.y+=dy/d*sp}else{ch.x=gx;ch.y=gy}});
 for(const id of Object.keys(KG.chefs))if(!seen.has(id))delete KG.chefs[id];
 Object.entries(KG.chefs).sort((a,b)=>a[1].y-b[1].y).forEach(([id,ch])=>{const s=S.find(x=>x.id===id);if(s)kChefDraw(c,ch,s,t)});
 /* steam and fire */
 KG.parts=KG.parts.filter(p=>(p.life-=dt)>0);for(const p of KG.parts){p.x+=p.vx*dt;p.y+=p.vy*dt;
  if(p.kind==="fire"){c.fillStyle="rgba(255,"+(120+((p.life*120)|0))+",40,"+Math.min(1,p.life*1.4)+")";c.beginPath();c.arc(p.x,p.y,4+p.life*7,0,7);c.fill()}
  else{c.fillStyle="rgba(255,255,255,"+p.life*.35+")";c.beginPath();c.arc(p.x,p.y,6+(1.4-p.life)*8,0,7);c.fill()}}
 kTickets(c,t);kHud(c,t);
 if(!KD.tasks.length){c.fillStyle="rgba(11,11,16,.7)";kRR(c,330,270,340,44,12);c.fill();c.fillStyle="#fff";c.font="600 14px sans-serif";c.textAlign="center";c.fillText("No orders yet. Add one above to start cooking.",500,297);c.textAlign="left"}}
function kStart(){if(!KG.raf&&$("kcv"))KG.raf=requestAnimationFrame(kFrame)}
document.addEventListener("click",e=>{const cv=e.target.closest&&e.target.closest("#kcv");if(!cv)return;const r=cv.getBoundingClientRect(),x=(e.clientX-r.left)*1000/r.width,y=(e.clientY-r.top)*580/r.height;
 const h=[...KG.hits].reverse().find(h=>Math.hypot(h.x-x,h.y-y)<h.r);if(!h)return;
 if(h.act==="approve"){post("api/tasks/move",{id:h.id,approved:true,stage:"build"}).then(()=>{setPass(h.id,false);toast("Approved: it crosses the pass");kLoad()})}
 else{sel=h.id;try{localStorage.setItem("rma-sel",sel);localStorage.setItem("rma-ktab","chat")}catch(_){}ktab="chat";last="";kDraw();render()}});
document.addEventListener("mousemove",e=>{const cv=e.target.closest&&e.target.closest("#kcv");if(!cv)return;const r=cv.getBoundingClientRect(),x=(e.clientX-r.left)*1000/r.width,y=(e.clientY-r.top)*580/r.height;cv.style.cursor=KG.hits.some(h=>Math.hypot(h.x-x,h.y-y)<h.r)?"pointer":"default"});
function kFlow(){const f=SC.flow;if(!f)return "";const tile=(l,v,sub)=>'<div><small>'+l+"</small><b>"+v+"</b><i>"+sub+"</i></div>";return '<div class="kh">Flow \u00b7 lead and cycle time</div><div class="flow">'+tile("Lead time",f.served?kDur(f.leadMedian):"\u2013","median \u00b7 p85 "+(f.served?kDur(f.leadP85):"\u2013"))+tile("Cycle time",f.cycleCount?kDur(f.cycleMedian):"\u2013","median \u00b7 p85 "+(f.cycleCount?kDur(f.cycleP85):"\u2013"))+tile("Throughput",f.throughput24h,"served in 24 h")+tile("In progress",f.wip,"open orders")+tile("Failed",f.failed,"closed after FAILs")+"</div>"}
function kRatings(){const rs=SC.ratings||[];if(!rs.length)return '<div class="kh">Agent ratings</div><p class="knote">No agent has cooked an order yet. Ratings appear as soon as one does.</p>';
 const col=v=>v>=70?"#22c55e":v>=40?"#f59e0b":"#ef4444";
 return '<div class="kh">Agent ratings \u00b7 live, all orders</div><div style="overflow-x:auto"><div class="rates"><div class="rrow head"><span>#</span><span>Agent</span><span>Steps</span><span>Working</span><span>Served</span><span>Fails</span><span>Stuck</span><span>Strikes</span><span style="text-align:right">Rating</span></div>'+rs.map((r,i)=>{const s=sess(r.id);return '<div class="rrow"><span class="n">'+(i+1)+'</span><span style="display:flex;gap:6px;align-items:center;min-width:0">'+(s?kFace(s,22):"")+'<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(r.label)+'"><b>'+esc(r.label)+'</b> <small style="color:var(--muted)">'+esc(r.role)+"</small></span></span>"+[r.steps,r.working,r.served,r.fails,r.stuck,r.strikes].map((v,j)=>'<span class="n" style="color:'+(j>=3&&v?"#fca5a5":"inherit")+'">'+v+"</span>").join("")+'<span style="display:grid;grid-template-columns:1fr 34px;gap:6px;align-items:center"><span class="rmeter"><i style="width:'+r.rating+"%;background:"+col(r.rating)+'"></i></span><span class="rnum" style="color:'+col(r.rating)+'">'+r.rating+"</span></span></div>"}).join("")+'</div></div><p class="knote">Starts at 50: +10 per order served, +3 per step done, \u22128 per FAIL on an order it built, \u221215 per stuck order it built, \u221210 per container strike.</p>'}
function kScores(){if(!SC)return '<p class="knote">Loading scores…</p>';
 const tabs='<div class="kbar"><div class="sctabs">'+[["agents","Agents"],["pairs","Pairs"],["skills","Skills"]].map(([k,l])=>'<button class="sctab'+(scBy===k?" on":"")+'" data-scby="'+k+'">'+l+" <i>"+SC[k].length+"</i></button>").join("")+'</div><span class="kstats"><span>served <b>'+SC.served+"</b></span></span></div>";
 const rows=SC[scBy];if(!rows.length)return kFlow()+kRatings()+'<div class="kh">Bowling \u00b7 served orders</div>'+tabs+'<p class="knote">No served orders yet. Only orders that reach Served are scored: an order served with no FAIL is a strike.</p>';
 const fr=f=>{if(!f)return '<div class="sfr empty"></div>';const c=f.mark==="X"?"X":f.mark==="/"?"s":f.mark==="-"?"g":"";return '<div class="sfr" title="#'+f.n+" "+esc(f.title)+'"><span class="mk '+c+'">'+f.mark+'</span><span class="tt">'+f.total+"</span></div>"};
 return kFlow()+kRatings()+'<div class="kh">Bowling \u00b7 served orders</div>'+tabs+'<div class="sheet"><div class="srow head"><span>#</span><span>'+(scBy==="agents"?"Agent":scBy==="pairs"?"Pair":"Skill")+"</span>"+[1,2,3,4,5,6,7,8,9,10].map(i=>"<span>"+i+"</span>").join("")+"<span>Score</span></div>"+rows.map((r,i)=>'<div class="srow"><span class="srank">'+(i+1)+'</span><div class="swho"><b title="'+esc(r.label)+'">'+esc(r.label)+"</b><small>"+esc(r.sub)+" · "+r.strikes+"X "+r.spares+"/ · "+r.served+" served</small></div>"+Array.from({length:10},(_,j)=>fr(r.frames[j])).join("")+'<span class="stot">'+r.score+"</span></div>").join("")+'</div><div class="slegend"><span><b style="background:#16a34a">X</b> strike: served with no FAIL, 10 + next two frames</span><span><b style="background:#f59e0b;color:#22180e">/</b> spare: one FAIL, 10 + next frame</span><span><b style="background:#64748b">4</b> two FAILs</span><span><b style="background:#ef4444">-</b> gutter: served while stuck</span><span>Last 10 served orders make a game. 300 is perfect.</span></div>'}
async function kScoreLoad(){try{SC=await (await fetch("api/scores")).json();if(ktab==="scores")kDraw()}catch(e){}}
document.addEventListener("click",e=>{const b=e.target.closest&&e.target.closest("[data-scby]");if(!b)return;scBy=b.dataset.scby;try{localStorage.setItem("rma-scby",scBy)}catch(_){}kDraw()});

/* ---------- Crew: the model policy, skill sets per stage, and agent containers ---------- */
const MCH=m=>m?'<span class="mchip '+esc(m)+'">'+esc(m)+"</span>":"";
/* Crew: one row per stage, matching the kitchen's four agent types. Each row: the type, its model, its skill set,
   its agents per folder (with − / +), and the lessons every agent of that stage shares. */
function kCrew(){if(!CR||!SS)return '<p class="knote">Loading crew…</p>';
 const typeFace=(role,n)=>{const t=(SS.types||[]).find(x=>x.role===role);return t?face({id:"type-"+role,face:{shape:t.shape,eyes:t.eyes,color:t.color,extra:t.extra||""},tokens:{used:0},updatedAt:0},n):""};
 const pod=(x,p)=>{const s=sess(p.session),dead=p.status==="evicted";return '<div class="pod'+(dead?" dead":"")+'" title="'+esc(p.reason||"")+'">'+(s?kFace(s,24):'<span class="ghost">'+(dead?"☠":"⏳")+"</span>")+'<span class="nm2">'+(dead?"Fired: "+esc(p.reason||""):esc((s&&s.title)||"Starting…"))+'</span><span class="strk">'+Array.from({length:x.maxStrikes},(_,i)=>'<i class="'+(i<p.strikes?"on":"")+'"></i>').join("")+"</span>"+(dead?"<span></span>":'<button class="kbtn sm bad" data-kfire="'+p.session+'">Fire</button>')+"</div>"};
 const rows=["spec","build","test","review"].map(st=>{const x=SS.stages[st],boxes=CR.containers.filter(c=>c.stages.length===1&&c.stages[0]===st),role={spec:"Spec",build:"Build",test:"Test",review:"Review"}[st];
  const lessons=boxes.reduce((a,c)=>a+c.lessons.length,0),ready=boxes.reduce((a,c)=>a+c.ready,0),want=boxes.reduce((a,c)=>a+c.replicas,0);
  const folders=boxes.map(c=>{const lv=c.pods.filter(p=>p.status!=="evicted"),dead=c.pods.filter(p=>p.status==="evicted").slice(-2);return '<div class="crewfolder"><div class="rep"><span class="cf">'+esc(c.cwd.split("/").filter(Boolean).pop()||c.cwd)+'</span><button data-kscale="'+c.id+'" data-n="'+(c.replicas-1)+'" title="One agent fewer">−</button><span>'+c.ready+"/"+c.replicas+'</span><button data-kscale="'+c.id+'" data-n="'+(c.replicas+1)+'" title="One agent more">+</button></div><div class="pods">'+lv.concat(dead).map(p=>pod(c,p)).join("")+"</div></div>"}).join("");
  return '<div class="crewrow"><div class="crewtype">'+typeFace(role,40)+"<div><b>"+role+"</b>"+MCH(x.policy.model)+'<small>'+(st==="spec"?"Plans the task: the orchestrator":st==="build"?"Writes the change":st==="test"?"Runs it and says PASS or FAIL":"Reads the change and says PASS or FAIL")+'</small></div></div><div class="chipz">'+x.skills.map(k=>'<span class="sk2" title="'+esc(k.what)+'">/'+esc(k.name)+(k.haiku?"<i>haiku</i>":"")+"</span>").join("")+'</div><div class="crewagents">'+(folders||'<span class="knote">No agents yet. Autopilot starts one the first time an order needs '+role+".</span>")+'</div><div class="crewlessons"><span class="sk2" title="Every '+role+' agent reads it before an order">/rma-lessons-'+st+"<i>"+lessons+" lessons</i></span>"+(lessons?boxes.filter(c=>c.lessons.length).slice(0,1).map(c=>'<button class="kbtn sm" data-kclearlessons="'+c.id+'">Clear</button>').join(""):"")+'<small>'+ready+"/"+want+" agents</small></div></div>"}).join("");
 const other=CR.containers.filter(c=>!(c.stages.length===1&&["spec","build","test","review"].includes(c.stages[0])));
 const otherHtml=other.length?'<div class="kh">Other containers</div><p class="knote">These cover several stages at once. The stage rows above replace them; delete them when their orders are done.</p><div class="crewgrid">'+other.map(c=>'<div class="crewbox"><div class="bh"><div><b>'+esc(c.name)+"</b> "+MCH(c.model)+"<br><small>"+esc(c.role)+" · "+c.stages.map(st=>STN[st]).join(", ")+" · "+c.ready+"/"+c.replicas+' agents</small></div><button class="kbtn sm" data-kboxdel="'+c.id+'">Delete</button></div></div>').join("")+"</div>":"";
 const pol='<div class="pol"><span>Orchestrator (Spec): '+MCH(SS.policy.orchestrator.model)+" <b>"+SS.policy.orchestrator.effort+"</b></span><span>Build, Test, Review: "+MCH(SS.policy.worker.model)+" <b>"+SS.policy.worker.effort+"</b></span></div>";
 return pol+'<div class="kh">Kitchen agents · one type per stage</div><div class="crewtable">'+rows+"</div>"+otherHtml}
async function kCrewLoad(){try{const [a,b]=await Promise.all([fetch("api/containers").then(r=>r.json()),fetch("api/skillsets").then(r=>r.json())]);CR=a;SS=b;if(ktab==="crew"&&!(document.activeElement&&document.activeElement.id==="nbname"))kDraw()}catch(e){}}
document.addEventListener("click",async e=>{const t=e.target.closest&&e.target.closest("[data-kclearlessons],[data-nbrep],[data-nbrole],[data-nbst],[data-nbm],[data-nbs],[data-kscale],[data-kfire],[data-crewboxdel]");if(!t)return;const d=t.dataset;const nm=$("nbname");if(nm)NB.name=nm.value;
 if(d.nbrep){NB.replicas=Math.max(0,Math.min(10,NB.replicas+ +d.nbrep));return kDraw()}
 if(d.nbrole){NB.role=d.nbrole;return kDraw()}
 if(d.nbst){NB.stages=NB.stages.includes(d.nbst)?NB.stages.filter(x=>x!==d.nbst):NB.stages.concat(d.nbst);return kDraw()}
 if(d.nbm){NB.model=d.nbm;return kDraw()}
 if(d.nbs){NB.strikes=+d.nbs;return kDraw()}
 if(d.kscale){const r=await post("api/containers/scale",{id:d.kscale,replicas:+d.n});if(r.error)toast(r.error);else toast(r.name+": "+r.replicas+" agents");return kCrewLoad()}
 if(d.kfire){const r=await post("api/containers/fire",{session:d.kfire});toast(r.error||"Fired. A new agent is starting.");return kCrewLoad()}
 if(d.crewboxdel){const r=await post("api/containers/delete",{id:d.crewboxdel});toast(r.error||"Container deleted");return kCrewLoad()}});
document.addEventListener("submit",async e=>{if(e.target.id!=="nbox")return;e.preventDefault();NB.name=$("nbname").value.trim();const cur=sess(sel);
 const r=await post("api/containers",{name:NB.name,role:NB.role,stages:NB.stages,replicas:NB.replicas,model:NB.model,maxStrikes:NB.strikes,cwd:cur&&cur.cwd||""});
 if(r.error)return toast(r.error);NB.name="";toast(r.name+" created: starting "+r.replicas+" agents");await post("api/containers/reconcile",{});kCrewLoad()});
function kLanes(){return kAdd()+'<div class="lanes">'+KD.stages.map(st=>{const ts=KD.tasks.filter(t=>t.stage===st);return '<div class="lane'+(st==="build"?" gap":"")+'" data-klane="'+st+'"><h4>'+STN[st]+"<span>"+ts.length+"</span></h4>"+ts.map(t=>{const s=sess(t.assignee);return '<div class="card'+(t.stuck?" stuck":"")+'" draggable="true" data-kid="'+t.id+'"><span><span class="pri '+t.priority+'">'+t.priority+"</span> #"+t.n+" "+esc(t.title)+"</span>"+'<small>\u23f1 '+kDur(kTimes(t).lead)+(kTimes(t).inSt?" \u00b7 in "+STN[t.stage]+" "+kDur(kTimes(t).inSt):"")+"</small>"+(s?"<small>"+esc(s.role)+(kReady(t)?" · ready":" · cooking")+"</small>":t.answer?'<small style="white-space:pre-wrap">\u2192 '+esc(t.answer.slice(0,200))+"</small>":t._atPass?'<small>waiting at the pass</small><button class="kbtn sm go" data-kapprove="'+t.id+'">Approve</button>':t.why?"<small>"+esc(t.why)+"</small>":"")+"</div>"}).join("")+"</div>"}).join("")+'</div><p class="knote">Drag a card to another column to move it, or onto an agent in the sidebar to hand it over. The dashed line is the pass between Discovery and Delivery.</p>'}
function kDraw(){kTabs();if(ktab==="chat")return;const v=$("kview");if(ktab==="kitchen"&&$("kcv")){const f=$("kaddw");if(f&&!f.contains(document.activeElement))f.outerHTML=kAdd();kStart();return}if(v.contains(document.activeElement)&&document.activeElement.id==="ktitle"){const keep=$("ktitle").value;v.innerHTML=ktab==="queue"?kQueue():ktab==="kitchen"?kKitchen():ktab==="scores"?kScores():ktab==="crew"?kCrew():kLanes();const i=$("ktitle");i.value=keep;i.focus();return}
 v.innerHTML=ktab==="queue"?kQueue():ktab==="kitchen"?kKitchen():ktab==="scores"?kScores():ktab==="crew"?kCrew():kLanes();kStart()}
async function kLoad(){if(kdrag)return;try{KD=await (await fetch("api/tasks")).json();markPass();try{kauto=(await (await fetch("api/kitchen")).json()).auto!==false}catch(_){}if(ktab==="scores")await kScoreLoad();if(ktab==="crew")await kCrewLoad();kDraw()}catch(e){}}
function markPass(){for(const t of KD.tasks)t._atPass=!!t.atPass}
function setPass(){}
async function kServe(t,pass){
 const r=await post("api/tasks/serve",{id:t.id,pass});if(r.error)toast(r.error);else toast(pass===false?(r.stuck?"#"+t.n+" is stuck: look at it":"#"+t.n+" back to build"):"#"+t.n+" → "+STN[r.stage]);kLoad()}
async function kGo(id,session){const r=await post("api/tasks/dispatch",session?{id,session}:{id});if(r.error)toast(r.error);else toast("#"+r.n+" sent to "+((sess(r.assignee)||{}).role||"an agent"));kLoad()}
document.addEventListener("click",async e=>{const el=e.target.closest&&e.target.closest("[data-krequeue],[data-kapproveall],[data-ktab],[data-kgo],[data-kserve],[data-kfail],[data-kdrop],[data-kmove],[data-kapprove],[data-kpri],[data-kskill],[data-kopen]");if(!el)return;const d=el.dataset,find=id=>KD.tasks.find(t=>t.id===id);
 if(d.ktab){ktab=d.ktab;if(ktab==="scores")kScoreLoad();if(ktab==="crew")kCrewLoad();try{localStorage.setItem("rma-ktab",ktab)}catch(_){}kDraw();if(ktab==="chat")last="";return}
 if(d.kgo)return kGo(d.kgo);
 if(d.kserve){const t=find(d.kserve);if(t)return kServe(t,true)}
 if(d.kfail){const t=find(d.kfail);if(t)return kServe(t,false)}
 if(d.kdrop){await post("api/tasks/drop",{id:d.kdrop});setPass(d.kdrop,false);toast("Dropped");return kLoad()}
 if(d.kmove){await post("api/tasks/move",{id:d.kmove,stage:d.to});return kLoad()}
 if(d.krequeue){const r=await post("api/tasks/requeue",{id:d.krequeue});toast(r.error||"#"+r.n+" is back in the inbox"+(r.kind==="question"?" as a question":""));return kLoad()}
 if(d.kapproveall!==undefined){const w=KD.tasks.filter(t=>t.atPass);for(const t of w)await post("api/tasks/move",{id:t.id,approved:true,stage:"build"});toast(w.length+" approved: on to build");return kLoad()}
 if(d.kapprove){const t=find(d.kapprove);await post("api/tasks/move",{id:d.kapprove,approved:true,stage:"build"});setPass(d.kapprove,false);toast("#"+(t?t.n:"")+" crosses the pass");return kLoad()}
 if(d.kpri){const t=find(d.kpri);const n={P0:"P1",P1:"P2",P2:"P0"}[t.priority];await post("api/tasks/move",{id:t.id,priority:n});return kLoad()}
 if(d.kskill){await post("api/tasks/skills",{id:d.kskill});toast("Installing skills");return kLoad()}
 if(d.kopen){sel=d.kopen;try{localStorage.setItem("rma-sel",sel)}catch(_){}ktab="chat";try{localStorage.setItem("rma-ktab","chat")}catch(_){}last="";kDraw();render()}},true);
document.addEventListener("submit",async e=>{if(e.target.id!=="kform")return;e.preventDefault();const i=$("ktitle"),title=i.value.trim();if(!title)return toast("Describe the order first.");
 const cur=sess(sel);const r=await post("api/tasks",{title,priority:kpri,cwd:cur&&cur.cwd||""});if(r.error)return toast(r.error);i.value="";toast("Order #"+r.n+" is on the belt");kLoad()});
document.addEventListener("click",e=>{const p=e.target.closest("[data-knewpri]");if(p){kpri=p.dataset.knewpri;kDraw()}});
document.addEventListener("click",async e=>{if(!e.target.closest("[data-kauto]"))return;const r=await post("api/kitchen",{auto:!kauto});if(r.error)return toast(r.error);kauto=r.auto;toast(kauto?"Autopilot on: orders approve, scale and move by themselves":"Autopilot off: you approve and dispatch");kDraw();kLoad()});
document.addEventListener("dragstart",e=>{const c=e.target.closest&&e.target.closest("[data-kid]");if(c){kdrag=c.dataset.kid;e.dataTransfer.setData("text/plain",kdrag)}});
document.addEventListener("dragend",()=>{kdrag="";document.querySelectorAll(".lane.over").forEach(x=>x.classList.remove("over"))});
document.addEventListener("dragover",e=>{const l=e.target.closest&&(e.target.closest("[data-klane]")||e.target.closest("#side [data-sel]"));if(l&&kdrag){e.preventDefault();if(l.dataset.klane)l.classList.add("over")}});
document.addEventListener("dragleave",e=>{const l=e.target.closest&&e.target.closest("[data-klane]");if(l)l.classList.remove("over")});
document.addEventListener("drop",async e=>{if(!kdrag)return;const id=kdrag;kdrag="";const l=e.target.closest("[data-klane]"),a=e.target.closest("#side [data-sel]");
 if(l){e.preventDefault();e.stopPropagation();const r=await post("api/tasks/move",{id,stage:l.dataset.klane,...(KD.stages.indexOf(l.dataset.klane)>=2?{approved:true}:{})});if(r.error)toast(r.error);setPass(id,false);kLoad()}
 else if(a){e.preventDefault();e.stopPropagation();kGo(id,a.dataset.sel)}},true);
setInterval(kLoad,3000);kLoad();
`;
