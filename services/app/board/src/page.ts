// The board's one page: a Discord-style sidebar of agents (30%) and the selected agent's channel. It loads
// /api/sessions every 3 seconds and draws everything in the browser, so selection and folds survive refreshes.
//
// Corners are concentric: an inner radius is the outer radius minus the padding between them, so nested
// curves share one centre instead of bulging (r_inner = r_outer - gap). One ladder drives every corner:
//
//   app 22 ─ pad 8 ─► panel 14 ─ pad 6 ─► row 8 ─ pad 4 ─► chip 4

import { renderMarkdown } from "./markdown";

export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run My Agents</title><style>
@font-face{font-family:"Geist";src:url(fonts/geist.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{color-scheme:dark;--r-app:22px;--p1:8px;--r-panel:calc(var(--r-app) - var(--p1));--p2:6px;--r-row:calc(var(--r-panel) - var(--p2));--p3:4px;--r-chip:calc(var(--r-row) - var(--p3));
--text:#ececf1;--muted:rgba(236,236,241,.55);--line:rgba(255,255,255,.07);--green:#22c55e;--mint:#6ee7a0;--amber:#f59e0b;
--body:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box}html,body{height:100%;margin:0}
html{font-family:var(--body)}body{background:#06060a;color:var(--text);font:13px/1.5 var(--body);-webkit-font-smoothing:antialiased;padding:var(--p1)}
.app{height:100%;display:grid;grid-template-columns:30% minmax(0,1fr);gap:var(--p1);padding:var(--p1);border-radius:var(--r-app);background:linear-gradient(120deg,#0b0b12,#10101a,#0c1210,#0b0b12);background-size:300% 300%;animation:bg 14s ease infinite;box-shadow:inset 0 0 0 1px var(--line)}
@keyframes bg{50%{background-position:100% 50%}}
.side,.main{border-radius:var(--r-panel);background:rgba(18,18,26,.75);box-shadow:inset 0 0 0 1px var(--line);overflow:auto;padding:var(--p2)}
.main{display:flex;flex-direction:column;padding:0}
.proj{padding:8px 10px;font-weight:600;border-radius:var(--r-row);cursor:pointer;display:flex;justify-content:space-between;transition:background .2s}.proj:hover{background:#1e1e28}.proj small{font:11px var(--mono);color:var(--muted)}
.grp{font:11px var(--mono);color:var(--muted);margin:12px 10px 6px;cursor:pointer;user-select:none;transition:color .2s}.grp:hover{color:var(--text)}
.it{display:flex;align-items:center;gap:10px;padding:6px 8px;min-height:56px;border-radius:var(--r-row);cursor:pointer;transition:background .2s,transform .2s}
.it:hover{background:#1e1e28;transform:translateX(3px)}.it:active{transform:scale(.97)}
.it.sel{background:linear-gradient(90deg,#26263a,#1b1b25);box-shadow:inset 2px 0 0 var(--green)}
button,input,textarea,select{font-family:inherit}.nm::first-letter{font-weight:700;font-size:1.08em;color:var(--mint);letter-spacing:.01em}.it .t{min-width:0;flex:1}.nm{display:block;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--muted);margin:1px 0}.md{font:600 9px var(--mono);letter-spacing:.04em;border-radius:var(--r-chip);padding:1px 5px}
.meta{flex-wrap:wrap}
.rl{font:600 10px var(--mono);border-radius:var(--r-chip);padding:1px 6px}.it small{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.av{position:relative;flex:none;animation:bob 3s ease-in-out infinite;filter:drop-shadow(0 4px 4px rgba(0,0,0,.55));transition:transform .2s;cursor:pointer}
.av:hover{transform:scale(1.15) rotate(6deg)}.av{animation-duration:var(--spin,3s);animation-delay:var(--dl,0s)}
.av.low{animation:shake2 var(--shake,.5s) linear infinite;animation-delay:0s}
.av.wig{animation:wiggle var(--wig,1s) ease-in-out infinite;animation-delay:0s}.av.wig .pup{animation-duration:.9s}
@keyframes shake2{0%,100%{transform:translate(0,0) rotate(0)}15%{transform:translate(-2px,1px) rotate(-7deg)}30%{transform:translate(2px,-1px) rotate(6deg)}45%{transform:translate(-2px,-1px) rotate(-6deg)}60%{transform:translate(2px,1px) rotate(7deg)}75%{transform:translate(-1px,1px) rotate(-5deg)}}
@keyframes wiggle{0%,100%{transform:rotate(0) translateY(0)}25%{transform:rotate(-5deg) translateY(-1px)}75%{transform:rotate(5deg) translateY(-1px)}}
.av.low .pup{animation-duration:.5s}.av.low .lid{animation-duration:1.2s}
.av.low .dot{background:#f43f5e;animation:pulsey .5s infinite}
@keyframes shake{0%,100%{transform:translate(0,0) rotate(0)}20%{transform:translate(-2px,1px) rotate(-6deg)}40%{transform:translate(2px,-1px) rotate(6deg)}60%{transform:translate(-2px,-1px) rotate(-5deg)}80%{transform:translate(2px,1px) rotate(5deg)}}
.av.jump{animation:jump .6s ease}
@keyframes jump{30%{transform:translateY(-12px) scale(1.15) rotate(-10deg)}60%{transform:translateY(0) scale(.95)}}
@keyframes bob{50%{transform:translateY(-3px) rotate(-3deg)}}
.lid{transform-box:fill-box;transform-origin:center;animation:blink calc(var(--spin,3s)*1.5) infinite}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.08)}}
.pup{animation:look calc(var(--spin,3s)*1.7) ease-in-out infinite}
@keyframes look{0%,100%{transform:translate(0,0)}25%{transform:translate(-3px,0)}50%{transform:translate(3px,-2px)}75%{transform:translate(1px,2px)}}
.idle .pup{animation:none;transform:translate(0,3px)}
.dot{position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;border:2.5px solid #14141c}
.g{background:var(--green);animation:pulse 1.6s infinite}.y{background:var(--amber);animation:pulsey 1s infinite}.z{background:#55555f}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}100%{box-shadow:0 0 0 7px rgba(34,197,94,0)}}
@keyframes pulsey{0%{box-shadow:0 0 0 0 rgba(245,158,11,.7)}100%{box-shadow:0 0 0 8px rgba(245,158,11,0)}}
.badge{margin-left:auto;background:var(--amber);color:#2a1a00;font-size:11px;border-radius:999px;padding:0 6px;animation:pop 1.2s ease-in-out infinite}
@keyframes pop{50%{transform:scale(1.18)}}
.hd{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
.hd small{color:var(--muted);font:11px var(--mono)}
.hb{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.hb span{white-space:nowrap;font-size:11px;padding:4px 10px;border-radius:999px;background:#1d1d27;cursor:pointer;transition:background .2s,transform .2s}.hb span:hover{background:#2a2a38;transform:translateY(-1px)}
.feed{padding:var(--p2) 10px;display:flex;flex-direction:column;gap:4px;flex:1;overflow:auto}
.msg{display:flex;gap:10px;animation:in .4s ease both;padding:8px;border-radius:var(--r-row);cursor:pointer;transition:background .2s}.msg:hover{background:rgba(255,255,255,.04)}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
.msg time{color:var(--muted);font-size:11px;min-width:38px;padding-top:2px}
.msg p{margin:2px 0 0;color:#c9c9d3;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.msg.open p{-webkit-line-clamp:unset}
.tools{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.tool{font:11px var(--mono);border-radius:var(--r-chip);padding:3px 8px;color:var(--mint);background:linear-gradient(90deg,#1a1a22 0%,#23332a 50%,#1a1a22 100%);background-size:200% 100%;animation:shim 1.8s linear infinite;cursor:pointer;transition:color .2s}.tool:hover{color:#fff}
@keyframes shim{to{background-position:-200% 0}}
.warn{border:1px solid var(--amber);color:var(--amber);border-radius:var(--r-row);padding:8px 10px;font-size:12px;animation:glow 2s ease-in-out infinite;cursor:pointer;display:flex;justify-content:space-between;gap:10px;margin:var(--p2) 10px 0}.warn:hover{background:rgba(245,158,11,.15)}
@keyframes glow{50%{box-shadow:0 0 18px rgba(245,158,11,.35)}}
.typing{display:flex;gap:4px;padding:6px 0 6px 56px}.typing i{width:6px;height:6px;border-radius:50%;background:#8a8a99;animation:ty 1.2s infinite}.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}
@keyframes ty{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-5px);opacity:1}}
.box{margin:var(--p2);background:#1a1a22;border-radius:var(--r-row);padding:10px 12px;color:var(--muted);font:11px var(--mono);cursor:pointer;display:flex;justify-content:space-between;gap:10px;transition:background .2s,color .2s}.box:hover{background:#22222d;color:var(--text)}
.box span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.box b{display:inline-block;width:7px;height:13px;background:var(--mint);vertical-align:-2px;animation:cur 1s steps(1) infinite}@keyframes cur{50%{opacity:0}}
.toast{position:fixed;right:24px;bottom:24px;background:var(--green);color:#04120a;font-size:12px;padding:6px 12px;border-radius:var(--r-row);opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s;pointer-events:none}.toast.on{opacity:1;transform:none}
.ag{font:600 9px var(--mono);letter-spacing:.04em;border-radius:var(--r-chip);padding:1px 5px;background:#2a2340;color:#c4b5fd}.ag.codex{background:#123028;color:#6ee7b7}
.tok{font:10px var(--mono);color:var(--muted)}
.meter{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);font:11px var(--mono);color:var(--muted)}
.bar{flex:1;height:6px;border-radius:999px;background:#1d1d27;overflow:hidden}.bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green),var(--mint));transition:width .6s;background-size:200% 100%;animation:shim 2.4s linear infinite}
.bar.hot i{background:linear-gradient(90deg,var(--amber),#fb7185);background-size:200% 100%}
.btn{font:600 11px var(--body);padding:4px 10px;border-radius:999px;background:#1d1d27;color:var(--text);cursor:pointer;border:0;transition:background .2s,transform .2s}.btn:hover{background:#2a2a38;transform:translateY(-1px)}.btn.go{background:var(--amber);color:#2a1a00}.btn.go:hover{background:#fbbf24}
.panel{margin:var(--p2);padding:10px;border-radius:var(--r-row);background:#1a1a22;display:flex;flex-direction:column;gap:8px;font-size:12px;animation:in .3s ease both}
.panel input[type=number]{width:100%;background:#0f0f15;border:1px solid var(--line);border-radius:var(--r-chip);color:var(--text);padding:6px 8px;font:12px var(--mono)}
.panel label{display:flex;gap:8px;align-items:center;cursor:pointer;color:var(--muted)}.panel label:hover{color:var(--text)}
.skills{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:6px;padding:var(--p2) 10px;border-bottom:1px solid var(--line);animation:in .3s ease both}
.sk{padding:8px 10px;border-radius:var(--r-row);background:#1a1a22;cursor:pointer;transition:background .2s,transform .2s}.sk:hover{background:#23232e;transform:translateY(-2px)}
.sk b{font:600 12px var(--mono);color:var(--mint)}.sk p{margin:2px 0 0;color:var(--muted);font-size:11px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.compose{position:relative;margin:var(--p2);border-radius:var(--r-row);background:#0b0b10;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden;transition:box-shadow .3s}
.compose:focus-within{box-shadow:inset 0 0 0 1px rgba(110,231,183,.35),0 8px 24px -12px rgba(34,197,94,.5)}
.compose .row{position:relative;display:flex;gap:8px;align-items:flex-end;padding:2px 10px 10px 12px}
.compose .row>*{flex:none;height:28px;display:flex;align-items:center}
#msg{flex:1 1 auto;min-width:0;resize:none;border:0;outline:0;margin:0;padding:4px 0;box-sizing:border-box;height:28px;display:block;background:transparent;color:var(--text);font:14px/20px var(--body);max-height:160px;caret-color:var(--mint);overflow-y:auto}
#msg::placeholder{color:var(--muted)}
.glow{position:absolute;top:-30px;left:0;width:90px;height:90px;border-radius:50%;background:radial-gradient(circle,rgba(167,139,250,.32),rgba(56,189,248,.12) 45%,transparent 70%);pointer-events:none;opacity:0;transition:left .15s ease-out,top .15s ease-out,opacity .3s}
.compose:focus-within .glow{opacity:1}
.line{position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,#22c55e,#38bdf8,#a78bfa,#22c55e);background-size:200% 100%;animation:sweep 2.4s linear infinite;opacity:.35;transition:opacity .3s}
.compose:focus-within .line,.compose.hot .line{opacity:1;box-shadow:0 0 12px rgba(56,189,248,.6)}
@keyframes sweep{to{background-position:-200% 0}}
.fill{position:absolute;left:0;bottom:0;height:3px;width:0;background:rgba(255,255,255,.55);mix-blend-mode:overlay;transition:width .15s ease-out;pointer-events:none}
.sh{position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.07) 50%,transparent 70%);background-size:250% 100%;animation:shim2 2.6s linear infinite;pointer-events:none}
@keyframes shim2{from{background-position:150% 0}to{background-position:-100% 0}}
.ch{font:11px var(--mono);color:var(--muted);min-width:26px;justify-content:flex-end}
.eq{gap:3px;align-items:flex-end;padding-bottom:5px}.eq i{width:3px;height:4px;border-radius:2px;background:var(--mint);transition:height .2s}
.compose.hot .eq i{animation:eq .45s ease-in-out infinite alternate}.compose.hot .eq i:nth-child(2){animation-delay:.1s}.compose.hot .eq i:nth-child(3){animation-delay:.2s}.compose.hot .eq i:nth-child(4){animation-delay:.3s}
@keyframes eq{from{height:4px}to{height:18px}}
.sky{position:relative;height:20px;margin:0 10px;pointer-events:none}
.fairy{position:absolute;top:1px;left:0;width:30px;height:24px;scale:.7;transform-origin:left top;pointer-events:none;animation:fx 9s ease-in-out infinite alternate,fy 1.8s ease-in-out infinite alternate}
.fairy.f2{animation-duration:12s,2.3s;animation-delay:-5s,-1s}
@keyframes fx{from{left:0}to{left:calc(100% - 22px)}}@keyframes fy{from{translate:0 0}to{translate:0 3px}}
.fairy b{position:absolute;left:11px;top:10px;width:8px;height:8px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff,#fde68a 40%,#f59e0b);box-shadow:0 0 9px 3px rgba(253,230,138,.8)}
.fairy.f2 b{background:radial-gradient(circle at 35% 35%,#fff,#c4b5fd 45%,#8b5cf6);box-shadow:0 0 9px 3px rgba(196,181,253,.8)}
.fairy i{position:absolute;top:0;width:13px;height:17px;border-radius:60% 60% 50% 50%;background:linear-gradient(160deg,rgba(255,255,255,.55),rgba(186,230,253,.15));border:1px solid rgba(255,255,255,.4);transform-origin:bottom center;animation:flap .16s ease-in-out infinite alternate}
.fairy i.wl{left:3px;rotate:-28deg}.fairy i.wr{left:14px;rotate:28deg;animation-delay:.08s}
@keyframes flap{from{scale:1 1}to{scale:.35 1}}
.watch{width:28px;transition:transform .3s}.watch .ava{animation:none;filter:none}
.watch .pup{animation:none;transition:transform .15s ease-out}
.compose:focus-within .watch{transform:translateY(-2px) rotate(-4deg)}
.queue{display:flex;flex-direction:column;gap:4px;margin:0 0 6px}.queue:empty{display:none}.qi{display:flex;align-items:center;gap:8px;padding:5px 6px 5px 12px;border-radius:10px;background:#12121a;box-shadow:inset 0 0 0 1px var(--line);font-size:12px}.qt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}.qnow,.qx{border:0;border-radius:var(--r-chip);padding:4px 10px;font:600 11px var(--body);cursor:pointer;background:rgba(255,255,255,.06);color:var(--text)}.qnow:hover{background:var(--green);color:#04120a}.qx{padding:4px 8px;color:var(--muted)}
.send{border:0;border-radius:var(--r-chip);padding:7px 14px;font:600 12px var(--body);color:#04120a;background:var(--green);cursor:pointer;transition:transform .2s,background .2s}.send:hover{background:var(--mint);transform:translateY(-1px)}.send:disabled{opacity:.5;cursor:wait}
.rs{font:13px var(--mono);color:var(--muted);cursor:pointer;padding:0 4px}.rs:hover{color:var(--text)}
.sent{position:absolute;left:14px;top:10px;right:120px;font:13px/1.5 var(--body);color:var(--mint);white-space:nowrap;overflow:hidden;pointer-events:none;animation:up .6s ease-in forwards}@keyframes up{to{transform:translateY(-20px);opacity:0}}
.btn.new{background:var(--green);color:#04120a}.btn.new:hover{background:var(--mint)}
.side .btns{display:flex;gap:6px;flex-wrap:wrap;padding:0 6px}
.dlg{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center}.dlg[hidden]{display:none}
.dbg{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(3px)}
.dcard{position:relative;width:min(560px,92vw);max-height:92vh;overflow:auto;background:#14141c;border-radius:var(--r-app);padding:var(--p1);box-shadow:inset 0 0 0 1px var(--line),0 30px 80px rgba(0,0,0,.6);animation:in .25s ease both}
.dcard .in{background:#1a1a22;border-radius:var(--r-panel);padding:14px;display:flex;flex-direction:column;gap:10px}
.dcard h3{margin:0;font-size:15px}
.lbl{font:11px var(--mono);color:var(--muted);display:flex;gap:8px;align-items:center}.lbl em{color:var(--mint);font-style:normal}
#ntext{width:100%;resize:vertical;min-height:70px;max-height:200px;background:#0f0f15;border:1px solid var(--line);border-radius:var(--r-row);color:var(--text);padding:10px;font:13px/1.5 var(--body);outline:0}#ntext:focus{border-color:rgba(110,231,183,.45)}
.seg{display:flex;gap:6px;flex-wrap:wrap}.sg{padding:6px 12px;border-radius:var(--r-chip);background:#0f0f15;cursor:pointer;transition:background .2s;font-size:12px;border:1px solid transparent}.sg:hover{background:#23232e}.sg.on{border-color:var(--green);background:rgba(34,197,94,.12)}.sg.off{opacity:.45}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.rc{display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 4px;border-radius:999px;background:#0f0f15;cursor:pointer;font-size:12px;border:1px solid transparent;transition:background .2s,transform .2s}.rc:hover{background:#23232e;transform:translateY(-1px)}.rc.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 16%,transparent)}.rc em{font:600 9px var(--mono);font-style:normal;color:var(--mint);margin-left:2px}
.dcard select,.dcard input.f{background:#0f0f15;border:1px solid var(--line);border-radius:var(--r-row);color:var(--text);padding:7px 9px;font:12px var(--mono);outline:0;width:100%}
.dact{display:flex;gap:8px;justify-content:flex-end}
.roles{display:flex;flex-wrap:wrap;gap:6px;padding:var(--p2) 10px;border-bottom:1px solid var(--line);animation:in .3s ease both}
.cmenu{position:fixed;z-index:60;min-width:240px;max-width:320px;max-height:92vh;overflow:auto;padding:var(--p3);border-radius:var(--r-panel);background:#1a1a22;box-shadow:inset 0 0 0 1px var(--line),0 18px 50px rgba(0,0,0,.6);font-size:12.5px;transform-origin:top left;animation:mpop .14s ease-out both}
@keyframes mpop{from{opacity:0;transform:scale(.94) translateY(-4px)}}
.cmenu .mh{display:flex;gap:8px;align-items:center;padding:6px 8px 8px;margin-bottom:var(--p3);border-bottom:1px solid var(--line);font-weight:600}.cmenu .mh span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mi{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:6px 10px;border-radius:calc(var(--r-panel) - var(--p3));cursor:pointer;transition:background .15s,transform .15s}.mi:hover{background:#2a2a38;transform:translateX(2px)}
.mi em{font:11px var(--mono);color:var(--muted);font-style:normal}.mi.dng{color:#fb7185}
.msep{height:1px;background:var(--line);margin:var(--p3) 6px}
.msub{display:none;flex-wrap:wrap;gap:6px;padding:4px 8px 8px}.msub.on{display:flex}
.gx{--ro:20px;--ri:calc(var(--ro) - var(--p1));--rc:calc(var(--ri) - 6px)}
.gsv{display:block;width:100%;height:auto;overflow:visible}
.gc{border-radius:var(--ri);background:radial-gradient(120% 90% at 50% 0%,#262633,#15151d);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px var(--line);padding:8px 6px;text-align:center;min-width:0;transition:transform .25s,box-shadow .25s}
.gc:hover{transform:translateY(-2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),inset 0 0 0 1px rgba(110,231,183,.28),0 10px 24px -12px rgba(56,189,248,.45)}
.gc.off{opacity:.45}
.gcap{font:600 9px var(--mono);letter-spacing:.06em;color:var(--muted);margin-top:2px;text-transform:uppercase}.gcap b{display:block;font-size:12px;color:var(--text);letter-spacing:0}
.arc{stroke-dashoffset:calc(100 - var(--p));transition:stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)}
.gx:not(.live) .arc{--p:0}
.needle{--cur:var(--a);transform-origin:60px 62px;transform:rotate(var(--cur));transition:transform 1s cubic-bezier(.3,1.5,.5,1);filter:drop-shadow(0 0 3px rgba(255,255,255,.55))}
.gx:not(.live) .needle{--cur:-90deg}
.needle line{transform-origin:60px 62px}.needle.idle line{animation:sway 3.2s ease-in-out infinite}
@keyframes sway{50%{transform:rotate(1.8deg)}}
.needle.hot{animation:jit .18s linear infinite}@keyframes jit{50%{translate:.8px -.5px}}
.mdot{cursor:pointer;transform-box:fill-box;transform-origin:center;transition:transform .2s,filter .2s}.mdot:hover{transform:scale(1.6);filter:brightness(1.5)}
.mls{display:flex;justify-content:space-between;gap:4px;margin-top:4px}
.ml{flex:1;font:600 9px var(--mono);letter-spacing:.04em;padding:4px 0;border-radius:var(--rc);cursor:pointer;color:var(--muted);background:#12121a;transition:color .2s,background .2s,transform .2s,box-shadow .2s}.ml:hover{color:var(--text);transform:translateY(-2px);background:#1d1d29}
.ml.on{color:#06060a;background:var(--c);box-shadow:0 0 14px -2px var(--c);animation:glowp 2.2s ease-in-out infinite}@keyframes glowp{50%{box-shadow:0 0 20px 0 var(--c)}}
.leds{display:flex;gap:5px;align-items:flex-end;justify-content:center;height:64px;padding-top:6px}
.led{width:14px;border-radius:5px;background:#33334a;box-shadow:inset 0 1px 0 rgba(255,255,255,.08);cursor:pointer;transition:background .3s,box-shadow .3s,transform .2s;transition-delay:calc(var(--i)*70ms),calc(var(--i)*70ms),0s}
.led.on{background:var(--c);box-shadow:0 0 10px -1px var(--c);animation:ledp 2.4s ease-in-out infinite;animation-delay:calc(var(--i)*.15s)}@keyframes ledp{50%{filter:brightness(1.35)}}
.led:hover{transform:translateY(-3px) scaleY(1.06);filter:brightness(1.4)}
.gx:not(.live) .led.on{background:#33334a;box-shadow:none}
.elab{display:flex;justify-content:center;gap:5px;font:600 8px var(--mono);color:var(--muted);margin-top:3px}.elab span{width:14px;text-align:center;cursor:pointer;transition:color .2s,transform .2s}.elab span:hover{color:var(--text);transform:translateY(-1px)}
.autob{display:inline-block;margin-top:4px;font:600 8px var(--mono);letter-spacing:.06em;padding:2px 8px;border-radius:999px;background:#12121a;color:var(--muted);cursor:pointer;transition:background .2s,color .2s,transform .2s}.autob:hover{background:#23232e;color:var(--text);transform:translateY(-1px)}
.swr{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 9px;border-radius:var(--rc,8px);cursor:pointer;font-size:12px;transition:background .2s,transform .2s}.swr:hover{background:#1f1f2a;transform:translateX(2px)}
.swt{position:relative;flex:none;width:40px;height:22px;border-radius:999px;background:linear-gradient(#0d0d13,#1a1a24);box-shadow:inset 0 2px 4px rgba(0,0,0,.7),0 1px 0 rgba(255,255,255,.06);transition:background .3s,box-shadow .3s}
.swt b{position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#9aa0b4 55%,#5b6075);box-shadow:0 2px 4px rgba(0,0,0,.6);transition:transform .35s cubic-bezier(.3,1.6,.5,1)}
.swr:hover .swt b{filter:brightness(1.15)}
.swt.on{background:linear-gradient(#16a34a,#22c55e);box-shadow:inset 0 2px 4px rgba(0,0,0,.35),0 0 14px -2px #22c55e;animation:glowg 2.4s ease-in-out infinite}.swt.on b{transform:translateX(18px)}
@keyframes glowg{50%{box-shadow:inset 0 2px 4px rgba(0,0,0,.35),0 0 20px 0 #22c55e}}
.swg,.gcard{border-radius:var(--ri);background:#15151d;box-shadow:inset 0 0 0 1px var(--line);padding:4px}
.gt2{display:flex;flex-wrap:wrap;gap:5px;padding:2px 2px 4px}
.cmenu.gp{--ro:20px;width:min(348px,94vw);min-width:0;max-width:none;padding:var(--p1);border-radius:var(--ro);background:linear-gradient(160deg,#1d1d28,#11111a);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 26px 80px rgba(0,0,0,.75),0 0 60px -20px rgba(56,189,248,.28);display:flex;flex-direction:column;gap:6px;animation:gpop .42s cubic-bezier(.2,1.25,.4,1) both}
@keyframes gpop{from{opacity:0;transform:scale(calc(var(--fit,1) * .86)) translateY(-8px)}}
.gp>*{animation:in .4s ease both}.gp>*:nth-child(2){animation-delay:.05s}.gp>*:nth-child(3){animation-delay:.1s}.gp>*:nth-child(4){animation-delay:.15s}.gp>*:nth-child(5){animation-delay:.2s}.gp>*:nth-child(6){animation-delay:.25s}.gp>*:nth-child(7){animation-delay:.3s}
.gh{display:flex;gap:10px;align-items:center;padding:6px 8px;border-radius:var(--ri);background:linear-gradient(90deg,rgba(255,255,255,.06),transparent);transition:background .3s}.gh:hover{background:linear-gradient(90deg,rgba(110,231,183,.14),transparent)}
.gh b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}.gh .tags{display:flex;gap:5px;align-items:center;margin-top:3px;flex-wrap:wrap}
.gg2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.tl{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 2px;border-radius:var(--ri);background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px var(--line),0 3px 0 #0b0b10;cursor:pointer;font:600 9px var(--mono);color:var(--muted);transition:transform .15s,box-shadow .15s,color .2s}
.tl:hover{color:var(--mint);transform:translateY(-2px)}.tl:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px var(--line),0 0 0 #0b0b10}.tl svg{width:20px;height:20px;transition:transform .3s}.tl:hover svg{transform:scale(1.2) rotate(-6deg)}
.cpy{display:flex;gap:6px}.cb{flex:1;text-align:center;padding:7px 0;border-radius:var(--rc);background:#15151d;box-shadow:inset 0 0 0 1px var(--line);font:600 10px var(--mono);color:var(--muted);cursor:pointer;transition:background .2s,color .2s,transform .2s}.cb:hover{background:#23232e;color:var(--text);transform:translateY(-2px)}
.dcard{animation:dpop .45s cubic-bezier(.2,1.25,.4,1) both;--ro:var(--r-app)}@keyframes dpop{from{opacity:0;transform:scale(.88) translateY(14px)}}
.dbg{animation:fade .3s ease both}@keyframes fade{from{opacity:0}}
.dhd{display:flex;align-items:baseline;gap:10px}.dsub{font:11px var(--mono);color:var(--muted)}
.tbox,.fbox{position:relative;border-radius:var(--r-row);padding:1px;background:linear-gradient(120deg,#2a2a40,#1f3a2c,#2a2a40);background-size:300% 100%;animation:tflow 8s linear infinite;transition:box-shadow .3s}
.tbox:focus-within,.fbox:focus-within{animation-duration:2.5s;box-shadow:0 0 26px -6px rgba(110,231,183,.55)}
@keyframes tflow{to{background-position:-300% 0}}
.dcard .tbox #ntext{border:0;border-radius:calc(var(--r-row) - 1px);background:#0f0f15}
.dcard .fbox input.f{border:0;border-radius:calc(var(--r-row) - 1px);background:#0f0f15}
.fch{display:flex;flex-wrap:wrap;gap:6px}
.fc{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:#0f0f15;font:11px var(--mono);color:var(--muted);cursor:pointer;border:1px solid transparent;transition:background .2s,color .2s,transform .2s,border-color .2s,box-shadow .2s}
.fc:hover{background:#23232e;color:var(--text);transform:translateY(-2px)}.fc.on{border-color:var(--green);color:var(--text);background:rgba(34,197,94,.12);box-shadow:0 0 14px -4px var(--green)}
.nrow{display:grid;grid-template-columns:1.7fr 1fr;gap:8px}
.sg.on{animation:glowg2 2.4s ease-in-out infinite}@keyframes glowg2{50%{box-shadow:0 0 16px -3px var(--green)}}
.btn{position:relative;overflow:hidden}
.btn.new::after,.btn.go::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.45) 50%,transparent 70%);transform:translateX(-120%);transition:transform .6s;pointer-events:none}
.btn.new:hover::after,.btn.go:hover::after{transform:translateX(120%)}
.panel.lp{animation:none}
.lp .lnum{display:flex;align-items:center;justify-content:center;gap:12px}
.lbtn{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 3px 0 #0b0b10;cursor:pointer;font:600 16px var(--mono);user-select:none;transition:transform .15s,box-shadow .15s,color .2s}
.lbtn:hover{transform:translateY(-2px);color:var(--mint)}.lbtn:active{transform:translateY(2px);box-shadow:inset 0 0 0 1px var(--line),0 0 0 #0b0b10}
#limv{font:700 24px var(--mono);min-width:76px;text-align:center;text-shadow:0 0 14px rgba(110,231,183,.4)}#limv.bump{animation:bump .3s ease}@keyframes bump{40%{transform:scale(1.25);color:var(--mint)}}
.lchips{justify-content:center}
.dcard .chips .rc:nth-child(1){animation-delay:0.04s}.dcard .chips .rc:nth-child(2){animation-delay:0.07s}.dcard .chips .rc:nth-child(3){animation-delay:0.11s}.dcard .chips .rc:nth-child(4){animation-delay:0.14s}.dcard .chips .rc:nth-child(5){animation-delay:0.18s}.dcard .chips .rc:nth-child(6){animation-delay:0.21s}.dcard .chips .rc:nth-child(7){animation-delay:0.25s}.dcard .chips .rc:nth-child(8){animation-delay:0.28s}.dcard .chips .rc:nth-child(9){animation-delay:0.32s}.dcard .chips .rc:nth-child(10){animation-delay:0.35s}.dcard .chips .rc:nth-child(11){animation-delay:0.39s}.dcard .chips .rc:nth-child(12){animation-delay:0.42s}
.dcard .chips .rc{animation:in .4s ease both}
.ic{width:13px;height:13px;flex:none;transition:transform .3s}
.btn{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 3px 0 #0b0b10;color:var(--text);border:0;border-radius:999px;padding:7px 13px;font:600 11px var(--body);cursor:pointer;transition:transform .15s,box-shadow .15s,color .2s,filter .2s}
.btn:hover{transform:translateY(-2px);filter:brightness(1.18);background:linear-gradient(#232330,#17171f)}
.btn:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 0 0 #0b0b10}
.btn:hover .ic{transform:scale(1.25) rotate(90deg)}
.btn.new{background:linear-gradient(#34d27a,#22c55e);color:#04120a;box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 0 #15803d,0 8px 22px -8px rgba(34,197,94,.75)}.btn.new:hover{background:linear-gradient(#4ade80,#22c55e)}
.btn.go{background:linear-gradient(#fbbf24,#f59e0b);color:#2a1a00;box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 0 #b45309,0 8px 22px -8px rgba(245,158,11,.7)}.btn.go:hover{background:linear-gradient(#fcd34d,#f59e0b)}
.proj span{font-weight:700;background:linear-gradient(90deg,#fff,var(--mint),#38bdf8,#fff);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:tflow 7s linear infinite}
.cnt{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:#15151d;box-shadow:inset 0 0 0 1px var(--line);transition:color .2s,transform .2s,box-shadow .2s}
.cnt i{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.6s infinite}
.proj:hover .cnt{color:var(--text);transform:scale(1.07);box-shadow:inset 0 0 0 1px rgba(110,231,183,.4)}
.hd{position:relative;gap:12px;background:linear-gradient(90deg,rgba(255,255,255,.035),transparent 45%)}
.hd::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--green),#38bdf8,#a78bfa,transparent);background-size:200% 100%;animation:tflow 5s linear infinite;opacity:.75}
.hd .av{filter:drop-shadow(0 0 12px rgba(110,231,183,.45))}
.ht{min-width:0;flex:1}
.ttl{display:flex;gap:6px;align-items:baseline;font-size:14px;min-width:0}
.ttl b{font-weight:700;background:linear-gradient(90deg,#fff,var(--mint),#38bdf8,#fff);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:tflow 7s linear infinite}
.ttl i{color:var(--muted);font-style:normal}.ttl span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .2s}.ttl:hover span{color:var(--mint)}
.mchips{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
.mc{display:inline-flex;align-items:center;gap:5px;font:11px var(--mono);color:var(--muted);padding:2px 9px;border-radius:999px;background:#15151d;box-shadow:inset 0 0 0 1px var(--line);cursor:pointer;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background .2s,color .2s,transform .2s,box-shadow .2s}
.mc:hover{background:#23232e;color:var(--text);transform:translateY(-2px);box-shadow:inset 0 0 0 1px rgba(110,231,183,.38),0 6px 14px -8px rgba(110,231,183,.6)}.mc .ic{width:11px;height:11px}.mc:hover .ic{transform:scale(1.3)}
.hb{gap:7px}
.hb span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font:600 11px var(--body);padding:6px 12px;border-radius:999px;background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 3px 0 #0b0b10;color:var(--muted);cursor:pointer;position:relative;overflow:hidden;transition:transform .15s,box-shadow .15s,color .2s,background .3s}
.hb span::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.3) 50%,transparent 70%);transform:translateX(-120%);transition:transform .6s;pointer-events:none}
.hb span:hover{color:var(--text);transform:translateY(-2px);background:linear-gradient(#232330,#17171f)}.hb span:hover::after{transform:translateX(120%)}
.hb span:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 0 0 #0b0b10}
.hb span:hover .ic{transform:scale(1.25) rotate(-8deg)}
.hb span.on{color:#04120a;background:linear-gradient(var(--mint),var(--green));box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 0 #15803d,0 8px 22px -8px rgba(34,197,94,.75)}
.hb span[data-act="mute"].on{background:linear-gradient(#fbbf24,#f59e0b);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 0 #b45309,0 8px 22px -8px rgba(245,158,11,.7)}
.bar:hover i{filter:brightness(1.35)}
.msg time{transition:color .2s}.msg:hover time{color:var(--text)}
.rl,.ag,.md{transition:transform .2s,filter .2s}.rl:hover,.ag:hover,.md:hover{transform:translateY(-1px);filter:brightness(1.35)}
.clip{position:relative;width:28px;border-radius:50%;justify-content:center;background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 2px 0 #0b0b10;color:var(--muted);cursor:pointer;transition:transform .15s,color .2s,box-shadow .15s}
.clip .ic{width:15px;height:15px}.clip:hover{color:var(--mint);transform:translateY(-2px)}.clip:hover .ic{animation:wig .6s ease}
@keyframes wig{25%{transform:rotate(-18deg)}50%{transform:rotate(14deg)}75%{transform:rotate(-8deg)}}
.clip:active{transform:translateY(1px)}
.clip.has{color:#04120a;background:linear-gradient(var(--mint),var(--green))}
.clip b{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;padding:0 3px;border-radius:999px;background:var(--amber);color:#2a1a00;font:700 9px var(--mono);display:flex;align-items:center;justify-content:center;animation:pop 1.2s ease-in-out infinite}.clip b[hidden]{display:none}
.atray{display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px 0}.atray:empty{display:none}
.att{position:relative;display:inline-flex;align-items:center;gap:7px;max-width:230px;padding:4px 8px 4px 4px;border-radius:12px;background:#15151d;box-shadow:inset 0 0 0 1px var(--line);font:11px var(--mono);color:var(--text);overflow:hidden;animation:pop2 .35s cubic-bezier(.3,1.6,.5,1) both;transition:transform .2s,box-shadow .2s}
@keyframes pop2{from{opacity:0;transform:scale(.6) translateY(6px)}}
.att:hover{transform:translateY(-2px);box-shadow:inset 0 0 0 1px rgba(110,231,183,.4),0 8px 18px -10px rgba(110,231,183,.6)}
.att .th{width:26px;height:26px;border-radius:8px;background:#23232e center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--mint);flex:none}.att .th .ic{width:14px;height:14px}
.att .nm2{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.att small{color:var(--muted);font-size:10px}
.att .x{width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--muted);cursor:pointer;flex:none;transition:background .2s,color .2s,transform .2s}.att .x:hover{background:#f43f5e;color:#fff;transform:rotate(90deg)}
.att .pg{position:absolute;left:0;bottom:0;height:2px;background:linear-gradient(90deg,var(--green),#38bdf8);width:var(--w,0%);transition:width .2s}
.att.err{box-shadow:inset 0 0 0 1px #f43f5e}
#drop{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(6,6,10,.7);backdrop-filter:blur(4px);animation:fade .2s ease both}#drop[hidden]{display:none}
.dz{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 52px;border-radius:var(--r-app);border:2px dashed var(--mint);background:rgba(34,197,94,.08);color:var(--text);font-weight:600;animation:dzp 1.4s ease-in-out infinite}
.dz svg{width:46px;height:46px;color:var(--mint);animation:dzb 1s ease-in-out infinite}.dz small{color:var(--muted);font-weight:400}
@keyframes dzp{50%{box-shadow:0 0 50px -6px rgba(110,231,183,.55);transform:scale(1.02)}}@keyframes dzb{50%{transform:translateY(-8px) rotate(-10deg)}}
.cmenu.gp{max-height:none;overflow:visible;gap:5px;transform:scale(var(--fit,1));transform-origin:top left}
.gp .gc{padding:5px}.gp .leds{height:52px}.gp .dial{width:60%;margin:0 auto}.gp .tl{padding:6px 2px}.gp .cb{padding:5px 0}.gp .swr{padding:5px 9px}.gp .gh{padding:4px 8px}
.rich{margin-top:2px;color:#c9c9d3;overflow-wrap:anywhere;line-height:1.55}
.rich>*:first-child{margin-top:0}.rich>*:last-child{margin-bottom:0}
.rich p{display:block;-webkit-line-clamp:unset;white-space:normal;margin:0 0 7px;overflow:visible;color:inherit}
.rich strong{color:var(--text);font-weight:700}.rich em{color:#d8d8e4}
.rich code{font:12px var(--mono);background:#1a1a24;padding:1px 6px;border-radius:6px;color:#9ee8c0;transition:background .2s}.rich code:hover{background:#23232f}
.rich pre{position:relative;font-family:var(--mono);margin:6px 0 8px;padding:10px 12px;border-radius:12px;background:#0f0f15;box-shadow:inset 0 0 0 1px var(--line);overflow:auto}.rich pre code{display:block;background:none;padding:0;color:#d8e4dd;white-space:pre}
.rich .cpb{position:absolute;top:6px;right:6px;font:600 9px var(--mono);padding:2px 8px;border-radius:999px;background:#23232e;color:var(--muted);cursor:pointer;opacity:0;transform:translateY(-3px);transition:opacity .2s,transform .2s,background .2s,color .2s}.rich pre:hover .cpb{opacity:1;transform:none}.rich .cpb:hover{background:var(--green);color:#04120a}
.rich ul,.rich ol{margin:2px 0 8px;padding-left:22px}.rich li{margin:2px 0;transition:color .2s}.rich li:hover{color:var(--text)}.rich li::marker{color:var(--mint)}
.rich a{color:var(--mint);text-decoration:none;border-bottom:1px solid rgba(110,231,160,.35);transition:color .2s,border-color .2s}.rich a:hover{color:#fff;border-color:var(--mint)}
.rich blockquote{margin:4px 0 8px;padding:4px 12px;border-left:3px solid var(--green);color:var(--muted);background:rgba(34,197,94,.05);border-radius:0 10px 10px 0}
.rich table{border-collapse:separate;border-spacing:0;margin:6px 0 10px;font-size:12px;max-width:100%;display:block;overflow:auto}.rich th,.rich td{padding:5px 10px;border-bottom:1px solid var(--line);text-align:left}.rich th{color:var(--text);background:#16161e}.rich tr:hover td{background:rgba(255,255,255,.03)}
.rich .mh1,.rich .mh2,.rich .mh3,.rich .mh4{font-weight:700;color:var(--text);margin:8px 0 4px}.rich .mh1{font-size:15px}.rich .mh2{font-size:14px}.rich .mh3,.rich .mh4{font-size:13px}
.chev{margin-left:auto;width:18px;height:18px;border-radius:6px;cursor:pointer;position:relative;background:rgba(255,255,255,.04);transition:background .2s,transform .25s}.chev::before{content:"";position:absolute;left:5px;top:4px;width:5px;height:5px;border-right:1.6px solid var(--muted);border-bottom:1.6px solid var(--muted);transform:rotate(45deg);transition:border-color .2s}.chev:hover{background:rgba(110,231,160,.18)}.chev:hover::before{border-color:var(--mint)}
.msg.col .chev{transform:rotate(-90deg)}.msg.col .rich{max-height:1.55em;overflow:hidden;opacity:.7;-webkit-mask-image:linear-gradient(#000 40%,transparent)}.msg.col .tools,.msg.col .opts{display:none}
.msg .rich.long{max-height:30em;overflow:hidden;position:relative}.msg .rich.long::after{content:"Show more";position:absolute;left:0;right:0;bottom:0;padding:34px 0 2px;text-align:center;font:600 10px var(--mono);color:var(--mint);background:linear-gradient(transparent,#14141c 70%);cursor:pointer}
.msg.open .rich.long{max-height:none}.msg.open .rich.long::after{display:none}
.dz2{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.tl2{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 4px;border-radius:var(--ri);background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px var(--line),0 3px 0 #0b0b10;font:600 10px var(--mono);cursor:pointer;color:var(--muted);transition:transform .15s,box-shadow .15s,color .2s,background .3s}
.tl2 .ic{width:13px;height:13px}.tl2:hover{transform:translateY(-2px);color:var(--text)}.tl2:hover .ic{transform:scale(1.25) rotate(-8deg)}.tl2:active{transform:translateY(2px)}
.tl2.amb:hover{color:#fbbf24}.tl2.red:hover{color:#fb7185}.tl2.off{opacity:.5}
.tl2.red.arm{background:linear-gradient(#f43f5e,#be123c);color:#fff;animation:armp .6s ease-in-out infinite alternate}
@keyframes armp{to{box-shadow:0 0 18px 0 rgba(244,63,94,.7),inset 0 0 0 1px var(--line),0 3px 0 #881337}}
.tl2.red.arm::after{content:"";position:absolute;left:0;bottom:0;height:3px;background:#fff;animation:armbar 3s linear forwards}@keyframes armbar{from{width:100%}to{width:0}}
.tl2.nope{animation:nope .4s}@keyframes nope{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.cmenu.gp{width:min(288px,94vw);gap:4px}
.gp .gg2{gap:4px}.gp .gc{padding:3px 4px 4px}.gp .gg2 .gsv{width:78%;margin:0 auto}.gp .dial{width:46%}
.gp .leds{height:40px;gap:4px;padding-top:4px}.gp .led{width:11px}
.gp .gcap{font-size:8px;margin-top:1px}.gp .gcap b{font-size:10px}.gp .ml{font-size:8px;padding:3px 0}.gp .elab{font-size:7px}.gp .autob{font-size:7px;margin-top:2px}
.gp .swr{padding:3px 8px;font-size:11px}.gp .tl{padding:4px 2px;font-size:8px}.gp .tl svg{width:15px;height:15px}.gp .cb{padding:4px 0;font-size:9px}
.gp .gh{padding:3px 6px}.gp .gh b{font-size:12px}.gp .rc{font-size:10px;padding:2px 7px 2px 3px}.gp .gt2{gap:4px;padding:1px 1px 3px}
.feed{gap:10px;padding:var(--p2) 12px}
.msg{padding:0;background:none;display:flex;cursor:pointer}.msg:hover{background:none}
.msg.from-me{justify-content:flex-end}.msg.from-ag{justify-content:flex-start}
.bub{max-width:84%;min-width:0;padding:8px 12px 9px;border-radius:16px;position:relative;transition:transform .2s,box-shadow .2s,filter .2s}
.msg.from-me .bub{background:linear-gradient(#1e2638,#171d2b);border-top-right-radius:5px;box-shadow:inset 0 0 0 1px rgba(110,160,255,.12)}
.msg.from-ag .bub{background:linear-gradient(#18261f,#131d18);border-top-left-radius:5px;box-shadow:inset 0 0 0 1px rgba(110,231,160,.12)}
.bub:hover{transform:translateY(-1px);filter:brightness(1.1)}
.msg.from-me .bub:hover{box-shadow:inset 0 0 0 1px rgba(110,160,255,.38),0 10px 24px -14px rgba(110,160,255,.7)}.msg.from-ag .bub:hover{box-shadow:inset 0 0 0 1px rgba(110,231,160,.38),0 10px 24px -14px rgba(110,231,160,.7)}
.who{display:flex;gap:8px;align-items:baseline;margin-bottom:3px;font:600 10px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.msg.from-ag .who{justify-content:flex-end}.who b{font-weight:600;color:var(--text);opacity:.85}.who time{font-weight:400;opacity:.7;min-width:0;padding:0}
.msg.from-ag .tools{justify-content:flex-end}
.rich{font-size:14px}.rich code{font-size:13px}
.msg.from-me .rich.long::after{background:linear-gradient(transparent,#171d2b 70%)}.msg.from-ag .rich.long::after{background:linear-gradient(transparent,#131d18 70%)}
.typing{justify-content:flex-end;padding:2px 14px 6px 0}
.cmenu.gp{width:min(252px,94vw);gap:3px}
.gp .gg2 .gsv{width:66%}.gp .dial{width:38%}.gp .leds{height:30px;gap:3px;padding-top:2px}.gp .led{width:9px;border-radius:3px}
.gp .gc{padding:2px 3px 3px}.gp .gcap{font-size:7px}.gp .gcap b{font-size:9px}.gp .ml{font-size:7px;padding:2px 0}.gp .elab{display:none}.gp .autob{font-size:7px;margin-top:1px;padding:1px 6px}
.gp .swr{padding:2px 7px;font-size:10px}.gp .swt{width:32px;height:18px}.gp .swt b{width:14px;height:14px}.gp .swt.on b{transform:translateX(14px)}
.gp .tl{padding:3px 2px;font-size:7px;gap:1px}.gp .tl svg{width:13px;height:13px}.gp .cb{padding:3px 0;font-size:8px}
.gp .gh{padding:2px 5px}.gp .gh b{font-size:11px;max-width:170px}.gp .tl2{padding:4px 3px;font-size:9px}
.gp .gt2{gap:3px}.gp .rc{padding:2px 4px 2px 3px;font-size:9px}.gp .rc .rn{display:none}.gp .rc.on .rn{display:inline}
.it{position:relative;cursor:grab}.it:active{cursor:grabbing}
.it.dragging{opacity:.35;transform:scale(.97)}
.it.drop-before::before,.it.drop-after::after{content:"";position:absolute;left:8px;right:8px;height:3px;border-radius:3px;background:linear-gradient(90deg,var(--green),#38bdf8);box-shadow:0 0 12px var(--green);animation:dropp .5s ease-in-out infinite alternate;pointer-events:none}
.it.drop-before::before{top:-3px}.it.drop-after::after{bottom:-3px}
@keyframes dropp{to{opacity:.5}}
.grp.drop-into{color:var(--text);background:rgba(34,197,94,.12);border-radius:var(--r-row);animation:dropg .6s ease-in-out infinite alternate}
@keyframes dropg{from{box-shadow:0 0 10px -4px var(--green)}to{box-shadow:0 0 26px 0 var(--green)}}
body.dnd .grp[data-grp="Pinned"],body.dnd .grp[data-grp="Closed"]{outline:1px dashed rgba(110,231,160,.5);outline-offset:2px;border-radius:var(--r-row)}
.grp.phold{padding:8px 10px;border:1px dashed var(--line);border-radius:var(--r-row);font:11px var(--mono);color:var(--muted);transition:border-color .2s,color .2s,background .2s}.grp.phold:hover{border-color:rgba(110,231,160,.5);color:var(--text);background:rgba(34,197,94,.06)}
.it.moved{animation:moved .9s ease-out}
@keyframes moved{0%{box-shadow:0 0 0 0 rgba(110,231,160,.85),inset 2px 0 0 var(--green)}100%{box-shadow:0 0 0 16px rgba(110,231,160,0),inset 2px 0 0 var(--green)}}
.feed{gap:6px;padding:var(--p2) 10px}
.bub{max-width:94%;padding:6px 11px 7px;border-radius:14px}
.who{margin-bottom:1px;font-size:9px}
.rich{line-height:1.42}.rich p{margin:0 0 4px}
.rich ul,.rich ol{margin:1px 0 4px;padding-left:20px}.rich li{margin:0}
.rich pre{margin:4px 0 5px;padding:8px 10px}.rich blockquote{margin:2px 0 5px;padding:2px 10px}.rich table{margin:4px 0 6px}
.rich .mh1,.rich .mh2,.rich .mh3,.rich .mh4{margin:5px 0 2px}
.tools{gap:3px;margin-top:3px}
.tool{font-size:9px;line-height:1.5;padding:0 6px;border-radius:6px}.tool b{margin-left:3px;font-weight:700;opacity:.65}
.typing{padding:0 14px 4px 0}
.md[data-mpick]{cursor:pointer}.md[data-mpick]:hover{filter:brightness(1.45);transform:translateY(-1px)}
.md.nx{background:transparent!important;box-shadow:inset 0 0 0 1px currentColor;animation:glowp 2.2s ease-in-out infinite;--c:currentColor}
.cmenu.mpop{width:216px;padding:8px;border-radius:14px;background:linear-gradient(160deg,#1d1d28,#11111a);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 22px 60px rgba(0,0,0,.7);animation:gpop .3s cubic-bezier(.2,1.25,.4,1) both}
.mpop .mnote{margin-top:6px;font-size:10px;line-height:1.35;color:var(--muted)}
.prpop{position:fixed;z-index:65;width:min(340px,92vw);padding:6px;border-radius:16px;background:linear-gradient(160deg,#1d1d28,#11111a);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 22px 60px rgba(0,0,0,.7);animation:gpop .25s cubic-bezier(.2,1.25,.4,1) both}
.prh{display:flex;align-items:center;gap:8px;padding:6px 8px;font-weight:600;font-size:12px}.prh em{margin-left:auto;font:10px var(--mono);color:var(--muted);font-style:normal;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prb{display:flex;flex-direction:column;gap:3px;max-height:260px;overflow:auto}
.prr{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"i t s" "i m s";gap:0 8px;align-items:center;padding:6px 8px;border-radius:11px;background:#15151d;color:var(--text);text-decoration:none;transition:transform .15s,background .2s;animation:in .3s ease both;animation-delay:calc(var(--i)*50ms)}
.prr:hover{background:#23232e;transform:translateX(3px)}
.prr .ic{grid-area:i;width:15px;height:15px}.prr.open .ic{color:#4ade80}.prr.merged .ic{color:#a78bfa}.prr.closed .ic{color:#f87171}
.prt{grid-area:t;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prt b{color:var(--mint)}
.prr small{grid-area:m;color:var(--muted);font:10px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prs{grid-area:s;font:600 9px var(--mono);font-style:normal;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.06)}
.prr.open .prs{color:#4ade80;background:rgba(74,222,128,.12)}.prr.merged .prs{color:#c4b5fd;background:rgba(167,139,250,.14)}.prr.closed .prs{color:#fca5a5;background:rgba(248,113,113,.12)}
.prsk{height:34px;border-radius:11px;background:linear-gradient(90deg,#15151d,#23232e,#15151d);background-size:200% 100%;animation:tflow 1.2s linear infinite}
.pre{padding:10px;color:var(--muted);font-size:12px}
.prn{margin-left:4px;font:600 9px var(--mono);padding:0 5px;border-radius:999px;background:var(--mint);color:#04120a}
.main{position:relative}
.newpill{position:absolute;left:50%;bottom:78px;transform:translate(-50%,10px);opacity:0;pointer-events:none;padding:6px 14px;border-radius:999px;background:linear-gradient(#34d27a,#22c55e);color:#04120a;font:600 11px var(--body);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 0 #15803d,0 10px 24px -8px rgba(34,197,94,.7);cursor:pointer;transition:opacity .25s,transform .25s;z-index:5}
.newpill.on{opacity:1;transform:translate(-50%,0);pointer-events:auto;animation:nbob 1.6s ease-in-out infinite}
@keyframes nbob{50%{transform:translate(-50%,-3px)}}
.opts{margin-top:6px;padding:8px;border-radius:12px;background:rgba(0,0,0,.28);box-shadow:inset 0 0 0 1px var(--line);animation:in .35s ease both}
.orec{color:var(--muted);font-size:13px;line-height:1.4;margin-bottom:6px}.orec p{margin:0}
.oask{font-weight:600;font-size:13px;margin-bottom:6px;color:var(--text)}
.obtns{display:flex;flex-wrap:wrap;gap:6px}
.obtn{display:inline-flex;align-items:center;gap:8px;padding:7px 13px;border-radius:999px;background:linear-gradient(#232330,#17171f);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 3px 0 #0b0b10;color:var(--text);font:600 12px var(--body);cursor:pointer;position:relative;overflow:hidden;transition:transform .15s,box-shadow .15s,filter .2s,opacity .3s}
.obtn::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.3) 50%,transparent 70%);transform:translateX(-120%);transition:transform .6s;pointer-events:none}
.obtn:hover{transform:translateY(-2px);filter:brightness(1.18)}.obtn:hover::after{transform:translateX(120%)}.obtn:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px var(--line),0 0 0 #0b0b10}
.obtn.first{background:linear-gradient(#34d27a,#22c55e);color:#04120a;box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 0 #15803d,0 8px 22px -8px rgba(34,197,94,.75)}
.obtn kbd{font:600 9px var(--mono);padding:1px 5px;border-radius:6px;background:rgba(0,0,0,.22);color:inherit;opacity:.8}
.obtn.done{opacity:.4;pointer-events:none}.obtn.picked{opacity:1;animation:pickd .5s ease}
@keyframes pickd{40%{transform:scale(1.08)}}
.empty{color:var(--muted);text-align:center;margin:auto;padding:40px}
@media (max-width:720px){.app{grid-template-columns:1fr}.side{max-height:40vh}}
</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs>
<radialGradient id="sh" cx="35%" cy="28%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
<radialGradient id="eye" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cfd3e0"/></radialGradient>
<linearGradient id="gz" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="110" y2="0"><stop offset="0" stop-color="#22c55e"/><stop offset=".55" stop-color="#6ee7a0"/><stop offset=".72" stop-color="#f59e0b"/><stop offset="1" stop-color="#f43f5e"/></linearGradient>
<linearGradient id="gm" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="110" y2="0"><stop offset="0" stop-color="#a1a1b3"/><stop offset=".3" stop-color="#6ee7a0"/><stop offset=".65" stop-color="#38bdf8"/><stop offset="1" stop-color="#fbbf24"/></linearGradient>
<radialGradient id="hub" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#8a90a6"/><stop offset="1" stop-color="#3a3f52"/></radialGradient>
</defs></svg>
<div class="app"><nav class="side" id="side"></nav><main class="main"><div class="hd" id="hd"></div><div id="meter"></div><div id="skills"></div><div id="roles"></div><div id="warns"></div><div class="feed" id="feed"></div><div class="newpill" id="newpill" data-act="tobottom">\u2193 New messages</div><div class="box" id="box"></div></main></div>
<div class="toast" id="toast"></div>
<div class="dlg" id="dlg" hidden></div>
<div id="drop" hidden><div class="dz"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg><span id="dzt">Drop files to attach</span><small>up to 10 files, 25 MB each</small></div></div>
<input type="file" id="fin" multiple hidden>
<script>
const renderMarkdown=${renderMarkdown.toString()};
const SH={circle:c=>'<circle cx="32" cy="32" r="28" fill="'+c+'"/><circle cx="32" cy="32" r="28" fill="url(#sh)"/>',
square:c=>'<rect x="5" y="5" width="54" height="54" rx="12" fill="'+c+'"/><rect x="5" y="5" width="54" height="54" rx="12" fill="url(#sh)"/>',
pill:c=>'<rect x="2" y="12" width="60" height="40" rx="20" fill="'+c+'"/><rect x="2" y="12" width="60" height="40" rx="20" fill="url(#sh)"/>',
tall:c=>'<rect x="12" y="2" width="40" height="60" rx="10" fill="'+c+'"/><rect x="12" y="2" width="40" height="60" rx="10" fill="url(#sh)"/>',
blob:c=>'<path d="M32 4c14 0 28 8 27 26s-9 30-27 30S4 50 5 30 18 4 32 4z" fill="'+c+'"/><path d="M32 4c14 0 28 8 27 26s-9 30-27 30S4 50 5 30 18 4 32 4z" fill="url(#sh)"/>'};
const K='#0b0b10',W='url(#eye)';
const EY={dots:'<g class="lid"><g class="pup"><circle cx="22" cy="30" r="4.5" fill="'+K+'"/><circle cx="42" cy="30" r="4.5" fill="'+K+'"/></g></g>',
wide:'<g class="lid"><circle cx="22" cy="30" r="8" fill="'+W+'"/><circle cx="42" cy="30" r="8" fill="'+W+'"/><g class="pup"><circle cx="22" cy="30" r="3.5" fill="'+K+'"/><circle cx="42" cy="30" r="3.5" fill="'+K+'"/></g></g>',
ovals:'<g class="lid"><ellipse cx="22" cy="30" rx="6" ry="9" fill="'+W+'"/><ellipse cx="42" cy="30" rx="6" ry="9" fill="'+W+'"/><g class="pup"><ellipse cx="22" cy="30" rx="3" ry="4.5" fill="'+K+'"/><ellipse cx="42" cy="30" rx="3" ry="4.5" fill="'+K+'"/><circle cx="23" cy="28" r="1.1" fill="#fff"/><circle cx="43" cy="28" r="1.1" fill="#fff"/></g></g>',
sleepy:'<path d="M15 30h14v3a7 5 0 0 1-14 0z" fill="'+W+'"/><path d="M35 30h14v3a7 5 0 0 1-14 0z" fill="'+W+'"/><g class="pup"><circle cx="22" cy="33" r="2.5" fill="'+K+'"/><circle cx="42" cy="33" r="2.5" fill="'+K+'"/></g><path d="M14 30h16M34 30h16" stroke="'+K+'" stroke-width="2.5" stroke-linecap="round"/>',
visor:'<rect x="12" y="22" width="40" height="16" rx="8" fill="'+K+'"/><g class="pup"><rect x="18" y="27" width="8" height="6" rx="2" fill="#7dd3fc"/><rect x="38" y="27" width="8" height="6" rx="2" fill="#7dd3fc"/></g>',
cyclops:'<g class="lid"><circle cx="32" cy="30" r="12" fill="'+W+'"/><g class="pup"><circle cx="32" cy="30" r="5.5" fill="'+K+'"/><circle cx="34" cy="28" r="1.6" fill="#fff"/></g></g>',
happy:'<g class="pup"><path d="M16 32q6-9 12 0M36 32q6-9 12 0" fill="none" stroke="'+K+'" stroke-width="3.5" stroke-linecap="round"/></g>',
bars:'<g class="lid"><g class="pup"><rect x="20" y="23" width="4" height="13" rx="2" fill="'+K+'"/><rect x="40" y="23" width="4" height="13" rx="2" fill="'+K+'"/></g></g>',
squint:'<g class="lid"><rect x="15" y="27" width="14" height="7" rx="3.5" fill="'+W+'"/><rect x="35" y="27" width="14" height="7" rx="3.5" fill="'+W+'"/><g class="pup"><rect x="20" y="28" width="4" height="5" rx="1.5" fill="'+K+'"/><rect x="40" y="28" width="4" height="5" rx="1.5" fill="'+K+'"/></g></g>'};
let BUILD0="",composerFor="",S=[],C=[],L={sessionTokens:0,autoDowngrade:false},showLimits=false,showSkills=false,last="",feedKey="",sel=localStorage.getItem("rma-sel"),fold={Closed:true},seen={},paused={},muted={},first=true;
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const ago=ms=>{const s=Math.round(ms/1e3);return s<60?s+"s":s<3600?Math.round(s/60)+" min":Math.round(s/3600)+" h"};
const limLabel=n=>n>=1e6?(n%1e5===0?(n/1e6).toFixed(1):(n/1e6).toFixed(2))+"M":n>=1e3?Math.round(n/1e3)+"k":String(n);
const kt=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?Math.round(n/1e3)+"k":String(n);
const post=(u,b)=>fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
const TIER={opus:"#fbbf24",sonnet:"#38bdf8",haiku:"#6ee7a0"};
function mdl(m){m=(m||"").toLowerCase();const t=/opus|sonnet|haiku/.exec(m);if(t)return{label:t[0].toUpperCase(),color:TIER[t[0]]};const g=/gpt-?(\\d+)/.exec(m);return m?{label:g?"GPT-"+g[1]:m.slice(0,8).toUpperCase(),color:"#6ee7b7"}:null}
function mtag(s){const m=mdl(s.model),want=s.tune&&s.tune.model,tier=/opus|sonnet|haiku/.exec((s.model||"").toLowerCase());
 const base=m?'<span class="md" data-mpick="'+s.id+'" title="'+esc(s.model)+' \u00b7 click to change" style="color:'+m.color+';background:color-mix(in srgb,'+m.color+' 16%,transparent)">'+m.label+"</span>":"";
 const next=want&&(!tier||tier[0]!==want)?'<span class="md nx" data-mpick="'+s.id+'" title="The next message you send from the board uses '+want+'" style="color:'+(TIER[want]||"#fff")+'">&rarr; '+want.toUpperCase()+"</span>":"";
 return base+next}
function motion(s){const h=[...s.id].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0,7);const age=Date.now()-s.updatedAt;
 /* every agent has its own base rate; recent work speeds it up, idling slows it down */
 const base=2.2+(h%20)/10,act=age<10000?.5:age<120000?.8:1.7;
 /* tokens spent against the limit, or against 2M when none is set, so a busy agent shows it without a limit too */
 const p=s.tokens.used/(L.sessionTokens||2000000);
 /* from 30% it wiggles, faster as it fills; from 70% it shakes: 1s at 70%, 0.4s from 400% on */
 const low=p>=.7,wig=!low&&p>=.3,shake=Math.max(.4,1-Math.min(1,(p-.7)/3.3)*.6),wg=Math.max(1.2,2.4-Math.min(1,(p-.3)/.4)*1.2);
 return{style:"--spin:"+(base*act).toFixed(2)+"s;--dl:-"+((h%37)/10).toFixed(1)+"s;"+(low?"--shake:"+shake.toFixed(2)+"s;":"")+(wig?"--wig:"+wg.toFixed(2)+"s;":""),low,wig}}
const hm=t=>new Date(t).toTimeString().slice(0,5);
function toast(t){const el=$("toast");el.textContent=t;el.classList.add("on");clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove("on"),1400)}
const state=s=>C.some(c=>c.sessions.includes(s.id))?"y":Date.now()-s.updatedAt<120000?"g":"z";
const GROUPS=[["Pinned",s=>!s.hidden&&s.pinned],["Working",s=>!s.hidden&&!s.pinned&&s.viaApp!==false&&state(s)!=="z"],["Idle",s=>!s.hidden&&!s.pinned&&s.viaApp!==false&&state(s)==="z"],["Not in the Claude app",s=>!s.hidden&&!s.pinned&&s.viaApp===false],["Closed",s=>s.hidden]];
const groupName=s=>(GROUPS.find(g=>g[1](s))||[""])[0];
function face(s,n){const f=s.face,m=motion(s);return '<div class="av'+(m.low?" low":m.wig?" wig":"")+'" data-face="'+s.id+'" style="width:'+n+'px;height:'+n+'px;'+m.style+'"><svg width="'+n+'" height="'+n+'" viewBox="0 0 64 64">'+SH[f.shape](f.color)+EY[f.eyes]+'</svg>'+(n>32?'<span class="dot '+state(s)+'"></span>':"")+"</div>"}
function render(){
 if(!S.length){$("side").innerHTML='<div class="proj">Run My Agents</div><div class="btns"><button class="btn new" data-act="newopen">'+ico(IC.plus)+'New session</button></div>';$("hd").innerHTML="";$("warns").innerHTML="";$("feed").innerHTML='<p class="empty">No Claude Code sessions in the last hour. Start one and it shows up here.</p>';$("box").innerHTML="";return}
 if(!S.find(s=>s.id===sel))sel=S[0].id;
 const groups=GROUPS;
 const oldRows=snapRows();
 $("side").innerHTML='<div class="proj" data-act="proj"><span>Run My Agents</span><small class="cnt"><i></i>'+S.filter(s=>!s.hidden).length+" agents</small></div>"+'<div class="btns"><button class="btn new" data-act="newopen">'+ico(IC.plus)+'New session</button><button class="btn" data-act="limits">'+ico(IC.gauge)+(L.sessionTokens?"Limit "+limLabel(L.sessionTokens)+" per session":"Set token limit")+"</button></div>"+(showLimits?limPanel():"")+groups.map(([g,f])=>{const xs=ordSort(S.filter(f));if(!xs.length){return g==="Pinned"?'<div class="grp phold" data-grp="Pinned">Drag an agent here to pin it</div>':""}return '<div class="grp" data-grp="'+g+'">'+(fold[g]?"▸":"▾")+" "+g+" · "+xs.length+"</div>"+(fold[g]?"":xs.map(s=>{const unread=(s.feed.length-(seen[s.id]??s.feed.length));return '<div class="it '+(s.id===sel?"sel ":"")+(state(s)==="z"?"idle ":"")+(s.id===movedId?"moved":"")+'" data-sel="'+s.id+'" draggable="true">'+face(s,36)+'<div class="t"><b class="nm">'+esc(s.title||"Untitled session")+'</b><span class="meta"><span class="rl" style="color:'+s.face.color+';background:color-mix(in srgb,'+s.face.color+' 18%,transparent)">'+esc(s.role)+'</span><span class="ag '+s.agent+'">'+(s.agent==="codex"?"CODEX":"CLAUDE")+"</span>"+mtag(s)+ago(Date.now()-s.updatedAt)+"</span><small>"+[esc(s.doing||""),kt(s.tokens.used)+" tok"+(L.sessionTokens?" / "+kt(L.sessionTokens):"")].filter(Boolean).join(" · ")+"</small></div>"+(unread>0&&s.id!==sel?'<span class="badge">'+unread+"</span>":"")+"</div>"}).join(""))}).join("");
 flip(oldRows);if(movedId){const mv=movedId;movedId="";setTimeout(()=>{const r=document.querySelector('#side .it[data-sel="'+mv+'"]');if(r)r.classList.remove("moved")},900)}
 const s=S.find(x=>x.id===sel);seen[s.id]=s.feed.length;
 $("hd").innerHTML=face(s,34)+'<div class="ht"><div class="ttl"><b>'+esc(s.role)+'</b><i>&middot;</i><span title="'+esc(s.title||"Untitled")+'">'+esc(s.title||"Untitled")+'</span></div><div class="mchips">'+(s.branch||(s.prs&&s.prs.length)?'<span class="mc" data-ctext="'+esc(s.branch||"")+'" data-prs="'+s.id+'" title="Click to copy the branch. Hover for pull requests">'+ico(IC.branch)+esc(s.branch||"pull requests")+(s.prs&&s.prs.length?'<b class="prn">'+s.prs.length+" PR"+(s.prs.length>1?"s":"")+"</b>":"")+"</span>":"")+'<span class="mc" data-ctext="'+esc(s.cwd)+'" title="Copy folder path">'+ico(IC.folder)+esc(s.cwd.split("/").pop()||"")+'</span><span class="mc" data-ctext="'+esc(s.id)+'" title="Copy session ID">'+ico(IC.hash)+"session "+s.id.slice(0,8)+'</span></div></div><div class="hb">'+hb("pin",s.pinned?"Unpin":"Pin",ico(IC.pin),s.pinned)+hb("roles","Type: "+s.role,mini(s.face,14),showRoles)+hb("skills","Skills",ico(IC.star),showSkills)+hb("files","Files",ico(IC.files),false)+hb("mute",muted[s.id]?"Unmute":"Mute",ico(IC.bell),muted[s.id])+"</div>";
 const over=L.sessionTokens&&s.tokens.used>=L.sessionTokens,pct=L.sessionTokens?Math.min(100,s.tokens.used/L.sessionTokens*100):0;
 $("meter").innerHTML='<div class="meter"><span>'+(mtag(s)||esc(s.agent))+"</span>"+(L.sessionTokens?'<div class="bar'+(over?" hot":"")+'"><i style="width:'+pct+'%"></i></div><span>'+kt(s.tokens.used)+" / "+kt(L.sessionTokens)+"</span>":'<span style="flex:1">'+kt(s.tokens.used)+" tokens · "+kt(s.tokens.cached)+" cached</span>")+(s.lower?'<button class="btn'+(over?" go":"")+'" data-act="down">Move to '+s.lower+"</button>":"")+"</div>";
 $("skills").innerHTML=showSkills?'<div class="skills">'+s.skills.map(k=>'<div class="sk" data-skill="'+esc(k.name)+'" title="'+esc(k.source+"/"+k.path)+'"><b>/'+esc(k.name)+"</b><p>"+esc(k.what)+"</p></div>").join("")+"</div>":"";
 $("roles").innerHTML=showRoles&&OPT?'<div class="roles"><span class="rc'+(s.roleSet?"":" on")+'" data-act="setrole" data-role="" style="--c:#8a8a99">Auto</span>'+chips(s.roleSet?s.role:"","","setrole")+"</div>":"";
 const mine=C.filter(c=>c.sessions.includes(s.id));
 $("warns").innerHTML=mine.filter(c=>!muted[s.id]).map(c=>{const other=c.sessions.filter(x=>x!==s.id).map(x=>(S.find(y=>y.id===x)||{role:"another session"}).role).join(", ");return '<div class="warn" data-act="go" data-file="'+esc(c.file)+'" data-other="'+c.sessions.find(x=>x!==s.id)+'"><span>⚠ '+esc(other)+" also edited "+esc(c.file.split("/").pop())+" in the last 10 min</span><span>Open "+esc(other)+"</span></div>"}).join("");
 const feed=$("feed"),stick=feed.scrollTop+feed.clientHeight>=feed.scrollHeight-40;
 const key=s.id+":"+s.feed.length+":"+(s.feed.at(-1)?.at??0)+":"+COL.size+":"+state(s)+":"+(s.sending?1:0);
 if(key!==feedKey){const sc=feedKey.split(":")[0]!==s.id;feedKey=key;
 feed.innerHTML=s.feed.map((m,mi)=>{const ck=s.id+":"+(m.t0||m.at);return '<div class="msg '+(m.who==="you"?"from-me":"from-ag")+(COL.has(ck)?" col":"")+'" data-msg><div class="bub"><div class="who"><b>'+(m.who==="you"?"You":esc(s.role))+"</b><time>"+hm(m.at)+"</time>"+(m.who==="agent"?'<span class="chev" data-col="'+ck+'" title="Collapse or expand this reply"></span>':"")+"</div>"+(m.text?'<div class="rich'+(m.text.length>9000?" long":"")+'">'+renderMarkdown(m.text)+"</div>":"")+(m.tools.length?'<div class="tools">'+toolRuns(m.tools)+"</div>":"")+(m.options&&mi===s.feed.length-1&&!s.sending?optsHtml(m.options):"")+"</div></div>"}).join("")+(state(s)==="g"?'<div class="typing"><i></i><i></i><i></i></div>':"");
 if(stick||first||sc)feed.scrollTop=feed.scrollHeight;else armScroll()}
 if(composerFor!==s.id){composerFor=s.id;$("box").outerHTML='<div class="compose" id="box"><i class="glow"></i><i class="sh"></i><i class="line"></i><i class="fill"></i><div class="sky"><div class="fairy"><i class="wl"></i><i class="wr"></i><b></b></div><div class="fairy f2"><i class="wl"></i><i class="wr"></i><b></b></div></div><div class="atray" id="atray"></div><div class="row"><div class="watch">'+face(s,28)+'</div><span class="clip" data-act="attach" title="Attach files (or drop them anywhere)">'+ico(IC.clip)+'<b id="clipn" hidden>0</b></span><textarea id="msg" rows="1" placeholder="Message '+esc(s.role)+(s.agent==="codex"?" (Codex)":"")+(s.viaApp===true?" \u00b7 separate copy":"")+'…" title="'+(s.viaApp===true?"This session is open in the Claude app. A message from here runs a separate copy of it, which the app does not show live.":"Message this agent")+'"></textarea><span class="ch" id="ch">0</span><div class="eq"><i></i><i></i><i></i><i></i></div><span class="rs" data-act="resume" title="Copy the resume command">⧉</span><button class="send" data-act="send">Send</button></div></div>';restoreDraft(s.id);drawTray()}
 const sb=document.querySelector(".send");if(sb){sb.disabled=false;sb.textContent=s.sending?"Queue":"Send"}
 let qe=$("queue");if(!qe&&$("box")){qe=document.createElement("div");qe.id="queue";qe.className="queue";$("box").before(qe)}
 if(qe){const q=s.queue||[],qk=s.id+":"+q.map(x=>x.qid).join(",");if(qe.dataset.k!==qk){qe.dataset.k=qk;qe.innerHTML=q.map(x=>'<div class="qi"><span class="qt">'+esc(x.text)+'</span><button class="qnow" data-qnow="'+x.qid+'">Send now</button><button class="qx" data-qdrop="'+x.qid+'" title="Remove from queue">×</button></div>').join("")}}
 first=false;
}
async function load(){if(dragId||(showLimits&&document.activeElement?.id==="lim"))return;try{const r=await fetch("api/sessions");const t=await r.text();if(t===last)return;last=t;const j=JSON.parse(t);if(j.build){if(!BUILD0)BUILD0=j.build;else if(j.build!==BUILD0){location.reload();return}}S=j.sessions;C=j.clashes;L=j.limits;ORDER=j.order||[];if(wantSel&&S.find(x=>x.id===wantSel)){sel=wantSel;first=true;wantSel=""}render()}catch{}}
document.addEventListener("click",e=>{
 const mp=e.target.closest("[data-mpick]");if(mp){e.stopImmediatePropagation();const s0=S.find(x=>x.id===mp.dataset.mpick);if(!s0)return;if(s0.agent!=="claude"){toast("Model applies to Claude Code agents");return}showModelPick(mp,s0);return}
 const f=e.target.closest("[data-face]");if(f){f.classList.remove("jump");void f.offsetWidth;f.classList.add("jump");const s=S.find(x=>x.id===f.dataset.face);if(s)toast(s.role+": "+(s.doing||"here"));e.stopPropagation();return}
 const it=e.target.closest("[data-sel]");if(it){sel=it.dataset.sel;try{localStorage.setItem("rma-sel",sel)}catch{}first=true;render();return}
 const g=e.target.closest("[data-grp]");if(g){fold[g.dataset.grp]=!fold[g.dataset.grp];render();return}
 const s=S.find(x=>x.id===sel),a=e.target.closest("[data-act]");
 if(a){const k=a.dataset.act;
  if(k==="go"){sel=a.dataset.other;first=true;render()}
  else if(k==="mute"){muted[s.id]=!muted[s.id];render();toast(muted[s.id]?"Clash warnings hidden for "+s.role:"Clash warnings shown")}
  else if(k==="files"){const fs=[...new Set(s.edits.map(x=>x.file.split("/").pop()))];toast(fs.length?s.role+" edited "+fs.slice(-5).join(", "):s.role+" hasn't edited files")}
  else if(k==="tool"){const tn=(a.title||a.textContent).replace(/ \u00d7\d+$/,"");navigator.clipboard?.writeText(tn).catch(()=>{});toast("Copied "+tn)}
  else if(k==="proj"){last="";load();toast("Refreshed")}
  else if(k==="limits"){showLimits=!showLimits;if(showLimits)LIM={tokens:L.sessionTokens,auto:L.autoDowngrade};render()}
  else if(k==="save"){post("api/limits",{sessionTokens:LIM.tokens,autoDowngrade:LIM.auto}).then(l=>{L=l;showLimits=false;last="";render();toast(l.sessionTokens?"Limit set: "+kt(l.sessionTokens)+" per session":"No token limit")})}
  else if(k==="resume"){navigator.clipboard?.writeText("cd "+s.cwd+" && "+(s.agent==="codex"?"codex resume ":"claude --resume ")+s.id).catch(()=>{});toast("Copied resume command")}
  else if(k==="send"){sendMsg()}
  else if(k==="pin"){pinSession(s.id,!s.pinned)}
  else if(k==="attach"){$("fin").click()}
  else if(k==="newopen"){openNew()}
  else if(k==="newcancel"){$("dlg").hidden=true}
  else if(k==="newgo"){startNew()}
  else if(k==="newagent"){if(OPT.agents[a.dataset.agent]){ND.agent=a.dataset.agent;ND.agentManual=true;drawNew()}else toast("Not installed on this computer")}
  else if(k==="newrole"){ND.role=a.dataset.role;ND.manual=true;drawNew()}
  else if(k==="roles"){showRoles=!showRoles;opts().then(render)}
  else if(k==="setrole"){post("api/role",{id:s.id,role:a.dataset.role}).then(()=>{last="";load();toast(a.dataset.role?"Now a "+a.dataset.role+" agent":"Back to automatic")})}
  else if(k==="tobottom"){const f=$("feed");f.scrollTo({top:f.scrollHeight,behavior:"smooth"});setTimeout(updatePill,700)}
  else if(k==="skills"){showSkills=!showSkills;render()}
  else if(k==="down"){post("api/downgrade",{id:s.id}).then(r=>{if(r.error){toast(r.error);return}navigator.clipboard?.writeText("/model "+r.model).catch(()=>{});toast("New sessions use "+r.model+". Copied /model "+r.model+" for this one")})}
  return}
 const lb=e.target.closest("[data-lim]");if(lb){LIM.tokens=Math.max(0,LIM.tokens+Number(lb.dataset.lim));renderLim();return}
 const ls=e.target.closest("[data-limset]");if(ls){LIM.tokens=Number(ls.dataset.limset);renderLim();return}
 const lw=e.target.closest("#lp [data-sw]");if(lw){LIM.auto=!LIM.auto;renderLim();return}
 const ct=e.target.closest("[data-ctext]");if(ct){if(ct.dataset.ctext)cp(ct.dataset.ctext);return}
 const rm=e.target.closest("[data-rmatt]");if(rm){const a=ATT[composerFor]||[];a.splice(Number(rm.dataset.rmatt),1);drawTray();return}
 const ob=e.target.closest("[data-opt]");if(ob){answer(ob.dataset.opt);return}
 const sk=e.target.closest("[data-skill]");if(sk){navigator.clipboard?.writeText("/"+sk.dataset.skill).catch(()=>{});toast("Copied /"+sk.dataset.skill);return}
 const cc=e.target.closest("[data-copycode]");if(cc){cp(cc.parentElement.querySelector("code").textContent);return}
 const qn=e.target.closest("[data-qnow]");if(qn){queueAct("api/queue/now",qn.dataset.qnow);return}
 const qd=e.target.closest("[data-qdrop]");if(qd){queueAct("api/queue/drop",qd.dataset.qdrop);return}
 const cl=e.target.closest("[data-col]");if(cl){const k=cl.dataset.col;if(COL.has(k))COL.delete(k);else COL.add(k);render();return}
 if(e.target.closest("a"))return;
 const m=e.target.closest("[data-msg]");if(m){if(String(getSelection()).length)return;m.classList.toggle("open");return}

});
function fx(cls,x,y,txt,vars){const c=$("box");if(!c)return;const el=document.createElement("span");el.className=cls;el.style.left=x+"px";el.style.top=y+"px";if(txt)el.textContent=txt;for(const k in vars||{})el.style.setProperty(k,vars[k]);c.appendChild(el);el.addEventListener("animationend",()=>el.remove())}
function caretXY(){const t=$("msg"),r=t.getBoundingClientRect(),c=$("box").getBoundingClientRect();const lines=t.value.slice(0,t.selectionStart).split("\\n");const w=Math.max(1,r.width);const col=lines.at(-1).length*7.6;return{x:r.left-c.left+(col%w),y:r.top-c.top+Math.min(r.height,(lines.length-1+Math.floor(col/w))*20)+14}}
document.addEventListener("input",e=>{if(e.target.id!=="msg")return;saveDraft(composerFor,e.target.value);const t=e.target;t.style.height="28px";t.style.height=Math.min(160,Math.max(28,t.scrollHeight))+"px";follow();const c=$("box");c.classList.add("hot");clearTimeout(c._t);c._t=setTimeout(()=>c.classList.remove("hot"),700)});
document.addEventListener("selectionchange",()=>{if(document.activeElement?.id==="msg")follow()});
function follow(){const t=$("msg"),p=caretXY(),w=t.getBoundingClientRect().width;const g=document.querySelector(".compose .glow");if(g){g.style.left=(p.x-45)+"px";g.style.top=(p.y-45)+"px"}
 const l=document.querySelector(".compose .fill");if(l)l.style.width=Math.min(w+40,t.value.length*7.6)+"px";const ch=$("ch");if(ch)ch.textContent=t.value.length;
 const pu=document.querySelector(".watch .pup");if(pu){const dx=Math.max(-3,Math.min(3,(p.x/w)*6-3));pu.style.transform="translate("+(dx+3)+"px,2px)"}}
document.addEventListener("keydown",e=>{if(e.target.id==="msg"&&e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMsg()}});
async function sendMsg(){const t=$("msg"),s=S.find(x=>x.id===sel);if(!t||!s)return;const text=t.value.trim(),att=ATT[s.id]||[];
 if(att.some(f=>!f.path&&!f.err)){toast("Still uploading\u2026");return}
 const files=att.filter(f=>f.path).map(f=>f.path);
 if(!text&&!files.length){toast("Type a message first");t.focus();return}
 const r=await post("api/send",{id:s.id,text,files}).catch(()=>({error:"The board is not answering."}));if(r.error){toast(r.error);return}
 ATT[s.id]=[];drawTray();
 fx("sent",0,0,text.replace(/\\s+/g," "));
 if(text)pushHist(s.id,text); t.value="";saveDraft(s.id,"");t.style.height="28px";follow();if(r.queued){s.queue=[...(s.queue||[]),{qid:r.qid,text:text||"(attached files)"}];toast("Queued for "+s.role)}else{s.sending=true;toast("Sent to "+s.role)}last="";render()}
async function queueAct(path,qid){const r=await post(path,{id:sel,qid}).catch(()=>({error:"The board is not answering."}));if(r.error){toast(r.error);return}const s=S.find(x=>x.id===sel);if(s){s.queue=(s.queue||[]).filter(x=>x.qid!==qid);if(r.sent){s.sending=true;toast("Sent to "+s.role)}}last="";render()}
let OPT=null,ND=null,wantSel="",showRoles=false,dt=0,LIM={tokens:0,auto:false},ORDER=[],dragId="",movedId="";
const dk=id=>"rma-draft-"+id;
const COL=new Set();
const hk=id=>"rma-hist-"+id;let hpos=-1,hstash="",hsel="";
function readHist(id){try{const a=JSON.parse(localStorage.getItem(hk(id))||"[]");return Array.isArray(a)?a.map(String):[]}catch(e){return[]}}
function pushHist(id,v){try{const a=readHist(id).filter(x=>x!==v);a.push(v);localStorage.setItem(hk(id),JSON.stringify(a.slice(-50)))}catch(e){}hpos=-1}
function showHist(t,v){t.value=v;t.style.height="28px";t.style.height=Math.min(160,Math.max(28,t.scrollHeight))+"px";t.setSelectionRange(v.length,v.length);saveDraft(sel,v)}
document.addEventListener("keydown",e=>{const t=e.target;if(!t||t.id!=="msg"||e.shiftKey||e.altKey||e.metaKey||e.ctrlKey)return;if(hsel!==sel){hsel=sel;hpos=-1}
 if(e.key==="ArrowUp"&&t.selectionStart===0&&t.selectionEnd===0){const h=readHist(sel);if(!h.length)return;e.preventDefault();if(hpos===-1){hstash=t.value;hpos=h.length}if(hpos>0){hpos--;showHist(t,h[hpos]);t.setSelectionRange(0,0)}}
 else if(e.key==="ArrowDown"&&hpos!==-1&&(t.selectionStart===t.value.length||t.selectionStart===0)){e.preventDefault();const h=readHist(sel);hpos++;if(hpos>=h.length){hpos=-1;showHist(t,hstash)}else showHist(t,h[hpos])}});
function saveDraft(id,v){try{if(v)localStorage.setItem(dk(id),v);else localStorage.removeItem(dk(id))}catch(e){}}
function loadDraft(id){try{return localStorage.getItem(dk(id))||""}catch(e){return""}}
function restoreDraft(id){const t=$("msg");if(!t)return;t.value=loadDraft(id);if(t.value){t.style.height="28px";t.style.height=Math.min(160,Math.max(28,t.scrollHeight))+"px";follow()}}
function mini(f,n){return '<svg width="'+n+'" height="'+n+'" viewBox="0 0 64 64">'+SH[f.shape](f.color)+EY[f.eyes]+"</svg>"}
const EFFORTS=["low","medium","high","xhigh","max"],ECOL=["#22c55e","#6ee7a0","#fbbf24","#fb923c","#f43f5e"],ELAB={low:"L",medium:"M",high:"H",xhigh:"X",max:"MAX"};
const MODELS=[["","AUTO",-72,"#a1a1b3"],["haiku","HAIKU",-24,"#6ee7a0"],["sonnet","SONNET",24,"#38bdf8"],["opus","OPUS",72,"#fbbf24"]];
const ico=p=>'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+p+"</svg>";
const IC={plus:'<path d="M12 5v14M5 12h14"/>',gauge:'<path d="M5 17a7 7 0 1 1 14 0"/><path d="M12 17l4-5"/>',pin:'<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3z"/>',files:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',bell:'<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',star:'<path d="M12 3l2.4 5.2 5.6.7-4.1 3.9 1.1 5.6-5-2.8-5 2.8 1.1-5.6L4 8.9l5.6-.7z"/>',branch:'<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 5-12 2-12 6"/>',folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',hash:'<path d="M5 9h14M5 15h14M10 4l-2 16M16 4l-2 16"/>',eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',eyeoff:'<path d="M3 3l18 18M10.6 6.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.8A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4-.9"/>',trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',clip:'<path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>'};
function hb(act,label,svg,on){return '<span data-act="'+act+'" class="'+(on?"on":"")+'">'+svg+esc(label)+"</span>"}
function polar(a,r){const t=a*Math.PI/180;return[60+r*Math.sin(t),62-r*Math.cos(t)]}
function dialHtml(cur){const d=MODELS.find(m=>m[0]===cur)||MODELS[0];let ticks="";
 for(let i=0;i<=12;i++){const a=-90+15*i,p1=polar(a,39),p2=polar(a,i%3?37:34);ticks+='<line x1="'+p1[0].toFixed(1)+'" y1="'+p1[1].toFixed(1)+'" x2="'+p2[0].toFixed(1)+'" y2="'+p2[1].toFixed(1)+'" stroke="#3a3a48" stroke-width="1"/>'}
 const dots=MODELS.map(([k,l,a,c])=>{const p=polar(a,46);return '<circle class="mdot" data-model="'+k+'" data-k="'+k+'" data-c="'+c+'" cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="5" fill="'+(k===cur?c:"#2c2c3a")+'"/>'}).join("");
 return '<svg viewBox="0 0 120 70" class="gsv dial"><path d="M10 62A50 50 0 0 1 110 62" fill="none" stroke="url(#gm)" stroke-width="5" stroke-linecap="round" opacity=".5"/>'+ticks+dots+'<g class="needle idle" data-needle="1" style="--a:'+d[2]+'deg"><line x1="60" y1="62" x2="60" y2="25" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g><circle cx="60" cy="62" r="6" fill="url(#hub)"/></svg><div class="mls">'+MODELS.map(([k,l,a,c])=>'<span class="ml'+(k===cur?" on":"")+'" data-model="'+k+'" style="--c:'+c+'">'+l+"</span>").join("")+"</div>"}
function updateDial(root,m){const d=MODELS.find(x=>x[0]===m)||MODELS[0];root.querySelector("[data-needle]").style.setProperty("--a",d[2]+"deg");root.querySelectorAll(".mdot").forEach(c=>c.setAttribute("fill",c.dataset.k===m?c.dataset.c:"#2c2c3a"));root.querySelectorAll(".ml").forEach(l=>l.classList.toggle("on",l.dataset.model===m))}
function ledsHtml(cur){const ci=EFFORTS.indexOf(cur);return '<div class="leds">'+EFFORTS.map((e,i)=>'<i class="led'+(i<=ci?" on":"")+'" data-effort="'+e+'" title="'+e+'" style="--i:'+i+';--c:'+ECOL[i]+';height:'+(14+i*7)+'px"></i>').join("")+'</div><div class="elab">'+EFFORTS.map(e=>'<span data-effort="'+e+'">'+ELAB[e]+"</span>").join("")+'</div><div class="gcap">effort<b data-ecap>'+(cur?cur.toUpperCase():"AUTO")+'</b></div><span class="autob" data-effort="">AUTO</span>'}
function updateLeds(root,ef){const i=EFFORTS.indexOf(ef);root.querySelectorAll(".led").forEach((l,j)=>l.classList.toggle("on",j<=i));root.querySelector("[data-ecap]").textContent=ef?ef.toUpperCase():"AUTO"}
async function opts(){if(!OPT)OPT=await fetch("api/options").then(r=>r.json());return OPT}
function chips(cur,auto,act){return OPT.roles.map(o=>'<span class="rc'+(o.role===cur?" on":"")+'" data-act="'+act+'" data-role="'+esc(o.role)+'" style="--c:'+o.color+'">'+mini(o,20)+esc(o.role)+(auto&&o.role===auto?"<em>AUTO</em>":"")+"</span>").join("")}
function folderName(p){const a=p.split("/").filter(Boolean);return a.slice(-2).join("/")||p}
function markFolders(){const v=$("ncwd")?$("ncwd").value.trim():"";document.querySelectorAll("#nfold .fc").forEach(c=>c.classList.toggle("on",c.dataset.folder===v))}
function drawNew(){const o=OPT;
 $("nagent").innerHTML=[["claude","Claude Code"],["codex","Codex"]].map(([k,l])=>'<span class="sg'+(ND.agent===k?" on":"")+(o.agents[k]?"":" off")+'" data-act="newagent" data-agent="'+k+'">'+l+(o.agents[k]?"":" (not installed)")+"</span>").join("");
 $("nrole").innerHTML=chips(ND.role,ND.manual?"":ND.role,"newrole");
 $("nauto").textContent=ND.manual?"you picked":"detected from your text";
 $("nmrow").style.display=ND.agent==="claude"?"":"none";markFolders()}
async function openNew(){await opts();const cur=S.find(x=>x.id===sel)||S[0]||{};
 ND={agent:OPT.defaultAgent,role:"Code",manual:false,agentManual:false,model:"",effort:""};
 const d=$("dlg");d.hidden=false;
 d.innerHTML='<div class="dbg" data-act="newcancel"></div><div class="dcard gx"><div class="in"><div class="dhd"><h3>New session</h3><span class="dsub">the board starts it for you</span></div><div class="tbox"><textarea id="ntext" placeholder="What should the agent do?"></textarea></div><div class="lbl">AI</div><div class="seg" id="nagent"></div><div class="lbl">Agent type <em id="nauto"></em></div><div class="chips" id="nrole"></div><div class="lbl">Folder</div><div class="fch" id="nfold">'+OPT.folders.map(f=>'<span class="fc" data-folder="'+esc(f)+'" title="'+esc(f)+'">'+esc(folderName(f))+"</span>").join("")+'</div><div class="fbox"><input class="f" id="ncwd" autocomplete="off" spellcheck="false" placeholder="/path/to/project"></div><div id="nmrow" class="nrow"><div class="gc"><div class="gcap" style="margin:0 0 2px">model</div>'+dialHtml("")+'</div><div class="gc">'+ledsHtml("")+'</div></div><div class="dact"><button class="btn" data-act="newcancel">Cancel</button><button class="btn new" data-act="newgo">Start</button></div></div></div>';
 $("ncwd").value=cur.cwd||OPT.folders[0]||"";$("ntext").value=loadDraft("new");drawNew();$("ntext").focus();
 const card=d.querySelector(".dcard");requestAnimationFrame(()=>requestAnimationFrame(()=>card.classList.add("live")))}
$("dlg").addEventListener("click",e=>{const t=e.target;let el;
 if(el=t.closest("[data-model]")){ND.model=el.dataset.model;updateDial($("dlg"),ND.model);e.stopPropagation();return}
 if(el=t.closest("[data-effort]")){ND.effort=el.dataset.effort;updateLeds($("dlg"),ND.effort);e.stopPropagation();return}
 if(el=t.closest("[data-folder]")){$("ncwd").value=el.dataset.folder;markFolders();e.stopPropagation();return}});
document.addEventListener("input",e=>{if(e.target.id==="ncwd")markFolders()});
document.addEventListener("input",e=>{if(e.target.id!=="ntext")return;saveDraft("new",e.target.value);clearTimeout(dt);dt=setTimeout(async()=>{const t=$("ntext")&&$("ntext").value;if(!t||!ND)return;const r=await fetch("api/detect?text="+encodeURIComponent(t)).then(r=>r.json()).catch(()=>null);if(!r||!ND)return;if(!ND.manual)ND.role=r.role;if(!ND.agentManual&&r.agent)ND.agent=r.agent;drawNew()},200)});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){hideMenu();if(!$("dlg").hidden)$("dlg").hidden=true}if(e.target.id==="ntext"&&e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();startNew()}});
async function startNew(){const text=$("ntext").value.trim();if(!text){toast("Describe the task first");$("ntext").focus();return}
 const r=await post("api/new",{agent:ND.agent,cwd:$("ncwd").value.trim(),text,role:ND.manual?ND.role:"",model:ND.agent==="claude"?ND.model:"",effort:ND.agent==="claude"?ND.effort:""}).catch(()=>({error:"The board is not answering."}));
 if(r.error){toast(r.error);return}
 $("dlg").hidden=true;saveDraft("new","");wantSel=r.id||"";toast("Started a "+ND.role+" agent on "+(ND.agent==="codex"?"Codex":"Claude Code"));[1500,5000,12000].forEach(t=>setTimeout(()=>{last="";load()},t))}
function limPanel(){const pre=[[0,"OFF"],[500000,"500k"],[1000000,"1M"],[2000000,"2M"],[5000000,"5M"]];
 return '<div class="panel lp gx live" id="lp"><div class="lbl">Token limit per session</div><div class="lnum"><span class="lbtn" data-lim="-250000">&minus;</span><b id="limv">'+(LIM.tokens?limLabel(LIM.tokens):"OFF")+'</b><span class="lbtn" data-lim="250000">+</span></div><div class="fch lchips">'+pre.map(([v,l])=>'<span class="fc'+(LIM.tokens===v?" on":"")+'" data-limset="'+v+'">'+l+"</span>").join("")+'</div><div class="swr" data-sw="auto"><span>At the limit, move new sessions to a cheaper model</span><i class="swt'+(LIM.auto?" on":"")+'"><b></b></i></div><div class="lbl" style="font-size:10px">Models only move down: Opus, then Sonnet, then Haiku.</div><button class="btn go" data-act="save">Save</button></div>'}
function renderLim(){const p=$("lp");if(!p)return;const v=$("limv");v.textContent=LIM.tokens?limLabel(LIM.tokens):"OFF";v.classList.remove("bump");void v.offsetWidth;v.classList.add("bump");p.querySelectorAll("[data-limset]").forEach(c=>c.classList.toggle("on",Number(c.dataset.limset)===LIM.tokens));p.querySelector(".swt").classList.toggle("on",LIM.auto)}
const ATT={};
function fmtSize(n){return n>=1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB"}
function drawTray(){const t=$("atray");if(!t)return;const a=ATT[composerFor]||[];
 t.innerHTML=a.map((f,i)=>'<span class="att'+(f.err?" err":"")+'" data-att="'+i+'"><span class="th"'+(f.thumb?' style="background-image:url('+f.thumb+')"':"")+">"+(f.thumb?"":ico(IC.files))+'</span><span class="nm2" title="'+esc(f.name)+'">'+esc(f.name)+"</span><small>"+fmtSize(f.size)+'</small><span class="x" data-rmatt="'+i+'" title="Remove">&times;</span>'+(f.path||f.err?"":'<i class="pg" style="--w:'+(f.pct||0)+'%"></i>')+"</span>").join("");
 const c=document.querySelector(".clip"),n=$("clipn");if(c)c.classList.toggle("has",a.length>0);if(n){n.hidden=!a.length;n.textContent=a.length}}
function attachFiles(list){const s=S.find(x=>x.id===composerFor);if(!s){toast("Select an agent first");return}const a=ATT[s.id]=ATT[s.id]||[];
 for(const file of list){if(a.length>=10){toast("Up to 10 files per message");break}if(!file.size){toast(file.name+" is empty");continue}if(file.size>26214400){toast(file.name+" is over 25 MB");continue}
  const f={name:file.name,size:file.size,pct:0,thumb:/^image\\//.test(file.type)?URL.createObjectURL(file):""};a.push(f);
  const x=new XMLHttpRequest();x.open("POST","api/upload?id="+encodeURIComponent(s.id)+"&name="+encodeURIComponent(file.name));x.setRequestHeader("x-run-my-agents","1");
  x.upload.onprogress=ev=>{f.pct=ev.lengthComputable?Math.round(ev.loaded/ev.total*100):50;const el=document.querySelector('#atray [data-att="'+a.indexOf(f)+'"] .pg');if(el)el.style.setProperty("--w",f.pct+"%")};
  x.onload=()=>{try{const r=JSON.parse(x.responseText);if(x.status===200&&r.path)f.path=r.path;else{f.err=true;toast(r.error||"Upload failed")}}catch(e){f.err=true}drawTray()};
  x.onerror=()=>{f.err=true;drawTray();toast("Upload failed")};x.send(file)}
 drawTray()}
$("fin").addEventListener("change",e=>{attachFiles([...e.target.files]);e.target.value=""});
const hasFiles=e=>e.dataTransfer&&[...e.dataTransfer.types].includes("Files");
document.addEventListener("dragenter",e=>{if(!hasFiles(e))return;e.preventDefault();const s=S.find(x=>x.id===composerFor);$("dzt").textContent=s?"Drop to attach to "+s.role:"Drop files to attach";$("drop").hidden=false});
document.addEventListener("dragover",e=>{if(hasFiles(e))e.preventDefault()});
document.addEventListener("dragleave",e=>{if(!e.relatedTarget)$("drop").hidden=true});
document.addEventListener("drop",e=>{if(!hasFiles(e))return;e.preventDefault();$("drop").hidden=true;attachFiles([...e.dataTransfer.files])});
document.addEventListener("paste",e=>{if(e.target.id!=="msg")return;const fs=[...((e.clipboardData&&e.clipboardData.files)||[])];if(fs.length){e.preventDefault();attachFiles(fs)}});
function ordSort(xs){const o=new Map(ORDER.map((id,i)=>[id,i]));return xs.slice().sort((a,b)=>(o.has(a.id)?o.get(a.id):-1)-(o.has(b.id)?o.get(b.id):-1))}
function snapRows(){const m=new Map();document.querySelectorAll("#side .it[data-sel]").forEach(r=>m.set(r.dataset.sel,r.getBoundingClientRect().top));return m}
function flip(old){document.querySelectorAll("#side .it[data-sel]").forEach(r=>{const o=old.get(r.dataset.sel);if(o===undefined)return;const d=o-r.getBoundingClientRect().top;if(Math.abs(d)<2)return;r.style.transition="none";r.style.transform="translateY("+d+"px)";void r.offsetWidth;r.style.transition="transform .5s cubic-bezier(.2,.9,.3,1.15),background .2s";r.style.transform="";setTimeout(()=>{r.style.transition=""},560)})}
function clearDrop(){document.querySelectorAll(".drop-before,.drop-after,.drop-into").forEach(x=>x.classList.remove("drop-before","drop-after","drop-into"))}
document.addEventListener("dragstart",e=>{const r=e.target.closest&&e.target.closest("#side .it[data-sel]");if(!r)return;dragId=r.dataset.sel;e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",dragId);r.classList.add("dragging");document.body.classList.add("dnd")});
document.addEventListener("dragend",()=>{clearDrop();dragId="";document.body.classList.remove("dnd");document.querySelectorAll(".dragging").forEach(x=>x.classList.remove("dragging"))});
document.addEventListener("dragover",e=>{if(!dragId)return;const t=e.target.closest("#side .it[data-sel],#side .grp[data-grp]");if(!t)return;e.preventDefault();e.dataTransfer.dropEffect="move";clearDrop();if(t.classList.contains("grp"))t.classList.add("drop-into");else if(t.dataset.sel!==dragId){const r=t.getBoundingClientRect();t.classList.add(e.clientY<r.top+r.height/2?"drop-before":"drop-after")}});
document.addEventListener("drop",e=>{if(!dragId)return;const t=e.target.closest("#side .it[data-sel],#side .grp[data-grp]");if(!t)return;e.preventDefault();const id=dragId;dragId="";clearDrop();
 if(t.classList.contains("grp"))return dropAgent(id,t.dataset.grp,{});
 if(t.dataset.sel===id)return;const r=t.getBoundingClientRect();dropAgent(id,groupName(S.find(x=>x.id===t.dataset.sel)),{target:t.dataset.sel,after:e.clientY>=r.top+r.height/2})});
/* Dropping on Pinned pins, out of Pinned unpins, into Closed closes, out of Closed reopens. The rest only changes the order. */
function dropAgent(id,gname,where){const s=S.find(x=>x.id===id);if(!s)return;
 if(gname==="Closed"){if(!s.hidden){s.hidden=true;post("api/hide",{id,hidden:true})}}
 else{if(s.hidden){s.hidden=false;post("api/hide",{id,hidden:false})}
  if(gname==="Pinned"&&!s.pinned){s.pinned=true;post("api/pin",{id,pinned:true})}
  else if(gname!=="Pinned"&&s.pinned){s.pinned=false;post("api/pin",{id,pinned:false})}}
 const flat=[];for(const g of GROUPS)for(const x of ordSort(S.filter(g[1])))flat.push(x.id);
 flat.splice(flat.indexOf(id),1);
 let at;if(where.target)at=flat.indexOf(where.target)+(where.after?1:0);else{const first=flat.findIndex(x=>groupName(S.find(y=>y.id===x))===gname);at=first<0?flat.length:first}
 flat.splice(at,0,id);ORDER=flat;movedId=id;post("api/order",{ids:flat});render();
 toast(gname==="Pinned"?"Pinned":gname==="Closed"?"Closed":"Moved")}
let PRC={},prT=0,prEl=null;
function prIcon(st){return st==="MERGED"?ico('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v6a4 4 0 0 0 4 4h6M13 11l5 5"/>'):st==="CLOSED"?ico('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'):ico('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-3"/>')}
function placeBelow(p,el){const b=el.getBoundingClientRect(),r=p.getBoundingClientRect();p.style.left=Math.max(8,Math.min(b.left,innerWidth-r.width-8))+"px";p.style.top=Math.max(8,Math.min(b.bottom+6,innerHeight-r.height-8))+"px"}
function fillPrs(p,d){const b=p.querySelector(".prb");b.innerHTML=d.error?'<div class="pre">'+esc(d.error)+"</div>":d.prs.length?d.prs.map((r,i)=>'<a class="prr '+String(r.state||"OPEN").toLowerCase()+'" style="--i:'+i+'" href="'+esc(r.url)+'" target="_blank" rel="noopener noreferrer">'+prIcon(r.state)+'<span class="prt"><b>#'+r.number+"</b> "+esc(r.title||"Pull request")+"</span><small>"+esc(r.repo||"")+(r.branch?" \u00b7 "+esc(r.branch):"")+(r.draft?" \u00b7 draft":"")+'</small><i class="prs">'+esc(r.state||"OPEN")+"</i></a>").join(""):'<div class="pre">No pull requests for this branch yet.</div>';placeBelow(p,p._chip)}
function hidePrs(){if(prEl){prEl.remove();prEl=null}}
function schedHide(){clearTimeout(prT);prT=setTimeout(hidePrs,280)}
function showPrs(chip){hidePrs();const id=chip.dataset.prs,s=S.find(x=>x.id===id)||{};const p=document.createElement("div");p.className="prpop";p._chip=chip;
 p.innerHTML='<div class="prh">'+ico(IC.branch)+"<span>Pull requests</span><em>"+esc(s.branch||"")+'</em></div><div class="prb"><div class="prsk"></div><div class="prsk"></div></div>';
 document.body.appendChild(p);placeBelow(p,chip);prEl=p;p.addEventListener("mouseenter",()=>clearTimeout(prT));p.addEventListener("mouseleave",schedHide);
 const c=PRC[id];if(c&&Date.now()-c.at<30000){fillPrs(p,c.d);return}
 fetch("api/prs?id="+encodeURIComponent(id)).then(r=>r.json()).then(d=>{PRC[id]={at:Date.now(),d};if(prEl===p)fillPrs(p,d)}).catch(()=>{if(prEl===p)p.querySelector(".prb").innerHTML='<div class="pre">Could not load pull requests.</div>'})}
document.addEventListener("mouseover",e=>{const c=e.target.closest&&e.target.closest("[data-prs]");if(c){clearTimeout(prT);if(!prEl||prEl._chip!==c)prT=setTimeout(()=>showPrs(c),140)}else if(prEl&&!e.target.closest(".prpop"))schedHide()});
function showModelPick(el,s){hideMenu();const cur=(s.tune&&s.tune.model)||"";const m=document.createElement("div");m.className="cmenu mpop gx";
 m.innerHTML='<div class="gcap" style="margin:0 2px 5px;text-align:left">model for '+esc(s.role)+'</div><div class="mls">'+MODELS.map(([k,l,a,c])=>'<span class="ml'+(k===cur?" on":"")+'" data-pick="'+k+'" style="--c:'+c+'">'+l+"</span>").join("")+'</div><div class="mnote">Every message you send from the board to this agent uses it. For the Claude app, paste /model after choosing (it is copied).</div>';
 m.addEventListener("click",e=>{e.stopPropagation();const p=e.target.closest("[data-pick]");if(!p)return;const k=p.dataset.pick;hideMenu();tune(s,{model:k}).then(r=>{if(r.error)return;render();if(k)navigator.clipboard?.writeText("/model "+k).catch(()=>{});toast(k?k.toUpperCase()+" is set for your next message from the board. Copied /model "+k:"Model back to automatic")})});
 document.body.appendChild(m);const b=el.getBoundingClientRect(),r=m.getBoundingClientRect();m.style.left=Math.max(8,Math.min(b.left,innerWidth-r.width-8))+"px";m.style.top=Math.max(8,Math.min(b.bottom+6,innerHeight-r.height-8))+"px";MENU={el:m,items:[],sid:s.id}}
function optsHtml(o){return '<div class="opts">'+(o.recap?'<div class="orec">'+renderMarkdown(o.recap)+"</div>":"")+(o.ask?'<div class="oask">'+esc(o.ask)+"</div>":"")+'<div class="obtns">'+o.labels.map((l,i)=>'<span class="obtn'+(i===0?" first":"")+'" data-opt="'+esc(l)+'">'+esc(l)+(i===0?"<kbd>\u2318\u21b5</kbd>":"")+"</span>").join("")+"</div></div>"}
async function answer(label){const s=S.find(x=>x.id===sel);if(!s)return;const r=await post("api/send",{id:s.id,text:label}).catch(()=>({error:"The board is not answering."}));if(r.error){toast(r.error);return}
 document.querySelectorAll("#feed .obtn").forEach(b=>{b.classList.add("done");if(b.dataset.opt===label)b.classList.add("picked")});s.sending=true;toast("Sent: "+label);last=""}
function toolRuns(ts){const r=[];for(const t of ts){const l=r[r.length-1];if(l&&l[0]===t)l[1]++;else r.push([t,1])}return r.map(([t,n])=>'<span class="tool" data-act="tool" title="'+esc(t)+(n>1?" \u00d7"+n:"")+'">'+esc(t)+(n>1?"<b>\u00d7"+n+"</b>":"")+"</span>").join("")}
function pinSession(id,on){post("api/pin",{id,pinned:on}).then(r=>{if(r.error){toast(r.error);return}last="";load();toast(on?"Pinned to the top":"Unpinned")})}
function cp(t){navigator.clipboard?.writeText(t).catch(()=>{});toast("Copied")}
function openIn(id,target){post("api/open",{id,target}).then(r=>toast(r.error||"Opened"))}
let MENU=null;
function hideMenu(){if(MENU){MENU.el.remove();MENU=null}}
function showMenu(x,y,items,head,sid){hideMenu();const m=document.createElement("div");m.className="cmenu";
 m.innerHTML=(head||"")+items.map((it,i)=>it==="-"?'<div class="msep"></div>':'<div class="mi'+(it.danger?" dng":"")+'" data-mi="'+i+'"><span>'+esc(it.label)+"</span><em>"+esc(it.hint||"")+"</em></div>"+(it.sub?'<div class="msub" data-sub="'+i+'">'+it.sub+"</div>":"")).join("");
 m.addEventListener("click",menuClick);document.body.appendChild(m);const r=m.getBoundingClientRect();
 m.style.left=Math.max(6,Math.min(x,innerWidth-r.width-6))+"px";m.style.top=Math.max(6,Math.min(y,innerHeight-r.height-6))+"px";MENU={el:m,items,sid}}
function menuClick(e){e.stopPropagation();
 const rc=e.target.closest("[data-mrole]");if(rc){const id=MENU.sid,role=rc.dataset.mrole;hideMenu();post("api/role",{id,role}).then(()=>{last="";load();toast(role?"Now a "+role+" agent":"Back to automatic")});return}
 const mi=e.target.closest("[data-mi]");if(!mi)return;const item=MENU.items[Number(mi.dataset.mi)];
 if(item.sub){MENU.el.querySelector('[data-sub="'+mi.dataset.mi+'"]').classList.toggle("on");return}
 hideMenu();if(item.run)item.run()}
const ICON={finder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',terminal:'<path d="M4 6l6 6-6 6M12 18h8" stroke-linecap="round"/>',vscode:'<path d="M9 7l-5 5 5 5M15 7l5 5-5 5" stroke-linecap="round"/>',skills:'<path d="M12 3l2.4 5.2 5.6.7-4.1 3.9 1.1 5.6-5-2.8-5 2.8 1.1-5.6L4 8.9l5.6-.7z" stroke-linejoin="round"/>'};
const TILES=[["finder","Finder"],["terminal","Terminal"],["vscode","VS Code"],["skills","Skills"]];
function gaugePanel(s){
 const lim=L.sessionTokens,pct=Math.max(0,Math.min(1,s.tokens.used/(lim||2000000))),claude=s.agent==="claude",cm=(s.tune&&s.tune.model)||"",ce=(s.tune&&s.tune.effort)||"";
 let ticks="";for(let i=0;i<=10;i++){const a=-90+18*i,p1=polar(a,41),p2=polar(a,i%5?38:35);ticks+='<line x1="'+p1[0].toFixed(1)+'" y1="'+p1[1].toFixed(1)+'" x2="'+p2[0].toFixed(1)+'" y2="'+p2[1].toFixed(1)+'" stroke="#3a3a48" stroke-width="1"/>'}
 const tok='<svg viewBox="0 0 120 70" class="gsv"><path d="M10 62A50 50 0 0 1 110 62" fill="none" stroke="#242430" stroke-width="9" stroke-linecap="round"/><path class="arc" d="M10 62A50 50 0 0 1 110 62" fill="none" stroke="url(#gz)" stroke-width="9" stroke-linecap="round" pathLength="100" stroke-dasharray="100" style="--p:'+(pct*100).toFixed(1)+'"/>'+ticks+'<g class="needle'+(pct>=.7?" hot":" idle")+'" style="--a:'+(-90+180*pct).toFixed(1)+'deg"><line x1="60" y1="62" x2="60" y2="24" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g><circle cx="60" cy="62" r="6" fill="url(#hub)"/></svg>';
 return '<div class="gh">'+mini(s.face,34)+'<div style="min-width:0"><b>'+esc(s.title||"Untitled session")+'</b><div class="tags"><span class="rl" style="color:'+s.face.color+';background:color-mix(in srgb,'+s.face.color+' 18%,transparent)">'+esc(s.role)+'</span><span class="ag '+s.agent+'">'+(s.agent==="codex"?"CODEX":"CLAUDE")+"</span>"+mtag(s)+"</div></div></div>"
 +'<div class="gg2"><div class="gc">'+tok+'<div class="gcap">tokens<b>'+kt(s.tokens.used)+(lim?" / "+kt(lim):"")+'</b></div></div><div class="gc'+(claude?"":" off")+'">'+ledsHtml(ce)+"</div></div>"
 +'<div class="gc'+(claude?"":" off")+'"><div class="gcap" style="margin:0 0 2px">model for this agent'+(claude?"":" (Claude Code only)")+"</div>"+dialHtml(cm)+"</div>"
 +'<div class="swg"><div class="swr" data-sw="pin"><span>Pinned</span><i class="swt'+(s.pinned?" on":"")+'"><b></b></i></div><div class="swr" data-sw="mute"><span>Mute clash warnings</span><i class="swt'+(muted[s.id]?" on":"")+'"><b></b></i></div></div>'
 +'<div class="gcard"><div class="gcap" style="margin:2px 4px 4px;text-align:left">agent type</div><div class="gt2"><span class="rc'+(s.roleSet?"":" on")+'" data-mrole="" title="Auto" style="--c:#8a8a99"><span class="rn">Auto</span></span>'+OPT.roles.map(o=>'<span class="rc'+(s.roleSet&&o.role===s.role?" on":"")+'" data-mrole="'+esc(o.role)+'" title="'+esc(o.role)+'" style="--c:'+o.color+'">'+mini(o,18)+'<span class="rn">'+esc(o.role)+"</span></span>").join("")+"</div></div>"
 +'<div class="tiles">'+TILES.map(([k,l])=>'<div class="tl" data-tile="'+k+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">'+ICON[k]+"</svg>"+l+"</div>").join("")+"</div>"
 +'<div class="cpy"><span class="cb" data-copy="name">Name</span><span class="cb" data-copy="id">ID</span><span class="cb" data-copy="resume">Resume cmd</span></div>'
 +'<div class="dz2"><span class="tl2 amb" data-close="1">'+ico(s.hidden?IC.eye:IC.eyeoff)+(s.hidden?"Reopen":"Close")+'</span><span class="tl2 red'+(s.viaApp===true?" off":"")+'" data-del="1" title="'+(s.viaApp===true?"This session is in the Claude app. Delete it there.":"Delete this session for good")+'">'+ico(IC.trash)+"<b>Delete</b></span></div>"}
function tune(s,patch){s.tune=Object.assign({},s.tune,patch);return post("api/tune",Object.assign({id:s.id},patch)).then(r=>{if(r.error)toast(r.error);return r})}
function showPanel(x,y,s){hideMenu();const el=document.createElement("div");el.className="cmenu gp gx";el.innerHTML=gaugePanel(s);el.addEventListener("click",gpClick);el.style.animation="none";document.body.appendChild(el);
 const m=8,r0=el.getBoundingClientRect(),k=Math.max(.5,Math.min(1,(innerHeight-2*m)/r0.height,(innerWidth-2*m)/r0.width));if(k<1)el.style.setProperty("--fit",k.toFixed(3));
 const r=el.getBoundingClientRect();el.style.left=Math.max(m,Math.min(x,innerWidth-r.width-m))+"px";el.style.top=Math.max(m,Math.min(y,innerHeight-r.height-m))+"px";MENU={el,items:[],sid:s.id};
 void el.offsetWidth;el.style.animation="";requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add("live")))}
function gpClick(e){e.stopPropagation();const s=S.find(x=>x.id===MENU.sid);if(!s)return;const t=e.target,root=MENU.el;let el;
 if(el=t.closest("[data-model]")){if(s.agent!=="claude"){toast("Model applies to Claude Code agents");return}const m=el.dataset.model;updateDial(root,m);tune(s,{model:m}).then(r=>{if(r.error)return;if(m)navigator.clipboard?.writeText("/model "+m).catch(()=>{});toast(m?m.toUpperCase()+" for messages from the board. Copied /model "+m+" for the Claude app":"Model back to automatic")});return}
 if(el=t.closest("[data-effort]")){if(s.agent!=="claude"){toast("Effort applies to Claude Code agents");return}const ef=el.dataset.effort;updateLeds(root,ef);tune(s,{effort:ef}).then(r=>{if(!r.error)toast(ef?ef.toUpperCase()+" effort for messages from the board":"Effort back to automatic")});return}
 if(el=t.closest("[data-sw]")){const k=el.dataset.sw;el.querySelector(".swt").classList.toggle("on");if(k==="pin"){const on=!s.pinned;s.pinned=on;pinSession(s.id,on)}else{muted[s.id]=!muted[s.id];render();toast(muted[s.id]?"Clash warnings hidden":"Clash warnings shown")}return}
 if(el=t.closest("[data-mrole]")){const role=el.dataset.mrole;hideMenu();post("api/role",{id:s.id,role}).then(()=>{last="";load();toast(role?"Now a "+role+" agent":"Back to automatic")});return}
 if(el=t.closest("[data-tile]")){const k=el.dataset.tile;hideMenu();if(k==="skills"){sel=s.id;showSkills=true;first=true;render()}else openIn(s.id,k);return}
 if(el=t.closest("[data-close]")){const on=!s.hidden;if(on&&sel===s.id){const nx=S.find(x=>x.id!==s.id&&!x.hidden);if(nx)sel=nx.id}hideMenu();post("api/hide",{id:s.id,hidden:on}).then(r=>{if(r.error){toast(r.error);return}last="";load();toast(on?"Closed. It is under Closed at the bottom":"Reopened")});return}
 if(el=t.closest("[data-del]")){if(s.viaApp===true){el.classList.add("nope");setTimeout(()=>el.classList.remove("nope"),450);toast("This session is in the Claude app. Delete it there.");return}
  if(!el.classList.contains("arm")){el.classList.add("arm");el.querySelector("b").textContent="Click again";clearTimeout(el._t);el._t=setTimeout(()=>{el.classList.remove("arm");el.querySelector("b").textContent="Delete"},3000);return}
  hideMenu();post("api/delete",{id:s.id}).then(r=>{if(r.error){toast(r.error);return}last="";load();toast("Session deleted")});return}
 if(el=t.closest("[data-copy]")){const k=el.dataset.copy;cp(k==="name"?(s.title||""):k==="id"?s.id:"cd "+s.cwd+" && "+(s.agent==="codex"?"codex resume ":"claude --resume ")+s.id);return}}
document.addEventListener("contextmenu",async e=>{const tg=e.target.tagName;if(tg==="TEXTAREA"||tg==="INPUT"||tg==="SELECT")return;e.preventDefault();if(e.target.closest(".cmenu"))return;hideMenu();
 const x=e.clientX,y=e.clientY,row=e.target.closest("[data-sel]"),face=e.target.closest("[data-face]"),hd=e.target.closest("#hd");
 const id=row?row.dataset.sel:face?face.dataset.face:hd?sel:"";
 if(id){const s=S.find(v=>v.id===id);if(s){await opts();showPanel(x,y,s)}return}
 const m=e.target.closest("[data-msg]");if(m){const tx=(m.querySelector(".rich")||{}).textContent||"";showMenu(x,y,[{label:"Copy message",run:()=>cp(tx)}],"","")}});
document.addEventListener("click",e=>{if(MENU&&!e.target.closest(".cmenu"))hideMenu()});
window.addEventListener("blur",hideMenu);window.addEventListener("resize",hideMenu);
let scT=0,feedHover=false,lastUser=0;
function atBottom(f){return f.scrollTop+f.clientHeight>=f.scrollHeight-40}
function updatePill(){const f=$("feed"),p=$("newpill");if(f&&p)p.classList.toggle("on",!atBottom(f))}
/* A new message while you are not at the bottom: after 5 seconds, scroll down, unless the mouse is over the messages, text is selected, or you scrolled in the last few seconds. */
function armScroll(){clearTimeout(scT);updatePill();scT=setTimeout(function tick(){const f=$("feed");if(!f||atBottom(f)){updatePill();return}
 if(!feedHover&&!String(getSelection()).length&&Date.now()-lastUser>4500){f.scrollTo({top:f.scrollHeight,behavior:"smooth"});setTimeout(updatePill,800)}else scT=setTimeout(tick,5000)},5000)}
(function(){const f=$("feed");f.addEventListener("mouseenter",()=>{feedHover=true});f.addEventListener("mouseleave",()=>{feedHover=false});f.addEventListener("scroll",updatePill);["wheel","touchmove","mousedown","keydown"].forEach(n=>f.addEventListener(n,()=>{lastUser=Date.now()},{passive:true}))})();
document.addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"&&e.target.id!=="ntext"){const t=$("msg"),b=document.querySelector("#feed .obtn.first:not(.done)");if(b&&(!t||!t.value.trim())){e.preventDefault();answer(b.dataset.opt)}}});
/* In the Mac app, dragging anywhere that is not a control moves the window. */
document.addEventListener("mousedown",e=>{const h=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.drag;if(!h||e.button!==0||e.detail>1)return;
 if(e.target.closest('button,a,input,textarea,select,[data-act],[data-sel],[data-face],[data-msg],[data-opt],[data-mpick],[data-pick],[data-prs],[data-ctext],[data-grp],[draggable="true"],.bub,.cmenu,.dcard,.dz,.prpop,.rich,.swr,.led,.ml,.tl,.cb,.rc,.fc,.sg,.lbtn,.clip,.att,.obtn,.compose,#drop,.dlg'))return;h.postMessage(0)});
load();setInterval(load,3000);
</script></body></html>`;
