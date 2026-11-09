// Kitchen Rush at /play: a small survivors-like in one page. You are the head chef, bugs, flaky tests and merge
// conflicts pour into the kitchen, and your pans fly at the nearest one by themselves. Tickets level you up, and
// three of the upgrades hire the board's cooks (Spec, Build, Review) to fight beside you. Hold out for five
// minutes and the order ships. A flaky test you knock down once comes back and slinks off: let it go and it is
// waved through, marked done when it wasn't, and the ship screen counts every one and shows your catch rate. Plain canvas, no libraries, so the page needs only an inline script.
import { SITE } from "./site";

const SCRIPT = `
const cv=document.getElementById("g"),x=cv.getContext("2d");
let W=0,H=0;function fit(){const b=document.querySelector("flisk-bar");W=cv.width=innerWidth;H=cv.height=innerHeight-(b?b.offsetHeight:0);x.imageSmoothingEnabled=false}addEventListener("resize",fit);addEventListener("load",fit);fit();
const WIN=300,keys={};let joy=null;
addEventListener("keydown",e=>{keys[e.key.toLowerCase()]=1;if(e.key===" "||e.key==="Enter")tap()});
addEventListener("keyup",e=>{keys[e.key.toLowerCase()]=0});
cv.addEventListener("pointerdown",e=>{if(st!=="play"){tap(e);return}joy={x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY}});
addEventListener("pointermove",e=>{if(joy){joy.x=e.clientX;joy.y=e.clientY}});
addEventListener("pointerup",()=>{joy=null});
const COOKS=[{n:"Spec cook",c:"#38bdf8",k:"spec",d:"Orbits you and slices what it touches"},{n:"Build cook",c:"#f59e0b",k:"build",d:"Throws hot pans of its own"},{n:"Review cook",c:"#a78bfa",k:"review",d:"Rejects every bug near it, often"}];
const UPS=[{n:"Faster pans",d:"Throw 25% faster",f:p=>p.rate*=.75},{n:"Heavier pans",d:"+1 damage",f:p=>p.dmg++},{n:"Extra pan",d:"+1 pan per throw",f:p=>p.multi++},{n:"Running shoes",d:"Move 15% faster",f:p=>p.spd*=1.15},{n:"Coffee",d:"Heal and +20 max health",f:p=>{p.max+=20;p.hp=p.max}},{n:"Big magnet",d:"Pick tickets from further",f:p=>p.mag*=1.4}];
let st="title",P,E,B,T,F,cooks,t,lvl,xp,need,kills,waved,caught,choice,last,spawnT,boss,shake,rec,rr,lostTo;
function reset(){P={x:0,y:0,hp:130,max:130,spd:180,rate:.55,cd:0,dmg:2,multi:1,mag:100,hurt:0,face:1};E=[];B=[];T=[];F=[];cooks=[];t=0;lvl=1;xp=0;need=4;kills=0;waved=0;caught=0;choice=null;spawnT=0;boss=0;shake=0;rec=[];rr=0;lostTo=""}
function tap(e){if(st==="title"||st==="dead"||st==="won"){reset();st="play";last=performance.now();return}
 if(st==="up"&&e){const i=pick(e.clientX,e.clientY-cv.getBoundingClientRect().top);if(i>=0)choose(i)}}
addEventListener("keydown",e=>{if(st==="up"&&"123".includes(e.key))choose(+e.key-1)});
const catchPct=()=>caught+waved?Math.round(caught/(caught+waved)*100)+"%":"",rateLine=()=>caught+waved?"Catch rate "+catchPct()+": "+caught+" of "+(caught+waved)+" flaky tests that came back really fixed.":"";
const rnd=(a,b)=>a+Math.random()*(b-a);
/* The receipts round (#338): at 5:00 every flaky test waved through comes back as a boss that carries what it was. */
const RECEIPTS=["checkout total test","login redirect test","cache expiry test","retry backoff test","date parsing test","upload size test"];
const receiptName=i=>RECEIPTS[i%RECEIPTS.length]+(i>=RECEIPTS.length?" #"+(Math.floor(i/RECEIPTS.length)+1):"");
function receiptBosses(rec,x0,y0,level){return rec.map((lb,i)=>{const a=i/rec.length*6.283,hp=20+level*3;return{x:x0+Math.cos(a)*420,y:y0+Math.sin(a)*420,k:"receipt",lb,hp,max:hp,sp:40,r:22,c:"#f59e0b",xp:0,fl:0,w:0}})}
const afterClock=(rec,round)=>round?"play":rec.length?"receipts":"won";
function spawn(){const a=rnd(0,7),r=Math.max(W,H)/2+60,m=t/60;
 const kind=Math.random()<.12+m*.04?"conflict":Math.random()<.35?"flaky":"bug";
 const s={bug:{hp:1+m*.7,sp:rnd(50,68)+m*4,r:9,c:"#ef4444",xp:1},flaky:{hp:2+m,sp:rnd(70,95)+m*4,r:8,c:"#facc15",xp:2},conflict:{hp:8+m*2.5,sp:36+m*3,r:16,c:"#fb7185",xp:5}}[kind];
 E.push({x:P.x+Math.cos(a)*r,y:P.y+Math.sin(a)*r,k:kind,hp:s.hp,max:s.hp,sp:s.sp,r:s.r,c:s.c,xp:s.xp,fl:0,w:rnd(0,6)})}
function spawnBoss(){const a=rnd(0,7);E.push({x:P.x+Math.cos(a)*500,y:P.y+Math.sin(a)*500,k:"ci",hp:50+boss*35,sp:48,r:30,c:"#dc2626",xp:30,fl:0,w:0});boss++;F.push({x:P.x,y:P.y-60,s:"CI went red!",l:2,c:"#f87171"})}
function near(x0,y0,max){let b=null,bd=max*max;for(const e of E){const d=(e.x-x0)**2+(e.y-y0)**2;if(d<bd){bd=d;b=e}}return b}
function throwFrom(o,n,dmg){const e=near(o.x,o.y,420);if(!e)return;for(let i=0;i<n;i++){const a=Math.atan2(e.y-o.y,e.x-o.x)+(i-(n-1)/2)*.22;B.push({x:o.x,y:o.y,vx:Math.cos(a)*380,vy:Math.sin(a)*380,l:1.2,d:dmg,s:0})}}
function hit(e,d){if(e.inv>0)return;e.hp-=d;e.fl=.1;F.push({x:e.x,y:e.y-e.r,s:String(d),l:.5,c:"#fff"});
 if(e.hp<=0&&e.k==="flaky"&&!e.re){E.push({...e,hp:Math.ceil(e.max/2),re:1,inv:.4,c:"#fb923c",x:e.x+rnd(-20,20),y:e.y+rnd(-20,20)});F.push({x:e.x,y:e.y-22,s:"Marked done?",l:1,c:"#fdba74"});return}
 if(e.hp<=0){kills++;if(e.re){caught++;F.push({x:e.x,y:e.y-22,s:"Really fixed",l:1,c:"#4ade80"})}T.push({x:e.x,y:e.y,v:e.xp});if(e.k==="ci")F.push({x:e.x,y:e.y-40,s:"Fixed CI!",l:2,c:"#4ade80"})}}
function offer(){const pool=[...UPS];const free=COOKS.filter(c=>!cooks.some(k=>k.k===c.k));if(free.length&&Math.random()<.75)pool.unshift({...free[Math.floor(Math.random()*free.length)],cook:1});
 const ch=[];if(pool[0].cook)ch.push(pool.shift());while(ch.length<3){ch.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0])}return ch}
function choose(i){const c=choice[i];if(!c)return;if(c.cook)cooks.push({k:c.k,c:c.c,n:c.n,a:0,cd:0,x:P.x,y:P.y});else c.f(P);choice=null;st="play";last=performance.now()}
function step(dt){t+=dt;let mx=(keys.d||keys.arrowright?1:0)-(keys.a||keys.arrowleft?1:0),my=(keys.s||keys.arrowdown?1:0)-(keys.w||keys.arrowup?1:0);
 if(joy){const dx=joy.x-joy.x0,dy=joy.y-joy.y0,l=Math.hypot(dx,dy);if(l>8){mx=dx/l;my=dy/l}}
 const l=Math.hypot(mx,my);if(l){P.x+=mx/l*P.spd*dt;P.y+=my/l*P.spd*dt;if(mx)P.face=Math.sign(mx)}
 spawnT-=dt;const rate=Math.max(.3,1.3-t/110);while(!rr&&spawnT<=0){spawn();spawnT+=rate}
 if(!rr&&t>=60*(boss+1)&&boss<4)spawnBoss();
 P.cd-=dt;if(P.cd<=0){throwFrom(P,P.multi,P.dmg);P.cd=P.rate}
 for(const k of cooks){if(k.k==="spec"){k.a+=dt*3;k.x=P.x+Math.cos(k.a)*70;k.y=P.y+Math.sin(k.a)*70;k.cd-=dt;if(k.cd<=0){for(const e of E)if(Math.hypot(e.x-k.x,e.y-k.y)<e.r+14)hit(e,2+Math.floor(lvl/4));k.cd=.25}}
  else{const tx=P.x+(k.k==="build"?-40:40),ty=P.y+30;k.x+=(tx-k.x)*dt*4;k.y+=(ty-k.y)*dt*4;k.cd-=dt;
   if(k.k==="build"&&k.cd<=0){throwFrom(k,2,P.dmg);k.cd=.9}
   if(k.k==="review"&&k.cd<=0){let any=0;for(const e of E)if(Math.hypot(e.x-k.x,e.y-k.y)<110){hit(e,3);any=1}if(any)F.push({x:k.x,y:k.y-26,s:"Changes requested",l:.8,c:"#c4b5fd"});k.cd=1.6}}}
 for(const b of B){b.x+=b.vx*dt;b.y+=b.vy*dt;b.l-=dt;b.s+=dt*14;for(const e of E)if(e.hp>0&&Math.hypot(e.x-b.x,e.y-b.y)<e.r+6){hit(e,b.d);b.l=0;break}}
 B=B.filter(b=>b.l>0);
 for(const e of E){const dx=P.x-e.x,dy=P.y-e.y,d=Math.hypot(dx,dy)||1;let sp=e.sp;if(e.re){e.x-=dx/d*sp*.35*dt;e.y-=dy/d*sp*.35*dt;e.fl-=dt;e.inv-=dt;
   if(d>Math.max(W,H)*.6+80){e.hp=0;rec.push(receiptName(waved));waved++;F.push({x:P.x,y:P.y-50,s:"Waved through: flaky test marked done",l:2,c:"#fb923c"})}continue}if(e.k==="flaky"){e.w+=dt*6;sp*=.7+Math.abs(Math.sin(e.w))*.8}
  e.x+=dx/d*sp*dt;e.y+=dy/d*sp*dt;e.fl-=dt;e.inv-=dt;if(d<e.r+12&&P.hurt<=0){P.hp-=e.k==="ci"?14:e.k==="receipt"?9:e.k==="conflict"?8:5;P.hurt=.7;shake=.2;if(e.lb)lostTo=e.lb}}
 E=E.filter(e=>e.hp>0);P.hurt-=dt;shake-=dt;
 for(const k of T){const d=Math.hypot(P.x-k.x,P.y-k.y);if(d<P.mag){k.x+=(P.x-k.x)*dt*8;k.y+=(P.y-k.y)*dt*8}if(d<14){xp+=k.v;k.v=0}}
 T=T.filter(k=>k.v>0);for(const f of F){f.l-=dt;f.y-=dt*30}F=F.filter(f=>f.l>0);
 if(xp>=need){xp-=need;lvl++;need=Math.floor(need*1.25+2);choice=offer();st="up"}
 if(P.hp<=0){st="dead"}
 if(t>=WIN&&!rr){const nx=afterClock(rec,rr);if(nx==="receipts"){rr=1;E=receiptBosses(rec,P.x,P.y,lvl);F.push({x:P.x,y:P.y-60,s:"Receipts round: show your work",l:2.5,c:"#fbbf24"})}else st="won"}
 else if(rr&&!E.some(e=>e.k==="receipt"))st="won"}
function tile(){const s=40;x.fillStyle="#3b2f2a";x.fillRect(0,0,W,H);const gx0=Math.floor((P.x-W/2)/s)-1,gy0=Math.floor((P.y-H/2)/s)-1;
 for(let i=0;i<W/s+3;i++)for(let j=0;j<H/s+3;j++){const gx=gx0+i,gy=gy0+j,X=Math.round(gx*s-P.x+W/2),Y=Math.round(gy*s-P.y+H/2);
  x.fillStyle=(gx+gy)&1?"#e8dcc4":"#c9b99a";x.fillRect(X+1,Y+1,s-2,s-2)}
 const C=240,cx0=Math.floor((P.x-W/2)/C)-1,cy0=Math.floor((P.y-H/2)/C)-1;
 for(let i=0;i<W/C+3;i++)for(let j=0;j<H/C+3;j++){const cx=cx0+i,cy=cy0+j,h=hash(cx,cy);if(Math.abs(cx)+Math.abs(cy)<2)continue;
  const X=cx*C-P.x+W/2+40+(h%60),Y=cy*C-P.y+H/2+40+((h>>6)%60);prop(h%5,X,Y)}}
function hash(a,b){let h=(a*374761393+b*668265263)|0;h=(h^(h>>>13))*1274126177|0;return (h^(h>>>16))>>>0}
function shadow(cx,cy,w){x.fillStyle="rgba(40,25,15,.28)";x.beginPath();x.ellipse(cx,cy,w/2,w/5,0,0,7);x.fill()}
function prop(k,X,Y){shadow(X+40,Y+56,100);
 if(k===0){px(X+40,Y+30,"#9ca3af",96,44);px(X+40,Y+50,"#6b7280",96,10);[22,58].forEach(o=>{px(X+o,Y+26,"#1f2937",26,18);px(X+o,Y+26,Math.floor(t*8+o)%2?"#f97316":"#fb923c",14,6)});px(X+58,Y+14,"#374151",24,14);
  for(let n=0;n<3;n++){const a=(t*.8+n/3)%1;x.globalAlpha=.5*(1-a);px(X+58+Math.sin(a*9+n)*4,Y+4-a*40,"#fff",6+a*6,6+a*6);x.globalAlpha=1}}
 else if(k===1){px(X+40,Y+30,"#a16207",96,40);px(X+40,Y+50,"#713f12",96,10);px(X+30,Y+28,"#fde68a",36,22);px(X+30,Y+28,"#ef4444",10,8);px(X+40,Y+28,"#22c55e",8,8);px(X+66,Y+26,"#d1d5db",4,22)}
 else if(k===2){px(X+40,Y+20,"#e5e7eb",50,76);px(X+40,Y+52,"#9ca3af",50,6);px(X+40,Y+16,"#cbd5e1",50,2);px(X+60,Y+2,"#6b7280",3,14);px(X+60,Y+30,"#6b7280",3,14)}
 else if(k===3){px(X+40,Y+30,"#9ca3af",80,40);px(X+40,Y+50,"#6b7280",80,10);px(X+40,Y+28,"#60a5fa",44,22);px(X+40,Y+12,"#d1d5db",4,12);px(X+30,Y+26,"#bfdbfe",8,4)}
 else{px(X+40,Y+40,"#92400e",44,30);px(X+40,Y+26,"#b45309",44,6);px(X+40,Y+40,"#78350f",44,2);px(X+40,Y+52,"#78350f",44,2)}}
function px(cx,cy,c,w,h){x.fillStyle=c;x.fillRect(Math.round(cx-w/2),Math.round(cy-h/2),w,h)}
function chef(cx,cy,c,hat,face){shadow(cx,cy+16,26);px(cx+12*face,cy+4,"#374151",10,8);px(cx+20*face,cy+4,"#1f2937",8,3);px(cx,cy+4,"#fff",16,3);px(cx,cy+6,c,18,16);px(cx,cy-8,"#f5d0a9",16,14);px(cx-3*face,cy-9,"#111",2,3);px(cx+3*face,cy-9,"#111",2,3);if(hat){px(cx,cy-20,"#fafafa",18,10);px(cx,cy-15,"#e5e5e5",20,3)}}
function draw(){const sx=shake>0?rnd(-4,4):0,sy=shake>0?rnd(-4,4):0;x.save();x.translate(sx,sy);tile();const ox=W/2-P.x,oy=H/2-P.y;
 for(const k of T){px(k.x+ox,k.y+oy,"#fffbeb",10,13);px(k.x+ox,k.y+oy-6,"#22c55e",10,2);px(k.x+ox,k.y+oy-1,"#9ca3af",6,1);px(k.x+ox,k.y+oy+2,"#9ca3af",6,1)}
 for(const e of E){const ex=e.x+ox,ey=e.y+oy,c=e.fl>0?"#fff":e.c;shadow(ex,ey+e.r,e.r*2.2);
  if(e.k==="bug"){px(ex,ey,c,16,12);px(ex-9,ey-3,c,4,2);px(ex+9,ey-3,c,4,2);px(ex-9,ey+3,c,4,2);px(ex+9,ey+3,c,4,2);px(ex-3,ey-3,"#111",3,3);px(ex+3,ey-3,"#111",3,3)}
  else if(e.k==="flaky"){px(ex,ey,c,14,14);px(ex,ey,"#111",4,8);px(ex,ey+5,"#111",4,2)}
  else if(e.k==="conflict"){px(ex,ey,c,30,26);x.fillStyle="#111";x.font="bold 10px monospace";x.textAlign="center";x.fillText("<<<",ex,ey-2);x.fillText(">>>",ex,ey+9)}
  else if(e.k==="receipt"){px(ex,ey,"#fffbeb",40,52);px(ex,ey-18,"#f59e0b",40,6);x.fillStyle="#111";x.font="bold 9px monospace";x.textAlign="center";x.fillText("RECEIPT",ex,ey-6);x.fillText(e.lb.slice(0,13),ex,ey+6);x.fillText("waved through",ex,ey+18);px(ex,ey-32,"#7f1d1d",40*Math.max(0,e.hp)/e.max,4)}
  else{px(ex,ey,c,58,50);px(ex,ey-8,"#111",36,10);x.fillStyle="#fecaca";x.font="bold 14px monospace";x.textAlign="center";x.fillText("CI",ex,ey+16);px(ex,ey-30,"#7f1d1d",58*Math.max(0,e.hp)/(50+(boss-1)*35),4)}}
 for(const b of B){x.save();x.translate(b.x+ox,b.y+oy);x.rotate(b.s);px(0,0,"#9ca3af",12,12);px(9,0,"#6b7280",8,3);x.restore()}
 for(const k of cooks){if(k.k==="review"){x.strokeStyle="rgba(167,139,250,.18)";x.beginPath();x.arc(k.x+ox,k.y+oy,110,0,7);x.stroke()}chef(k.x+ox,k.y+oy,k.c,1,1)}
 if(P.hurt<=0||Math.floor(t*20)%2)chef(W/2,H/2,"#22c55e",1,P.face);
 for(const f of F){x.globalAlpha=Math.min(1,f.l*2);x.fillStyle=f.c;x.font="bold 13px monospace";x.textAlign="center";x.fillText(f.s,f.x+ox,f.y+oy);x.globalAlpha=1}
 x.restore();hud()}
function bar(y,v,c,label){px(W/2,y,"#000a",Math.min(W-32,420)+4,14);const w=Math.min(W-32,420);x.fillStyle=c;x.fillRect(W/2-w/2,y-5,w*Math.max(0,Math.min(1,v)),10);x.fillStyle="#fff";x.font="bold 11px monospace";x.textAlign="center";x.fillText(label,W/2,y+4)}
function hud(){const left=Math.max(0,WIN-t),mm=Math.floor(left/60),ss=String(Math.floor(left%60)).padStart(2,"0");
 bar(16,xp/need,"#4ade80","Level "+lvl+"  ·  tickets "+xp+"/"+need);bar(34,P.hp/P.max,"#ef4444","Health "+Math.ceil(Math.max(0,P.hp)));if(rr){px(W/2,122,"#000a",220,18);x.fillStyle="#fbbf24";x.font="bold 13px monospace";x.textAlign="center";x.fillText("RECEIPTS ROUND: "+E.filter(e=>e.k==="receipt").length+" left",W/2,127)}
 px(W/2,61,"#000a",90,26);x.fillStyle="#fff";x.font="bold 22px monospace";x.textAlign="center";x.fillText(mm+":"+ss,W/2,68);px(W/2,82,"#000a",200,16);x.font="12px monospace";x.fillStyle="#ddd";x.fillText("bugs fixed "+kills+"  ·  cooks "+cooks.length+"/3",W/2,86);if(caught+waved){px(W/2,100,"#000a",260,16);x.fillStyle=waved?"#fdba74":"#4ade80";x.fillText("caught "+caught+"/"+(caught+waved)+" ("+catchPct()+")  ·  waved through "+waved,W/2,104)}
 if(joy){x.strokeStyle="#fff4";x.beginPath();x.arc(joy.x0,joy.y0,40,0,7);x.stroke();px(joy.x,joy.y,"#fff6",16,16)}}
let boxes=[];function pick(mx,my){return boxes.findIndex(b=>mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h)}
function panel(title,lines,cta){x.fillStyle="#000b";x.fillRect(0,0,W,H);x.textAlign="center";x.fillStyle="#22c55e";x.font="bold "+Math.min(48,W/10)+"px monospace";x.fillText(title,W/2,H/2-70);
 x.fillStyle="#ddd";x.font="15px monospace";const wrapped=[];lines.forEach(l=>{let cur="";for(const wd of l.split(" ")){const tr=cur?cur+" "+wd:wd;if(cur&&x.measureText(tr).width>W-24){wrapped.push(cur);cur=wd}else cur=tr}wrapped.push(cur)});wrapped.forEach((l,i)=>x.fillText(l,W/2,H/2-20+i*22));x.fillStyle="#fff";x.font="bold 16px monospace";if(Math.floor(performance.now()/500)%2)x.fillText(cta,W/2,H/2+wrapped.length*22+20)}
function upScreen(){x.fillStyle="#000c";x.fillRect(0,0,W,H);x.textAlign="center";x.fillStyle="#4ade80";x.font="bold 26px monospace";x.fillText("Level "+lvl+": pick one",W/2,H/2-150);
 const w=Math.min(340,W-32),h=78;boxes=choice.map((c,i)=>({x:W/2-w/2,y:H/2-110+i*(h+12),w,h}));
 choice.forEach((c,i)=>{const b=boxes[i];x.fillStyle=c.cook?"#1e293b":"#1f1f29";x.fillRect(b.x,b.y,w,h);x.strokeStyle=c.cook?c.c:"#444";x.lineWidth=2;x.strokeRect(b.x,b.y,w,h);
  if(c.cook)chef(b.x+30,b.y+h/2+4,c.c,1,1);x.textAlign="left";x.fillStyle="#fff";x.font="bold 15px monospace";x.fillText((i+1)+". "+(c.cook?"Hire "+c.n:c.n),b.x+56,b.y+32);x.fillStyle="#aaa";x.font="12px monospace";x.fillText(c.d,b.x+56,b.y+54)})}
function loop(now){const dt=Math.min(.05,(now-(last||now))/1000);last=now;
 if(st==="play")step(dt);if(st==="title"){reset();tile()}else draw();
 if(st==="title")panel("KITCHEN RUSH",["Bugs are pouring into the kitchen.","Your pans fly by themselves. Move with WASD,","arrows, or drag on a phone. Hire up to 3 cooks.","Hold out 5:00 and the order ships.","Flaky tests come back. Wave one through and it","returns at 5:00 as a boss with its receipt."],"Tap or press Enter");
 if(st==="up")upScreen();
 if(st==="dead")panel("ORDER FAILED",["You lasted "+Math.floor(t/60)+":"+String(Math.floor(t%60)).padStart(2,"0")+" at level "+lvl+".","Bugs fixed: "+kills+"  ·  cooks hired: "+cooks.length+"  ·  waved through: "+waved,rr&&lostTo?"The receipt that got you: "+lostTo+", waved through earlier.":"",rateLine()].filter(Boolean),"Tap to cook again");
 if(st==="won")panel("CLEAN SHIP",["Five minutes, level "+lvl+", "+kills+" bugs fixed.",rr?"All "+rec.length+" receipt"+(rec.length>1?"s":"")+" shown: you fixed every test you waved through.":"Every flaky test really fixed"+(caught?" ("+caught+")":"")+".",rateLine(),"Your real cooks can do this too:","run-my-agents.flisk.si"].filter(Boolean),"Tap to play again");
 requestAnimationFrame(loop)}
requestAnimationFrame(loop);
`;

/** The page, with absolute links for its X player card (base has no trailing slash, as baseOf gives it). */
export const gamePage = (base: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>Kitchen Rush · ${SITE.name}</title>
<meta name="description" content="A free browser game from ${SITE.name}: hold out five minutes against bugs, flaky tests and red CI with up to three agent cooks.">
<meta name="theme-color" content="#0b0b0f">
<link rel="canonical" href="${base}/play">
<meta property="og:title" content="Kitchen Rush">
<meta property="og:description" content="Hold out five minutes against bugs, flaky tests and red CI with up to three agent cooks. Free, in your browser.">
<meta property="og:type" content="website">
<meta property="og:url" content="${base}/play">
<meta property="og:image" content="${base}/play/card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="Kitchen Rush">
<meta name="twitter:description" content="Hold out five minutes against bugs and red CI with your agent cooks. Tap to play right here.">
<meta name="twitter:image" content="${base}/play/card.png">
<meta name="twitter:image:alt" content="Kitchen Rush: four pixel chefs in white hats face red pixel bugs and a merge-conflict block on a dark tiled kitchen floor.">
<meta name="twitter:player" content="${base}/play">
<meta name="twitter:player:width" content="480">
<meta name="twitter:player:height" content="480">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoGame","name":"Kitchen Rush","description":"A free survivors-like: hold out five minutes against bugs, flaky tests and red CI with up to three agent cooks.","url":"${base}/play","image":"${base}/play/card.png","genre":"Survivors-like","gamePlatform":"Web browser","playMode":"https://schema.org/SinglePlayer","isAccessibleForFree":true}</script>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0b0b0f;touch-action:none;user-select:none;-webkit-user-select:none}canvas{display:block}</style>
<script src="https://flisk.si/assets/bar.js" defer></script>
</head><body><canvas id="g" aria-label="Kitchen Rush game"></canvas><script>${SCRIPT}</script></body></html>`;
