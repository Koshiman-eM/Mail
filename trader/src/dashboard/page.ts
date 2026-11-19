/**
 * ダッシュボードの単一 HTML (日本語・インライン CSS/JS・外部 CDN なし・5 秒ごとに自動更新)。
 * 既定の「ボード」タブはコックピット風の一覧 (粒子の雲・SIGNAL STACK・チャート・ENGINE LOG など)。常に暗いテーマ。
 * 注意: テンプレート文字列なので、中の JS ではバッククォートとバックスラッシュを使わない。
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>TRADER // AUTO · 自動売買ダッシュボード</title>
<style>
:root {
  --bg: #060a14; --line: #1a2335; --line2: #26324a; --fg: #c9d4e5; --hi: #eef3fb; --mut: #7a89a3; --dim: #3b4862; --num: #b9c6ff;
  --y: #f5c542; --yd: rgba(245,197,66,.10); --c: #5ec8f2; --b: #5b7cfa; --p: #a78bfa; --g: #3ddc97; --r: #ff5d6c; --o: #ff9f43;
  --pos: var(--g); --neg: var(--r); --muted: var(--mut); --chip: #0f1729; --accent: var(--c); --warn: var(--y);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", monospace;
}
* { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; color: var(--fg); font: 12.5px/1.5 var(--mono); background: radial-gradient(1400px 760px at 50% 38%, #0b1428 0%, var(--bg) 64%) fixed; overflow-x: hidden; overflow-x: clip; }
body.on-board { padding-bottom: 34px; }
button, select { font: inherit; }
[hidden] { display: none !important; }
.j { letter-spacing: .04em; text-transform: none; color: var(--mut); font-weight: 400; }
.pos { color: var(--g); } .neg { color: var(--r); } .muted { color: var(--mut); } .err { color: var(--r); }

/* ───── ヘッダー ───── */
header.top { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px 24px; align-items: center; padding: 10px 14px 9px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #0a1122, #070c18); }
.brand { min-width: 0; }
.brand .sub { font-size: 10px; letter-spacing: .2em; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand .name { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 21px; font-weight: 800; letter-spacing: .16em; color: var(--hi); line-height: 1.3; }
.brand .name i { font-style: normal; color: var(--y); }
.rb { font-size: 10.5px; font-weight: 700; letter-spacing: .18em; padding: 1px 8px; border: 1px solid var(--dim); border-radius: 2px; color: var(--mut); white-space: nowrap; }
.rb.paper { color: var(--y); border-color: rgba(245,197,66,.6); background: var(--yd); }
.rb.live { color: #fff; border-color: var(--r); background: var(--r); box-shadow: 0 0 12px rgba(255,93,108,.5); }
.sub2 { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 10.5px; letter-spacing: .1em; color: var(--mut); margin-top: 2px; }
.rk { font-weight: 700; } .rk.ok { color: var(--g); } .rk.warn { color: var(--y); } .rk.ng { color: var(--r); }
.dots { display: none; color: var(--hi); font-size: 15px; letter-spacing: .5em; text-align: center; white-space: nowrap; }
.ctrs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px; }
.ctr { min-width: 0; }
.ctr .k { font-size: 10px; letter-spacing: .16em; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ctr .v { font-size: 18px; font-weight: 700; color: var(--num); font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.3; }
.ctr .v.pos { color: var(--g); } .ctr .v.neg { color: var(--r); }
.clock .v { color: var(--hi); }
.clock .tz { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .18em; color: var(--y); border: 1px solid rgba(245,197,66,.6); padding: 0 6px; }
.flash { animation: flash .9s ease-out; }
@keyframes flash { 0% { color: #fff; text-shadow: 0 0 16px rgba(245,197,66,.95); } 100% { text-shadow: 0 0 0 transparent; } }
@media (min-width: 761px) {
  header.top { grid-template-columns: minmax(0, auto) 1fr auto; padding: 10px 18px; }
  .ctrs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px 26px; align-items: flex-start; }
  .ctr .v { font-size: 21px; }
  .clock { padding-left: 18px; border-left: 1px solid var(--line); }
  .clock .v { font-size: 24px; line-height: 1.2; }
}

/* ───── タブ ───── */
nav#tabs { position: sticky; top: 0; z-index: 8; display: flex; padding: 0 6px; background: rgba(6,10,20,.97); border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
nav#tabs::-webkit-scrollbar { display: none; }
nav#tabs button { flex: 0 0 auto; padding: 9px 9px 7px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--mut); font-size: 12px; letter-spacing: .1em; cursor: pointer; white-space: nowrap; }
nav#tabs button:hover { color: var(--fg); }
nav#tabs button[aria-selected="true"] { color: var(--y); border-bottom-color: var(--y); }
nav#tabs button:focus-visible { outline: 1px solid var(--y); outline-offset: -3px; }
nav#tabs .j { color: inherit; opacity: .7; }
@media (max-width: 480px) { nav#tabs .hide-s { display: none; } nav#tabs { padding: 0 2px; } nav#tabs button { padding: 9px 7px 7px; letter-spacing: .04em; } }

/* ───── 流れる帯・ティッカー ───── */
.marq { display: flex; height: 28px; border-bottom: 1px solid var(--line); background: #070b16; overflow: hidden; }
.marq .ml { flex: none; display: flex; align-items: center; padding: 0 12px; background: var(--r); color: #fff; font-weight: 800; font-size: 11px; letter-spacing: .2em; }
.mv { position: relative; flex: 1; min-width: 0; overflow: hidden; -webkit-mask-image: linear-gradient(90deg, transparent, #000 24px, #000 calc(100% - 24px), transparent); mask-image: linear-gradient(90deg, transparent, #000 24px, #000 calc(100% - 24px), transparent); }
.mt { display: inline-flex; height: 100%; align-items: center; white-space: nowrap; animation: mq 90s linear infinite; }
.mt > span { padding-right: 56px; }
.marq .mt { font-size: 12px; letter-spacing: .06em; color: #8d9cb6; }
.mt b { color: var(--y); font-weight: 700; letter-spacing: .12em; }
.mt em { font-style: normal; font-weight: 700; letter-spacing: .1em; }
.mt .sep { color: var(--dim); padding: 0 12px; }
.mt .ar { color: var(--y); padding: 0 10px; }
@keyframes mq { from { transform: translateX(0); } to { transform: translateX(-50%); } }
body.anim-off .mt, body.anim-off .cur { animation-play-state: paused; }
.ticker { position: fixed; left: 0; right: 0; bottom: 0; z-index: 8; height: 30px; display: flex; align-items: center; overflow: hidden; background: rgba(5,8,16,.97); border-top: 1px solid var(--line); font-size: 12px; letter-spacing: .1em; color: #9aa8c0; }
.tk-s { color: var(--hi); font-weight: 700; } .tk-k { color: var(--mut); }
body:not(.on-board) .bo { display: none; }

/* ───── パネル ───── */
.pn, .flat { min-width: 0; display: flex; flex-direction: column; position: relative; background: linear-gradient(180deg, rgba(12,18,34,.94), rgba(7,11,22,.94)); border: 1px solid var(--line); border-radius: 3px; }
.ph { display: flex; align-items: center; gap: 10px; margin: 0; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 10.5px; font-weight: 400; letter-spacing: .2em; text-transform: uppercase; color: #c3cee0; white-space: nowrap; min-width: 0; }
.ph .t { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ph .t::before { content: "• "; color: var(--hi); }
.ph .jp { margin-left: 8px; color: var(--mut); letter-spacing: .06em; text-transform: none; }
.ph .st { margin-left: auto; flex: none; color: var(--y); letter-spacing: .14em; }
.pb { padding: 8px 10px; min-width: 0; }
.note { font-size: 11.5px; color: var(--mut); margin-top: 4px; overflow-wrap: anywhere; }
.empty { color: var(--mut); font-size: 12px; padding: 6px 0; }

/* ───── ボードの配置 (スマホ: 1 列・重要度順 / 中: 6 列 / 広: 12 列) ───── */
#board { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.midframe, .mh { display: none; }
.a-cloud { order: 1; } .a-stack { order: 2; } .a-chart { order: 3; } .a-log { order: 4; } .a-mini { order: 5; } .a-run { order: 6; }
.a-heat { order: 7; } .a-alloc { order: 8; } .a-pnl { order: 9; } .a-ntr { order: 10; } .a-rb { order: 11; } .a-cost { order: 12; }
@media (min-width: 761px) {
  #board { display: grid; gap: 10px; padding: 10px 12px 14px; grid-template-columns: repeat(6, minmax(0, 1fr)); grid-template-areas:
    "mh mh mh mh mh mh" "cloud cloud cloud cloud stack stack" "run run run run stack stack" "mini mini mini mini mini mini"
    "chart chart chart log log log" "heat heat heat alloc alloc alloc" "pnl pnl pnl ntr ntr ntr" "rb rb rb cost cost cost"; }
  .midframe { display: block; grid-row: 1 / 5; grid-column: 1 / -1; border: 1px solid var(--line); border-radius: 3px; background: radial-gradient(900px 460px at 45% 42%, rgba(18,30,62,.5), rgba(7,11,22,.75)); }
  .mh { display: flex; }
  .flat { background: none; border: 0; border-radius: 0; }
  .a-log { grid-area: log; } .a-chart { grid-area: chart; } .a-heat { grid-area: heat; } .a-alloc { grid-area: alloc; } .a-mh { grid-area: mh; }
  .a-mini { grid-area: mini; } .a-cloud { grid-area: cloud; } .a-run { grid-area: run; margin: 0 0 10px 10px; } .a-stack { grid-area: stack; }
  .a-pnl { grid-area: pnl; } .a-ntr { grid-area: ntr; } .a-rb { grid-area: rb; } .a-cost { grid-area: cost; }
}
@media (min-width: 1200px) {
  .dots { display: block; }
  #board { grid-template-columns: repeat(12, minmax(0, 1fr)); grid-template-areas:
    "log log log log chart chart chart chart heat heat heat heat"
    "log log log log chart chart chart chart alloc alloc alloc alloc"
    "mh mh mh mh mh mh mh mh mh mh mh mh"
    "mini mini cloud cloud cloud cloud cloud cloud cloud stack stack stack"
    "mini mini run run run run run run run stack stack stack"
    "pnl pnl pnl pnl ntr ntr ntr rb rb rb cost cost"; }
  .midframe { grid-row: 3 / 6; }
  .a-run { margin: 0 0 10px 0; }
}
.mh { align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 10.5px; letter-spacing: .2em; color: #c3cee0; white-space: nowrap; min-width: 0; }
.mh .t { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mh b { color: var(--hi); }
.mh .st { margin-left: auto; color: var(--c); flex: none; }
.sh { padding: 8px 10px 4px; font-size: 10.5px; letter-spacing: .2em; color: var(--hi); font-weight: 700; }
.sh span { display: block; font-weight: 400; letter-spacing: .1em; color: var(--mut); font-size: 10px; }
.sh.y { color: var(--y); }

/* ENGINE LOG */
.cmd { padding: 6px 10px; font-size: 12px; color: var(--y); border-bottom: 1px dashed var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cmd .pr { color: var(--g); }
.cur { display: inline-block; width: 7px; height: 13px; margin-left: 4px; vertical-align: -2px; background: var(--y); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.logw { position: relative; flex: 1; min-height: 0; }
.log { list-style: none; margin: 0; padding: 4px 6px; font-size: 12px; overflow-y: auto; max-height: 300px; }
@media (min-width: 761px) { .logw { min-height: 240px; } .log { position: absolute; inset: 0; max-height: none; } }
.log li { display: grid; grid-template-columns: 60px 48px minmax(0, 1fr); gap: 6px; padding: 3px 4px; border: 1px solid transparent; color: #9fb0c8; }
.log li .t { color: var(--dim); } .log li .k { font-weight: 700; letter-spacing: .06em; } .log li .d { overflow-wrap: anywhere; }
.log li.now { border-color: rgba(245,197,66,.8); background: var(--yd); color: var(--hi); box-shadow: inset 0 0 14px rgba(245,197,66,.12); }
.log li.now .t { color: var(--y); }
.log li:nth-child(n+8) { opacity: .72; } .log li:nth-child(n+16) { opacity: .5; }
.log li.in { animation: lin .6s ease-out; }
@keyframes lin { from { opacity: 0; transform: translateX(-10px); } }
.pf { padding: 6px 10px 8px; border-top: 1px solid var(--line); font-size: 10.5px; letter-spacing: .1em; color: var(--mut); }
.segbar { display: flex; gap: 1px; height: 6px; margin-bottom: 5px; background: #0f1626; }
.segbar i { display: block; height: 100%; }

/* CHART */
.ctl { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
.ctl select { padding: 3px 8px; border: 1px solid var(--line2); border-radius: 2px; background: #0b1222; color: var(--hi); font-size: 12px; max-width: 100%; }
option { background: #0b1222; color: var(--hi); }
.seg { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.seg button { border: 1px solid var(--line2); background: transparent; color: var(--mut); font-size: 11.5px; letter-spacing: .06em; padding: 2px 8px; border-radius: 2px; cursor: pointer; }
.seg button[aria-pressed="true"] { color: #10131c; background: var(--y); border-color: var(--y); font-weight: 700; }
#candles svg, #chart svg, .tape svg { display: block; width: 100%; }

/* STRATEGY × REGIME */
.heat-wrap { display: flex; gap: 12px; }
.heat { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(5, minmax(0, 1fr)); gap: 3px 4px; align-items: center; }
.heat .rl { font-size: 11px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.heat .ch { font-size: 10px; letter-spacing: .06em; color: var(--mut); text-align: center; white-space: nowrap; overflow: hidden; }
.cell { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1px; padding: 1px; border: 1px solid transparent; }
.cell i { display: block; aspect-ratio: 1 / 1; background: #111a2c; }
.cell.off { opacity: .32; border-color: rgba(255,93,108,.5); }
.heat-side { flex: none; width: 82px; display: flex; flex-direction: column; gap: 6px; border-left: 1px solid var(--line); padding-left: 10px; }
.hs .k { font-size: 10px; letter-spacing: .14em; color: var(--mut); } .hs .v { font-size: 19px; font-weight: 800; color: var(--y); line-height: 1.2; white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 3px 12px; padding: 2px 10px 8px; font-size: 10.5px; color: var(--mut); letter-spacing: .06em; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; }
@media (max-width: 760px) { .heat-wrap { flex-direction: column; } .heat-side { width: auto; flex-direction: row; justify-content: space-between; border-left: 0; border-top: 1px solid var(--line); padding: 6px 0 0; } }

/* ALLOCATION */
.al { display: grid; grid-template-columns: minmax(0, 132px) minmax(0, 1fr) 54px; gap: 2px 10px; align-items: center; padding: 3px 0; }
.al .nm { font-size: 11.5px; color: var(--hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: .04em; text-transform: uppercase; }
.al .nm.top { color: var(--y); }
.al .sb { font-size: 10px; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.al .bar2 { position: relative; height: 14px; background: repeating-linear-gradient(90deg, #131c2f 0 1px, transparent 1px 14px); border-left: 1px solid var(--line2); }
.al .bar2 i { position: absolute; left: 0; top: 3px; bottom: 3px; background: repeating-linear-gradient(90deg, var(--bc, #5b7cfa) 0 2px, transparent 2px 4px); }
.al .bar2 .one { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--hi); opacity: .55; }
.al .v { text-align: right; font-size: 14px; font-weight: 700; color: var(--hi); font-variant-numeric: tabular-nums; }

/* 指標のミニカード */
.mini { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; padding: 4px 10px 10px; }
.mc { border: 1px solid var(--line); background: rgba(10,17,34,.92); padding: 6px 8px 4px; min-width: 0; }
.mc .k { font-size: 10px; letter-spacing: .14em; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mc .v { font-size: 18px; font-weight: 700; color: var(--hi); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
.spk { display: block; width: 100%; height: 30px; }
@media (min-width: 1200px) { .a-mini .mini { grid-template-columns: minmax(0, 1fr); } }

/* 粒子の雲 */
.cl-stage { position: relative; height: 340px; overflow: hidden; }
@media (min-width: 761px) { .cl-stage { height: 470px; } }
@media (min-width: 1200px) { .cl-stage { height: 500px; } }
#cloud { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cl-cap { position: absolute; left: 10px; top: 8px; z-index: 1; font-size: 10.5px; letter-spacing: .12em; color: #7f9be0; pointer-events: none; text-shadow: 0 0 6px #060a14, 0 0 2px #060a14; }
.cl-cap b { color: #a9c0ff; }
.cl-cap span { color: var(--mut); }
@media (max-width: 480px) { .cl-cap span, .cl-cap br { display: none; } }
.cl-leg { position: absolute; left: 10px; bottom: 6px; z-index: 1; display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 10.5px; color: var(--mut); pointer-events: none; text-shadow: 0 0 4px #060a14; }
.cl-now { padding: 6px 10px; font-size: 12px; color: var(--fg); border-top: 1px dashed var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-now .src { color: var(--c); margin-right: 6px; letter-spacing: .08em; }

/* THIS RUN */
.rr { display: grid; grid-template-columns: 50px minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; padding: 6px 10px; border-bottom: 1px dashed #141c2c; }
.rr:last-child { border-bottom: 0; }
.rr .tg2 { font-size: 10px; letter-spacing: .08em; color: var(--c); border: 1px solid rgba(94,200,242,.45); text-align: center; padding: 1px 0; }
.rr .nm { font-size: 12px; font-weight: 700; color: var(--hi); letter-spacing: .06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; }
.rr.best .nm { color: var(--y); } .rr.best .tg2 { color: var(--y); border-color: rgba(245,197,66,.6); }
.rr .sb { font-size: 10px; color: var(--mut); letter-spacing: .06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rr .rv { text-align: right; white-space: nowrap; } .rr .rv b { display: block; font-size: 16px; color: var(--hi); font-variant-numeric: tabular-nums; } .rr .rv span { font-size: 12px; }
.db { position: relative; height: 7px; margin-top: 4px; background: repeating-linear-gradient(90deg, #172036 0 3px, transparent 3px 5px); }
.db i { position: absolute; left: 0; top: 0; bottom: 0; background: repeating-linear-gradient(90deg, var(--bc, #5b7cfa) 0 3px, transparent 3px 5px); }
.db.glow i { box-shadow: 0 0 10px rgba(245,197,66,.35); }

/* SIGNAL STACK */
.stk { position: relative; flex: 1; min-height: 0; }
.stk-in { display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 10px; }
@media (min-width: 761px) { .stk { min-height: 320px; } .stk-in { position: absolute; inset: 0; overflow-y: auto; } }
.sc { border: 1px solid var(--line); border-left: 3px solid var(--sc, #5ec8f2); background: rgba(10,16,30,.94); padding: 6px 10px 6px; min-width: 0; }
.sc .sq { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--mut); min-width: 0; }
.sc .sq .q { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tg { flex: none; font-size: 10px; letter-spacing: .12em; padding: 0 5px; border: 1px solid var(--sc, #5ec8f2); color: var(--sc, #5ec8f2); border-radius: 2px; }
.sc .sv { font-size: 21px; font-weight: 700; color: var(--hi); font-variant-numeric: tabular-nums; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc .sv.pos { color: var(--g); } .sc .sv.neg { color: var(--r); } .sc .sv.no { color: var(--r); font-size: 19px; }
.sc .sf { font-size: 10.5px; color: var(--mut); letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc .sf .bull { color: var(--g); } .sc .sf .bear { color: var(--r); }

/* 下段 */
.cards3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.bc { border: 1px solid var(--line2); background: #0a1122; padding: 7px 10px; min-width: 0; }
.bc.hl { border-color: var(--y); box-shadow: inset 0 0 0 1px rgba(245,197,66,.2), 0 0 18px rgba(245,197,66,.07); }
.bc .k { font-size: 10.5px; letter-spacing: .06em; color: var(--hi); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc.hl .k { color: var(--y); }
.bc .bd { display: inline-block; margin-top: 3px; font-size: 10px; padding: 0 5px; border: 1px solid var(--mut); color: var(--mut); letter-spacing: .06em; }
.bc .bd.pos { border-color: var(--g); color: var(--g); } .bc .bd.neg { border-color: var(--r); color: var(--r); }
.bc .v { font-size: 23px; font-weight: 800; color: var(--hi); font-variant-numeric: tabular-nums; line-height: 1.3; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc .v.pos { color: var(--g); } .bc .v.neg { color: var(--r); }
.kv2 { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 8px; font-size: 10.5px; color: var(--mut); margin-top: 2px; }
.kv2 b { color: var(--fg); font-weight: 400; text-align: right; white-space: nowrap; }
.tape { margin-top: 8px; }
.cap { font-size: 10.5px; letter-spacing: .08em; color: var(--y); margin-top: 2px; overflow-wrap: anywhere; }
.xtop { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
.xbig { font-size: 42px; font-weight: 800; color: var(--y); line-height: 1; white-space: nowrap; }
.xbig small { font-size: 26px; margin-right: 2px; }
.xs { font-size: 10.5px; color: var(--mut); letter-spacing: .08em; line-height: 1.55; min-width: 0; } .xs b { color: var(--hi); }
.sr { display: grid; grid-template-columns: minmax(0, 1fr) auto 48px; gap: 2px 8px; align-items: center; padding: 4px 6px; border: 1px solid transparent; }
.sr .nm { font-size: 11px; letter-spacing: .08em; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; }
.sr .pv { font-size: 16px; font-weight: 700; color: var(--hi); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sr .bd { font-size: 10px; text-align: center; border: 1px solid var(--r); color: var(--r); padding: 0 2px; white-space: nowrap; }
.sr .bd.g { border-color: var(--g); color: var(--g); }
.sr .hb { grid-column: 1 / 3; height: 5px; background: #172036; }
.sr .hb i { display: block; height: 100%; background: #7d8aa3; }
.sr .hb i.neg { background: #8a4a55; }
.sr.best { border-color: var(--y); background: var(--yd); }
.sr.best .nm, .sr.best .pv { color: var(--y); }
.sr.best .bd { background: var(--y); border-color: var(--y); color: #12141c; font-weight: 700; }
.sr.best .hb i { background: var(--y); }
.rbr { padding: 5px 0 7px; border-bottom: 1px dashed #141c2c; }
.rbr:last-of-type { border-bottom: 0; }
.rbr .top { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
.rbr .lb { font-size: 10.5px; letter-spacing: .12em; color: var(--fg); min-width: 0; }
.rbr .lb span { display: block; color: var(--mut); font-size: 10px; letter-spacing: .04em; }
.rbr .lb.y { color: var(--y); }
.rbr .rv2 { margin-left: auto; font-size: 21px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1.2; }
.ct { width: 100%; border-collapse: collapse; font-size: 12px; }
.ct td { padding: 4px 0; border-bottom: 1px dashed #141c2c; white-space: normal; }
.ct td:last-child { text-align: right; color: var(--hi); font-weight: 700; white-space: nowrap; padding-left: 8px; }
.ct td span { display: block; font-size: 10px; color: var(--mut); letter-spacing: .08em; }
.bill { margin: 10px 0 0 auto; width: fit-content; min-width: 62%; max-width: 100%; border: 1px solid var(--y); background: var(--yd); padding: 6px 10px; }
.bill .k { font-size: 10px; letter-spacing: .14em; color: var(--y); }
.bill .v { font-size: 26px; font-weight: 800; color: var(--y); line-height: 1.2; white-space: nowrap; }
.bill .s { font-size: 10px; color: var(--g); letter-spacing: .08em; }

/* ───── 他のタブ ───── */
#panes { display: grid; gap: 10px; padding: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); max-width: 1500px; margin: 0 auto; }
#panes .wide { grid-column: 1 / -1; }
#panes .pb h2 { font-size: 10.5px; letter-spacing: .18em; color: var(--y); margin: 14px 0 6px; font-weight: 700; }
.big { font-size: 28px; font-weight: 800; color: var(--num); font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--mut); font-weight: 400; font-size: 10.5px; letter-spacing: .12em; background: #0a1020; }
tbody tr:hover td { background: rgba(94,200,242,.04); }
td.num, th.num { text-align: right; }
.chip { display: inline-block; margin: 1px 2px; padding: 0 6px; border: 1px solid var(--line2); border-radius: 2px; background: var(--chip); font-size: 11px; }
.chip.loss { color: var(--r); border-color: rgba(255,93,108,.4); } .chip.win { color: var(--g); border-color: rgba(61,220,151,.4); }
ul.plain { margin: 0; padding-left: 18px; } ul.plain li { margin: 3px 0; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; }
.bar { height: 7px; background: repeating-linear-gradient(90deg, var(--c) 0 2px, transparent 2px 4px); }
.dbar { position: relative; height: 10px; min-width: 120px; background: #111a2c; }
.dbar::after { content: ""; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px; background: var(--mut); }
.dbar span { position: absolute; top: 0; bottom: 0; }
.dbar.wide { height: 14px; }
.tone { display: inline-block; min-width: 64px; text-align: center; padding: 0 6px; border: 1px solid var(--line2); font-size: 11px; font-weight: 700; }
.tone.bull { color: var(--g); border-color: rgba(61,220,151,.5); } .tone.bear { color: var(--r); border-color: rgba(255,93,108,.5); }
.scale { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--mut); }
@media (max-width: 600px) { .dbar { min-width: 56px; } .tone { min-width: 0; } th, td { padding: 4px 6px; } .big { font-size: 24px; } }
@media (prefers-reduced-motion: reduce) {
  .mt { animation: none; } .mv, .ticker { overflow-x: auto; } .flash, .log li.in { animation: none; } .cur { animation: none; }
}
</style>
</head>
<body class="anim-off">
<header class="top">
  <div class="brand">
    <div class="sub">SIGNALS → STRATEGY → ORDER · 閲覧専用</div>
    <div class="name"><span>TRADER <i>//</i> AUTO</span><span id="mode" class="rb">RUN · -</span></div>
    <div class="sub2"><span id="riskBadge" class="rk">● -</span><span>更新 <span id="updated">-</span></span><span id="error" class="err"></span></div>
  </div>
  <div class="dots" aria-hidden="true">• • •</div>
  <div class="ctrs">
    <div class="ctr"><div class="k" id="kEq">EQUITY</div><div class="v" id="cEq">-</div></div>
    <div class="ctr"><div class="k">P&amp;L <span class="j">損益</span></div><div class="v" id="cPnl">-</div></div>
    <div class="ctr"><div class="k">WIN RATE <span class="j">勝率</span></div><div class="v" id="cWin">-</div></div>
    <div class="ctr"><div class="k">TRADES <span class="j">取引</span></div><div class="v" id="cTr">-</div></div>
    <div class="ctr"><div class="k">TICK</div><div class="v" id="cTick">-</div></div>
    <div class="ctr clock"><div class="v" id="clock">--:--:--</div><span class="tz">JST</span></div>
  </div>
</header>
<nav id="tabs" role="tablist" aria-label="表示の切り替え">
  <button type="button" role="tab" data-tab="board">◆ BOARD <span class="j hide-s">ボード</span></button>
  <button type="button" role="tab" data-tab="overview">概要</button>
  <button type="button" role="tab" data-tab="market">強気・弱気</button>
  <button type="button" role="tab" data-tab="positions">ポジション</button>
  <button type="button" role="tab" data-tab="trades">取引</button>
  <button type="button" role="tab" data-tab="learning">学習</button>
</nav>
<div class="marq bo" aria-label="処理の流れ"><span class="ml">FLOW</span><div class="mv"><div class="mt" id="marq"></div></div></div>

<main id="board" data-pane="board">
  <div class="midframe" aria-hidden="true"></div>
  <section class="pn a-log">
    <h2 class="ph"><span class="t">ENGINE LOG · TRACE<span class="jp">判断の記録</span></span><span class="st" id="logSt">● -</span></h2>
    <div class="cmd"><span class="pr">$</span> tail -f engine.audit<span class="cur"></span></div>
    <div class="logw"><ol id="log" class="log"></ol></div>
    <div class="pf" id="logFoot"></div>
  </section>
  <section class="pn a-chart">
    <h2 class="ph"><span class="t">CHART · <span id="chSym">-</span><span class="jp">チャート</span></span><span class="st" id="chSt">● -</span></h2>
    <div class="pb">
      <div class="ctl"><select id="chartSymbol" aria-label="銘柄"></select><div id="chartTfs" class="seg" role="group" aria-label="時間足"></div></div>
      <div id="candles"></div>
      <div id="candleInfo" class="note"></div>
    </div>
  </section>
  <section class="pn a-heat">
    <h2 class="ph"><span class="t">STRATEGY × REGIME<span class="jp">腕の成績 · 期待 R</span></span><span class="st" id="heatSt">● -</span></h2>
    <div class="pb heat-wrap"><div id="heat" class="heat"></div><div id="heatSide" class="heat-side"></div></div>
    <div class="legend"><span><i style="background:#3ddc97"></i>+R</span><span><i style="background:#f5c542"></i>±0</span><span><i style="background:#ff5d6c"></i>−R</span><span><i style="background:#111a2c;outline:1px solid #26324a"></i>未取引</span><span><i style="background:#3b4862;outline:1px solid #ff5d6c"></i>無効</span><span>■ = 取引数</span></div>
  </section>
  <section class="pn a-alloc">
    <h2 class="ph"><span class="t">ALLOCATION<span class="jp">戦略ごとの配分倍率</span></span><span class="st" id="allocSt">● -</span></h2>
    <div class="pb" id="alloc"></div>
    <div class="pf" id="allocFoot"></div>
  </section>
  <div class="mh a-mh"><span class="t">• <b id="mhCount">0</b> ITEMS · NEWS · PRICES · STRATEGIES · RISK · ORDERS</span><span class="st" id="mhSt">● ENGINE</span></div>
  <section class="flat a-mini">
    <div class="sh">METRICS<span>指標 · 5 秒ごとに更新</span></div>
    <div id="mini" class="mini"></div>
  </section>
  <section class="flat a-cloud">
    <div class="cl-stage">
      <canvas id="cloud" aria-label="集めた情報とエンジンの判断を表す粒子の雲"></canvas>
      <div class="cl-cap"><b id="clCount">0 ITEMS</b> · EACH DOT A PIECE OF INTEL<br><span>点 = 集めた情報 1 件 · 波紋 = 戦略が読む · 金の線 = エンジンの判断</span></div>
      <div class="cl-leg"><span style="color:#3ddc97">● 強気</span><span style="color:#ff5d6c">● 弱気</span><span style="color:#c6d4f2">● 中立</span><span style="color:#f5c542">◎ ENGINE</span><span style="color:#5b7cfa">○ 戦略</span></div>
    </div>
    <div id="clNow" class="cl-now"><span class="src">READING</span>-</div>
  </section>
  <section class="pn a-run">
    <h2 class="ph"><span class="t">THIS RUN · STRATEGIES<span class="jp">戦略別</span></span><span class="st" id="runSt">● -</span></h2>
    <div id="run"></div>
  </section>
  <section class="flat a-stack">
    <div class="sh y">SIGNAL STACK<span>監視銘柄と直近の判断 · NEWEST ON TOP</span></div>
    <div class="stk"><div id="stack" class="stk-in"></div></div>
  </section>
  <section class="pn a-pnl">
    <h2 class="ph"><span class="t">P&amp;L<span class="jp">実現・含み損益</span></span><span class="st" id="pnlSt">● -</span></h2>
    <div class="pb"><div id="pnlCards" class="cards3"></div><div id="tape" class="tape"></div><div id="tapeCap" class="cap"></div></div>
  </section>
  <section class="pn a-ntr">
    <h2 class="ph"><span class="t" id="ntrT">× 0 TRADES · BY STRATEGY</span><span class="st">● 勝率</span></h2>
    <div class="pb" id="ntr"></div>
  </section>
  <section class="pn a-rb">
    <h2 class="ph"><span class="t">RISK BUDGET<span class="jp">リスク予算</span></span><span class="st" id="rbSt">● -</span></h2>
    <div class="pb" id="rb"></div>
  </section>
  <section class="pn a-cost">
    <h2 class="ph"><span class="t">COST<span class="jp">手数料</span></span><span class="st" id="costSt">● -</span></h2>
    <div class="pb" id="cost"></div>
  </section>
</main>

<main id="panes" hidden>
  <section class="pn" data-pane="overview">
    <h2 class="ph"><span class="t">EQUITY<span class="jp">評価額</span></span></h2>
    <div class="pb"><div id="equity" class="big">-</div><div id="equitySub" class="note"></div></div>
  </section>
  <section class="pn" data-pane="overview">
    <h2 class="ph"><span class="t">RISK STATE<span class="jp">リスク状態</span></span></h2>
    <div class="pb"><div id="risk" class="kv"></div></div>
  </section>
  <section class="pn wide" data-pane="overview">
    <h2 class="ph"><span class="t">EQUITY CURVE<span class="jp">評価額の推移</span></span></h2>
    <div class="pb"><div id="chart"></div></div>
  </section>
  <section class="pn wide" data-pane="market">
    <h2 class="ph"><span class="t">SENTIMENT<span class="jp">相場の強気・弱気</span></span></h2>
    <div class="pb"><div id="sentiment"></div></div>
  </section>
  <section class="pn" data-pane="market">
    <h2 class="ph"><span class="t">PLAN · INTEL<span class="jp">計画・情報</span></span></h2>
    <div class="pb"><div id="plan"></div></div>
  </section>
  <section class="pn wide" data-pane="positions">
    <h2 class="ph"><span class="t">POSITIONS<span class="jp">保有ポジション</span></span></h2>
    <div class="pb"><div id="positions" class="scroll"></div></div>
  </section>
  <section class="pn wide" data-pane="trades">
    <h2 class="ph"><span class="t">TRADES · CAUSES<span class="jp">直近のトレードと損益要因</span></span></h2>
    <div class="pb"><div id="trades" class="scroll"></div></div>
  </section>
  <section class="pn" data-pane="trades">
    <h2 class="ph"><span class="t">BY STRATEGY<span class="jp">戦略別の成績</span></span></h2>
    <div class="pb"><div id="byStrategy" class="scroll"></div></div>
  </section>
  <section class="pn" data-pane="learning">
    <h2 class="ph"><span class="t">CAUSES<span class="jp">損益要因の集計</span></span></h2>
    <div class="pb"><div id="causes"></div></div>
  </section>
  <section class="pn" data-pane="learning">
    <h2 class="ph"><span class="t">LESSONS<span class="jp">教訓</span></span></h2>
    <div class="pb"><div id="lessons"></div></div>
  </section>
  <section class="pn wide" data-pane="learning">
    <h2 class="ph"><span class="t">PARAM TUNING<span class="jp">パラメータ調整</span></span></h2>
    <div class="pb"><div id="adjustments" class="scroll"></div></div>
  </section>
  <section class="pn" data-pane="learning">
    <h2 class="ph"><span class="t">SOURCES<span class="jp">情報源の信頼度</span></span></h2>
    <div class="pb"><div id="sources" class="scroll"></div></div>
  </section>
  <section class="pn wide" data-pane="learning">
    <h2 class="ph"><span class="t">ARMS<span class="jp">腕の成績 (戦略×レジーム×資産クラス)</span></span></h2>
    <div class="pb"><div id="arms" class="scroll"></div></div>
  </section>
  <section class="pn wide" data-pane="learning">
    <h2 class="ph"><span class="t">SHADOW · SKIPPED SIGNALS<span class="jp">見送ったシグナルの答え合わせ</span></span></h2>
    <div class="pb"><div id="shadow"></div></div>
  </section>
  <section class="pn wide" data-pane="learning">
    <h2 class="ph"><span class="t">NEWS · PRICE CHECK<span class="jp">ニュースと値動きの答え合わせ</span></span></h2>
    <div class="pb"><div id="newsCheck"></div></div>
  </section>
</main>
<div class="ticker bo" aria-label="ティッカー"><div class="mt" id="tick"></div></div>
<script>
(function () {
  "use strict";
  var EXIT = { stop: "損切り", take_profit: "利確", trailing: "トレーリング", signal: "シグナル", time: "時間切れ", kill_switch: "キルスイッチ", manual: "手動" };
  var ADJ = { proposed: "提案のみ", applied: "適用", rejected: "却下", reverted: "差し戻し" };
  var DIR = { long: "買い", short: "売り" };
  var STRATS = ["scalp_obi", "scalp_vwap_revert", "scalp_momentum_burst", "short_ema_trend", "short_rsi_revert", "short_breakout", "mid_trend_follow", "long_momentum", "meme_momentum"];
  var REG = ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"];
  var REG_L = { trend_up: "UP", trend_down: "DOWN", range: "RANGE", high_vol: "HIVOL", low_liquidity: "LOLIQ" };
  var REG_J = { trend_up: "上昇トレンド", trend_down: "下降トレンド", range: "レンジ", high_vol: "高ボラティリティ", low_liquidity: "低流動性" };
  var C = { y: "#f5c542", g: "#3ddc97", r: "#ff5d6c", c: "#5ec8f2", b: "#5b7cfa", p: "#a78bfa", o: "#ff9f43", line: "#1a2335", line2: "#26324a", mut: "#7a89a3", dim: "#3b4862", hi: "#eef3fb", fg: "#c9d4e5" };
  var FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK JP", monospace';
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(x, d) {
    if (typeof x !== "number" || !isFinite(x)) return "-";
    var a = Math.abs(x);
    var digits = d != null ? d : a >= 1000 ? 0 : a >= 1 ? 2 : 6;
    return x.toLocaleString("ja-JP", { maximumFractionDigits: digits });
  }
  function signed(x, d) { return (typeof x === "number" && x > 0 ? "+" : "") + num(x, d); }
  function cls(x) { return typeof x === "number" && x > 0 ? "pos" : typeof x === "number" && x < 0 ? "neg" : ""; }
  function pct(x, d) { return typeof x === "number" && isFinite(x) ? (x * 100).toFixed(d == null ? 2 : d) + "%" : "-"; }
  function time(ts) {
    if (!ts) return "-";
    var d = new Date(ts);
    return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function pad2(n) { return ("0" + n).slice(-2); }
  function hms(ts) { var d = new Date(ts); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  /** 大きな数は M / B で縮める (ヘッダーの数字がスマホ幅に収まるように) */
  function big(x) {
    if (typeof x !== "number" || !isFinite(x)) return "-";
    var a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (a >= 1e7) return (x / 1e6).toFixed(2) + "M";
    return num(x, a >= 1000 ? 0 : 2);
  }
  function sbig(x) { return (typeof x === "number" && x > 0 ? "+" : "") + big(x); }
  function table(headers, rows, numeric) {
    if (!rows.length) return '<p class="empty">まだありません</p>';
    var h = "<table><thead><tr>" + headers.map(function (x, i) {
      return '<th class="' + (numeric && numeric[i] ? "num" : "") + '">' + esc(x) + "</th>";
    }).join("") + "</tr></thead><tbody>";
    rows.forEach(function (r) {
      h += "<tr>" + r.map(function (c, i) {
        return '<td class="' + (numeric && numeric[i] ? "num" : "") + '">' + c + "</td>";
      }).join("") + "</tr>";
    });
    return h + "</tbody></table>";
  }
  function set(id, html) { var el = $(id); if (el.__h !== html) { el.__h = html; el.innerHTML = html; } }
  function baseOf(sym) { return String(sym).split(/[/:|-]/)[0].toUpperCase(); }
  function horizonOf(id) { return { scalp: "SCALP", short: "SHORT", mid: "MID", long: "LONG", meme: "MEME" }[String(id).split("_")[0]] || "STRAT"; }
  function acctPnl(x) { return x.netPnlAccount != null ? x.netPnlAccount : x.netPnl; }
  function toneOf(x) { return x >= 0.3 ? ["強気", "bull"] : x >= 0.1 ? ["やや強気", "bull"] : x <= -0.3 ? ["弱気", "bear"] : x <= -0.1 ? ["やや弱気", "bear"] : ["中立", ""]; }

  // ───── 状態 ─────
  var S = null, TR = null, LE = null, EV = [], evSince = 0, evBooted = false, cur = "board";
  function animOK() { return cur === "board" && !document.hidden; }
  function tradeStats() {
    var o = { n: 0, wins: 0, losses: 0, pnl: 0, fees: 0, winRate: null };
    (TR ? TR.byStrategy : []).forEach(function (x) { o.n += x.trades; o.wins += x.wins; o.losses += x.losses; o.pnl += x.netPnl; o.fees += x.fees; });
    if (o.n) o.winRate = o.wins / o.n;
    return o;
  }
  /** 古い順のトレード */
  function tradesAsc() { return TR ? TR.trades.slice().sort(function (a, b) { return a.exitTs - b.exitTs; }) : []; }
  function biasMap() {
    var m = {};
    if (S && S.brief) S.brief.biases.forEach(function (x) { m[String(x.asset).toUpperCase()] = x; });
    return m;
  }
  function enabledStrategies() {
    var on = {};
    if (S && S.plan) S.plan.symbols.forEach(function (x) { x.enabledStrategies.forEach(function (id) { on[id] = true; }); });
    return Object.keys(on);
  }

  // ───── 数字のカウントアップと発光 ─────
  function flash(el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  function countTo(el, to, fmt) {
    if (typeof to !== "number" || !isFinite(to)) { el.__v = null; el.textContent = "-"; return; }
    var prev = el.__v;
    el.__v = to;
    if (prev === to) return;
    if (prev != null && !reduce) flash(el);
    if (reduce || document.hidden) { el.textContent = fmt(to); return; }
    var from = prev != null ? prev : 0, t0 = performance.now();
    function step(now) {
      var k = Math.min(1, (now - t0) / 800), v = from + (to - from) * (1 - Math.pow(1 - k, 3));
      el.textContent = fmt(k < 1 ? v : to);
      if (k < 1 && el.__v === to) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ───── ヘッダー ─────
  function renderHeader() {
    var s = S, m = $("mode");
    m.textContent = s.mode === "live" ? "RUN · LIVE" : "RUN · PAPER";
    m.className = "rb " + (s.mode === "live" ? "live" : "paper");
    m.title = s.mode === "live" ? "実弾 (LIVE)" : "ペーパー (仮想の資金)";
    var rb = $("riskBadge");
    if (s.risk.killSwitch) { rb.textContent = "● KILL SWITCH キルスイッチ作動中"; rb.className = "rk ng"; }
    else if (s.risk.halted) { rb.textContent = "● HALTED 新規停止中"; rb.className = "rk warn"; }
    else { rb.textContent = "● ACTIVE 稼働中"; rb.className = "rk ok"; }
    set("kEq", 'EQUITY <span class="j">' + esc(s.baseCurrency) + "</span>");
    countTo($("cEq"), s.equity.current, big);
    var diff = s.equity.current - s.equity.initial, pe = $("cPnl");
    countTo(pe, diff, sbig);
    pe.className = "v " + cls(diff);
    var st = tradeStats();
    countTo($("cWin"), st.winRate == null ? null : st.winRate * 100, function (v) { return v.toFixed(1) + "%"; });
    countTo($("cTr"), st.n, function (v) { return num(Math.round(v), 0); });
    countTo($("cTick"), s.tickCount, function (v) { return num(Math.round(v), 0); });
  }
  function tickClock() {
    if (document.hidden) return;
    var t = new Date(Date.now() + 9 * 3600000);
    $("clock").textContent = pad2(t.getUTCHours()) + ":" + pad2(t.getUTCMinutes()) + ":" + pad2(t.getUTCSeconds());
  }

  // ───── 監査ログの文言 ─────
  var EVT = { entry: ["ENTRY", C.g], exit: ["EXIT", C.y], skip: ["SKIP", "#8d9cb6"], plan: ["PLAN", C.c], order: ["ORDER", "#f472b6"], risk: ["RISK", C.r], learning: ["LEARN", C.p], system: ["SYS", C.mut], intel: ["INTEL", C.c] };
  function label(e) {
    var d = e.data || {};
    switch (e.type) {
      case "engine.entry": return (d.symbol || "") + " " + (DIR[d.direction] || "") + "エントリー @" + num(d.price) + " (" + (d.strategyId || "") + ")";
      case "engine.exit": return (d.symbol || "") + " 決済 @" + num(d.exitPrice) + " " + (EXIT[d.reason] || d.reason || "") + (typeof d.netPnl === "number" ? " 損益 " + signed(d.netPnl, 0) : "") + (typeof d.rMultiple === "number" ? " (" + num(d.rMultiple, 2) + "R)" : "");
      case "engine.skip_summary": return "見送り: " + (d.reason || "-");
      case "engine.plan": return "計画を更新 (対象 " + (d.active != null ? d.active : "-") + " 銘柄 / リスクオン " + signed(Number(d.riskOn) || 0, 2) + ")";
      case "engine.order_rejected": return (d.symbol || "") + " 注文が拒否されました " + (d.reason || "");
      case "engine.order_error": return (d.symbol || "") + " 発注エラー " + (d.reason || "");
      case "engine.order_cancel": return (d.symbol || "") + " 注文を取消";
      case "order.unknown_escalated": return (d.symbol || "") + " 注文の状態が不明 (新規エントリーを停止)";
      case "engine.entries_paused": return "新規エントリーを停止";
      case "engine.entries_resumed": return "新規エントリーを再開";
      case "risk.halt_daily": return "日次損失の上限で当日停止";
      case "risk.kill_switch": return "キルスイッチ作動";
      case "risk.resume": return "停止を解除";
      case "learning.param_adjust": return "パラメータ調整 " + (d.strategyId || "") + " " + (d.param || "") + " " + (d.from != null ? d.from + "→" + d.to : "");
      case "learning.param_revert": return "パラメータを元に戻す " + (d.strategyId || "") + " " + (d.param || "");
      case "learning.reflect": return "振り返りを実行";
      case "engine.start": return "エンジン起動";
      case "engine.stop": return "エンジン停止";
      default: return e.type;
    }
  }

  // ───── 流れる帯 (エンジンの段階 + 直近の記録) ─────
  function renderMarquee() {
    var s = S, b = s.brief, items = b ? b.itemCount || 0 : 0, lim = s.risk.limits;
    var last = null;
    for (var i = 0; i < EV.length; i++) if (EV[i].kind === "entry" || EV[i].kind === "exit") { last = EV[i]; break; }
    var steps = [
      "<b>STEP 1/5 MARKET</b> " + esc(s.watched.length + " 銘柄の気配を取得 · TICK " + num(s.tickCount, 0)),
      "<b>STEP 2/5 INTEL</b> " + esc(b ? items + " 件の情報を読む · リスクオン " + signed(b.riskOn, 2) : "情報収集を待っています"),
      "<b>STEP 3/5 STRATEGY</b> " + esc(s.plan ? enabledStrategies().length + " 戦略が有効 · " + s.plan.symbols.length + " 銘柄を計画" : "計画はまだありません"),
      "<b>STEP 4/5 RISK</b> " + esc("1 回のリスク " + pct(lim.riskPerTrade) + " · 保有 " + s.positions.length + "/" + lim.maxOpenPositions + (s.risk.killSwitch ? " · キルスイッチ" : s.risk.halted ? " · 新規停止中" : "")),
      "<b>STEP 5/5 ORDER</b> " + esc(last ? label(last) : "発注待ち"),
    ];
    var html = steps.join('<span class="ar">→</span>');
    EV.slice(0, 3).forEach(function (e) {
      var k = EVT[e.kind] || [String(e.kind).toUpperCase(), C.mut];
      html += '<span class="sep">·</span><em style="color:' + k[1] + '">' + esc(k[0]) + "</em> " + esc(hms(e.ts) + " " + label(e));
    });
    loopText("marq", html, 0.22);
  }
  /** 横に流れる文字列 (同じ内容を 2 回並べて -50% まで動かす。内容が同じなら触らない) */
  function loopText(id, html, perChar) {
    var el = $(id);
    if (el.__h === html) return;
    el.__h = html;
    el.innerHTML = "<span>" + html + '</span><span aria-hidden="true">' + html + "</span>";
    var len = (el.textContent || "").length / 2;
    el.style.animationDuration = Math.max(25, Math.round(len * perChar)) + "s";
  }

  // ───── ENGINE LOG ─────
  var logTop = 0;
  function renderLog() {
    if (!EV.length) {
      set("log", '<li class="now"><span class="t">--:--:--</span><span class="k">WAIT</span><span class="d">記録はまだありません<span class="cur"></span></span></li>');
      set("logSt", "● 0 EVENTS");
      return;
    }
    var html = EV.slice(0, 60).map(function (e, i) {
      var k = EVT[e.kind] || [String(e.kind).toUpperCase(), C.mut];
      var c = (i === 0 ? "now" : "") + (logTop && e.ts > logTop ? " in" : "");
      return '<li class="' + c + '"><span class="t">' + esc(hms(e.ts)) + '</span><span class="k" style="color:' + k[1] + '">' + esc(k[0]) + '</span><span class="d">' + esc(label(e)) + (i === 0 ? '<span class="cur"></span>' : "") + "</span></li>";
    }).join("");
    set("log", html);
    logTop = EV[0].ts;
    var cnt = {}, n = Math.min(60, EV.length);
    EV.slice(0, n).forEach(function (e) { cnt[e.kind] = (cnt[e.kind] || 0) + 1; });
    var keys = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
    set("logFoot", '<div class="segbar">' + keys.map(function (k) { return '<i style="flex:' + cnt[k] + ";background:" + (EVT[k] || ["", C.mut])[1] + '"></i>'; }).join("") + "</div>" +
      esc(n + " EVENTS · ") + keys.map(function (k) { return esc((EVT[k] || [k])[0] + " " + cnt[k]); }).join(" · "));
    set("logSt", "● " + n + " EVENTS · 5 S");
  }

  // ───── 監視銘柄のチャート (銘柄と時間足はこの端末に記憶する) ─────
  var CHART_KEY = "dashboard.chart";
  var chartSel = { symbol: null, tf: null };
  try { var cs0 = JSON.parse(localStorage.getItem(CHART_KEY) || "null"); if (cs0 && typeof cs0 === "object") chartSel = { symbol: cs0.symbol || null, tf: cs0.tf || null }; } catch (e) { /* 既定に戻す */ }
  var lastCandles = null;
  function saveChartSel() { try { localStorage.setItem(CHART_KEY, JSON.stringify(chartSel)); } catch (e) { /* 無視 */ } }
  var TF_LABEL = { "1m": "1分", "5m": "5分", "15m": "15分", "1h": "1時間", "4h": "4時間", "1d": "日足" };
  function syncSymbols(s) {
    var sel = $("chartSymbol");
    var syms = s.watched.map(function (w) { return w.symbol; });
    if (sel.options.length !== syms.length || syms.some(function (x, i) { return sel.options[i].value !== x; })) {
      sel.innerHTML = syms.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join("");
    }
    if (!chartSel.symbol || syms.indexOf(chartSel.symbol) < 0) chartSel.symbol = syms[0] || null;
    sel.value = chartSel.symbol || "";
    $("chSym").textContent = chartSel.symbol || "-";
  }
  function syncTfs(tfs) {
    if (!chartSel.tf || tfs.indexOf(chartSel.tf) < 0) chartSel.tf = tfs[0] || null;
    set("chartTfs", tfs.map(function (tf) {
      return '<button type="button" data-tf="' + esc(tf) + '" aria-pressed="' + (tf === chartSel.tf ? "true" : "false") + '">' + esc(TF_LABEL[tf] || tf) + "</button>";
    }).join(""));
  }
  function candleChart(cs, lines, band) {
    if (!cs || cs.length < 2) return '<p class="empty">足がたまるとチャートを表示します</p>';
    // 実際の表示幅で描く (縦横比を崩さず、スマホでも文字がつぶれないように)
    var cw = $("candles").clientWidth;
    var W = Math.max(300, Math.round(cw || 800)), H = window.innerWidth >= 1200 ? 420 : W < 500 ? 250 : 300, L = 4, R = 112, T = 8, VOL = 40, B = 20;
    var ph = H - T - B - VOL - 6;
    var lo = Infinity, hi = -Infinity, vmax = 0;
    cs.forEach(function (c) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); vmax = Math.max(vmax, c.volume || 0); });
    lines.forEach(function (l) { if (l.v > lo - (hi - lo) && l.v < hi + (hi - lo)) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); } });
    if (hi === lo) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    var n = cs.length, step = (W - L - R) / n, bw = Math.max(1, step * 0.66);
    function X(i) { return L + step * i + step / 2; }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * ph; }
    var g = "", taken = lines.filter(function (l) { return l.v >= lo && l.v <= hi; }).map(function (l) { return Y(l.v); });
    for (var k = 0; k <= 4; k++) {
      var v = lo + (hi - lo) * k / 4, yy = Y(v), y = yy.toFixed(1);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + C.line + '" />';
      if (!taken.some(function (t) { return Math.abs(t - yy) < 15; })) g += '<text x="' + (W - R + 6) + '" y="' + y + '" dominant-baseline="middle" font-size="11" fill="' + C.mut + '">' + esc(num(v)) + "</text>";
    }
    if (band) {
      var by1 = Y(Math.min(hi, Math.max(band[0], band[1]))), by2 = Y(Math.max(lo, Math.min(band[0], band[1])));
      if (by2 > by1) g += '<rect x="' + L + '" y="' + by1.toFixed(1) + '" width="' + (W - R - L) + '" height="' + (by2 - by1).toFixed(1) + '" fill="' + C.y + '" fill-opacity="0.06" />';
    }
    var vy0 = H - B, body = "";
    cs.forEach(function (c, i) {
      var up = c.close >= c.open, col = up ? C.g : C.r, x = X(i);
      var y1 = Y(Math.max(c.open, c.close)), y2 = Y(Math.min(c.open, c.close));
      body += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + Y(c.high).toFixed(1) + '" y2="' + Y(c.low).toFixed(1) + '" stroke="' + col + '" />' +
        '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, y2 - y1).toFixed(1) + '" fill="' + col + '" />';
      if (vmax > 0 && c.volume > 0) {
        var vh = (c.volume / vmax) * VOL;
        body += '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + (vy0 - vh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + vh.toFixed(1) + '" fill="' + col + '" fill-opacity="0.3" />';
      }
    });
    var ov = "";
    lines.forEach(function (l) {
      if (l.v < lo || l.v > hi) return;
      var y = Y(l.v);
      ov += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + l.color + '" stroke-width="' + (l.w || 1) + '" stroke-dasharray="' + (l.dash || "4 3") + '" />' +
        '<rect x="' + (W - R + 1.5) + '" y="' + (y - 8.5).toFixed(1) + '" width="' + (R - 3) + '" height="17" fill="#0a1020" stroke="' + l.box + '" />' +
        '<text x="' + (W - R + 6) + '" y="' + y.toFixed(1) + '" dominant-baseline="middle" font-size="11" fill="' + l.color + '">' + esc(l.label + " " + num(l.v)) + "</text>";
    });
    var t0 = time(cs[0].ts), t1 = time(cs[n - 1].ts);
    return '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '" role="img" aria-label="ローソク足チャート">' + g + body + ov +
      '<text x="' + L + '" y="' + (H - 5) + '" font-size="11" fill="' + C.mut + '">' + esc(t0) + "</text>" +
      '<text x="' + (W - R) + '" y="' + (H - 5) + '" text-anchor="end" font-size="11" fill="' + C.mut + '">' + esc(t1) + "</text></svg>";
  }
  function renderCandles() {
    var data = lastCandles;
    if (!data || data.symbol !== chartSel.symbol || data.tf !== chartSel.tf || cur !== "board") return;
    var cs = data.candles, lines = [], band = null;
    var last = cs.length ? cs[cs.length - 1] : null;
    if (last) lines.push({ v: last.close, label: "現在", color: C.c, box: C.c, dash: "2 2" });
    (S ? S.positions : []).forEach(function (p) {
      if (p.symbol !== data.symbol) return;
      lines.push({ v: p.entryPrice, label: "建値", color: C.y, box: C.y, dash: "1 0", w: 1.5 });
      lines.push({ v: p.stop, label: "損切", color: C.r, box: C.y });
      if (p.takeProfit != null) lines.push({ v: p.takeProfit, label: "利確", color: C.g, box: C.y });
      band = [p.stop, p.takeProfit != null ? p.takeProfit : p.entryPrice];
    });
    $("candles").innerHTML = candleChart(cs, lines, band);
    var chg = cs.length > 1 ? (last.close - cs[0].open) / cs[0].open : null;
    set("candleInfo", last ? esc(data.symbol) + " " + esc(TF_LABEL[data.tf] || data.tf) + " / 現在 " + esc(num(last.close)) +
      (chg != null ? ' / 表示期間 <span class="' + cls(chg) + '">' + esc((chg > 0 ? "+" : "") + pct(chg)) + "</span>" : "") +
      " / " + esc(cs.length) + " 本" + (cs.every(function (c) { return !c.volume; }) ? " (出来高なし)" : "") +
      (band ? ' / <span style="color:' + C.y + '">黄色の帯 = 保有中の損切り〜利確</span>' : "") : "");
    set("chSt", "● " + esc(TF_LABEL[data.tf] || data.tf) + " · " + cs.length + " BARS");
  }
  function loadCandles() {
    if (!chartSel.symbol || cur !== "board") return Promise.resolve();
    var q = "/api/candles?limit=120&symbol=" + encodeURIComponent(chartSel.symbol) + (chartSel.tf ? "&tf=" + encodeURIComponent(chartSel.tf) : "");
    return fetch(q, { cache: "no-store" }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      if (res.j && res.j.timeframes) syncTfs(res.j.timeframes);
      if (!res.ok) { $("candles").innerHTML = '<p class="empty">' + esc(res.j && res.j.error || "チャートを取得できません") + "</p>"; set("candleInfo", ""); return; }
      lastCandles = res.j;
      if (!chartSel.tf) chartSel.tf = res.j.tf;
      renderCandles();
    });
  }
  $("chartSymbol").addEventListener("change", function (ev) {
    chartSel.symbol = ev.target.value; saveChartSel(); $("chSym").textContent = chartSel.symbol;
    $("candles").innerHTML = '<p class="empty">読み込み中…</p>'; loadCandles().catch(function () { /* 次の更新で再取得 */ });
  });
  $("chartTfs").addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest("button[data-tf]") : null;
    if (!b) return;
    chartSel.tf = b.getAttribute("data-tf"); saveChartSel();
    var bs = document.querySelectorAll("#chartTfs button");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", bs[i] === b ? "true" : "false");
    $("candles").innerHTML = '<p class="empty">読み込み中…</p>'; loadCandles().catch(function () { /* 次の更新で再取得 */ });
  });

  // ───── STRATEGY × REGIME (小さなマス目のヒートマップ) と ALLOCATION ─────
  /** 期待 R → 色 (赤 〜 橙 〜 黄 〜 黄緑 〜 緑) */
  function rColor(r) {
    var stops = [[-1, [255, 93, 108]], [-0.4, [255, 159, 67]], [0, [245, 197, 66]], [0.4, [181, 224, 90]], [1, [61, 220, 151]]];
    var t = clamp((r || 0) / 0.5, -1, 1);
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i], k = (t - a[0]) / (b[0] - a[0]);
        return "rgb(" + [0, 1, 2].map(function (j) { return Math.round(a[1][j] + (b[1][j] - a[1][j]) * k); }).join(",") + ")";
      }
    }
    return "rgb(61,220,151)";
  }
  /** 腕 (戦略|レジーム|資産クラス) を 戦略 × レジーム に集計する */
  function armGrid() {
    var by = {}, sids = {};
    ((LE && LE.arms) || []).forEach(function (a) {
      var p = String(a.key).split("|"), sid = p[0], rg = p[1];
      sids[sid] = true;
      var o = (by[sid] = by[sid] || {}), c = (o[rg] = o[rg] || { n: 0, sumR: 0, wins: 0, k: 0, dis: 0, wsum: 0 });
      c.n += a.n; c.sumR += (a.meanR || 0) * a.n; c.wins += (a.winRate || 0) * a.n; c.k++; c.wsum += a.weight; if (a.disabled) c.dis++;
    });
    var rows = STRATS.slice();
    Object.keys(sids).sort().forEach(function (s) { if (rows.indexOf(s) < 0) rows.push(s); });
    return { by: by, rows: rows };
  }
  function renderHeat() {
    var g = armGrid(), arms = (LE && LE.arms) || [], maxN = 1;
    g.rows.forEach(function (sid) { REG.forEach(function (rg) { var c = g.by[sid] && g.by[sid][rg]; if (c) maxN = Math.max(maxN, c.n); }); });
    var stepN = Math.max(1, Math.ceil(maxN / 12));
    var h = "<span></span>" + REG.map(function (rg) { return '<span class="ch" title="' + esc(REG_J[rg]) + '">' + esc(REG_L[rg]) + "</span>"; }).join("");
    var best = null, total = 0, off = 0;
    g.rows.forEach(function (sid) {
      h += '<span class="rl" title="' + esc(sid) + '">' + esc(sid) + "</span>";
      REG.forEach(function (rg) {
        var c = g.by[sid] && g.by[sid][rg], fill = 0, col = "#111a2c", mr = 0, dis = false;
        if (c) {
          mr = c.n ? c.sumR / c.n : 0; fill = c.n ? clamp(Math.ceil(c.n / stepN), 1, 12) : 0; col = rColor(mr);
          dis = c.dis > 0 && c.dis === c.k; total += c.n; if (dis) off++;
          if (c.n >= 3 && (!best || mr > best.r)) best = { r: mr, sid: sid, rg: rg };
        }
        var sq = "";
        for (var i = 0; i < 12; i++) sq += i < fill ? '<i style="background:' + col + '"></i>' : "<i></i>";
        h += '<span class="cell' + (dis ? " off" : "") + '" title="' + esc(sid + " × " + REG_J[rg] + (c ? " / " + c.n + " 件 / 期待R " + num(mr, 3) + (dis ? " / 無効" : "") : " / 未取引")) + '">' + sq + "</span>";
      });
    });
    set("heat", h);
    set("heatSide", '<div class="hs"><div class="k">ARMS</div><div class="v">' + esc(arms.length) + '</div></div><div class="hs"><div class="k">TRADES</div><div class="v" style="color:' + C.c + '">' + esc(num(total, 0)) + "</div></div>" +
      '<div class="hs"><div class="k">BEST R</div><div class="v" style="color:' + C.g + '" title="' + esc(best ? best.sid + " × " + REG_J[best.rg] : "") + '">' + esc(best ? signed(best.r, 2) : "-") + "</div></div>" +
      '<div class="hs"><div class="k">OFF</div><div class="v" style="color:' + C.r + '">' + esc(off) + "</div></div>");
    set("heatSt", "● " + arms.length + " ARMS");
  }
  function renderAlloc() {
    var agg = {};
    ((LE && LE.arms) || []).forEach(function (a) {
      var sid = String(a.key).split("|")[0], o = (agg[sid] = agg[sid] || { n: 0, wn: 0, w: 0, k: 0, wins: 0 });
      o.n += a.n; o.wn += a.weight * a.n; o.w += a.weight; o.k++; o.wins += (a.winRate || 0) * a.n;
    });
    var on = enabledStrategies(), rows = Object.keys(agg).map(function (sid) {
      var o = agg[sid];
      return { sid: sid, w: o.n ? o.wn / o.n : o.w / o.k, n: o.n, wr: o.n ? o.wins / o.n : null };
    }).sort(function (a, b) { return b.w - a.w; });
    if (!rows.length) rows = (on.length ? on : STRATS).map(function (sid) { return { sid: sid, w: 1, n: 0, wr: null }; });
    var mx = Math.max(1.5, rows[0].w * 1.1);
    var h = rows.slice(0, 9).map(function (r, i) {
      var col = i === 0 && rows.length > 1 ? C.y : r.w >= 1 ? C.b : C.p;
      return '<div class="al"><div><div class="nm' + (i === 0 && rows.length > 1 ? " top" : "") + '" title="' + esc(r.sid) + '">' + esc(r.sid) + '</div><div class="sb">' + esc(r.n + " 件" + (r.wr != null ? " · 勝率 " + pct(r.wr, 0) : "") + (on.length && on.indexOf(r.sid) < 0 ? " · 計画外" : "")) + "</div></div>" +
        '<div class="bar2"><i style="width:' + (100 * clamp(r.w / mx, 0, 1)).toFixed(1) + "%;--bc:" + col + '"></i><span class="one" style="left:' + (100 / mx).toFixed(1) + '%"></span></div>' +
        '<div class="v">×' + esc(num(r.w, 2)) + "</div></div>";
    }).join("");
    set("alloc", h + (LE && LE.arms && LE.arms.length ? "" : '<p class="note">まだ腕の記録がありません (既定 ×1.00)</p>'));
    var avg = rows.reduce(function (a, r) { return a + r.w; }, 0) / rows.length;
    set("allocSt", "● AVG ×" + num(avg, 2));
    var total = STRATS.length;
    set("allocFoot", '<div style="display:flex;align-items:center;gap:10px"><b style="font-size:20px;color:' + C.y + '">' + esc(on.length) + "</b><span>" + esc("/ " + total + " 戦略が計画で有効 · 白線 = ×1.00") + '</span></div><div class="db glow"><i style="width:' + (100 * Math.min(1, on.length / total)).toFixed(1) + "%;--bc:" + C.y + '"></i></div>');
  }

  // ───── 指標のミニカード ─────
  function spark(vals, color) {
    var v = vals.filter(function (x) { return typeof x === "number" && isFinite(x); }), h = 30;
    if (v.length < 2) return '<svg class="spk" viewBox="0 0 100 ' + h + '" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="' + (h - 4) + '" y2="' + (h - 4) + '" stroke="' + color + '" stroke-opacity=".4" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/></svg>';
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    if (hi === lo) { hi += 1; lo -= 1; }
    var pts = v.map(function (y, i) { return (i * 100 / (v.length - 1)).toFixed(2) + "," + (3 + (1 - (y - lo) / (hi - lo)) * (h - 6)).toFixed(2); });
    return '<svg class="spk" viewBox="0 0 100 ' + h + '" preserveAspectRatio="none" aria-hidden="true"><path d="M0,' + h + " L" + pts.join(" L") + " L100," + h + ' Z" fill="' + color + '" fill-opacity=".16"/><polyline points="' + pts.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }
  function riskSeries() {
    var pts = [];
    EV.forEach(function (e) { if (e.kind === "plan" && typeof e.data.riskOn === "number") pts.push([e.ts, e.data.riskOn]); });
    if (S.brief) pts.push([S.brief.generatedAt, S.brief.riskOn]);
    pts.sort(function (a, b) { return a[0] - b[0]; });
    return pts.slice(-60).map(function (p) { return p[1]; });
  }
  function renderMini() {
    var s = S, e = s.equity, tr = tradesAsc(), st = tradeStats();
    var eq = s.equityHistory.map(function (p) { return p.equity; }).concat([e.current]);
    var cum = 0, pnlS = tr.length > 1 ? tr.map(function (x) { cum += acctPnl(x) || 0; return cum; }) : eq.map(function (v) { return v - e.initial; });
    var peak = -Infinity, ddS = eq.map(function (v) { peak = Math.max(peak, v); return peak > 0 ? -(peak - v) / peak : 0; });
    var w = 0, winS = tr.map(function (x, i) { if (x.netPnl > 0) w++; return w / (i + 1); });
    var fq = 0, feeRate = 1;
    tr.forEach(function (x) { fq += x.fees || 0; });
    if (fq > 0) feeRate = st.fees / fq;
    var fc = 0, feeS = tr.map(function (x) { fc += (x.fees || 0) * feeRate; return fc; });
    var diff = e.current - e.initial, r = s.risk, dd = r.peakEquity > 0 ? Math.max(0, (r.peakEquity - e.current) / r.peakEquity) : 0;
    var ro = s.brief ? s.brief.riskOn : null;
    var cards = [
      ["EQUITY · " + s.baseCurrency, big(e.current), C.y, spark(eq, C.y)],
      ["P&L · 損益", sbig(diff), diff >= 0 ? C.g : C.r, spark(pnlS, diff >= 0 ? C.g : C.r)],
      ["DRAWDOWN · DD", pct(dd), dd > 0 ? C.r : C.hi, spark(ddS, C.r)],
      ["WIN RATE · 勝率", st.winRate == null ? "-" : pct(st.winRate, 1), C.c, spark(winS, C.c)],
      ["FEES · 手数料合計", big(st.fees), C.p, spark(feeS, C.p)],
      ["RISK-ON · リスクオン", ro == null ? "-" : signed(ro, 2), ro == null ? C.hi : ro > 0.1 ? C.g : ro < -0.1 ? C.r : C.b, spark(riskSeries(), C.b)],
    ];
    set("mini", cards.map(function (c) {
      return '<div class="mc"><div class="k">' + esc(c[0]) + '</div><div class="v" style="color:' + c[2] + '">' + esc(c[1]) + "</div>" + c[3] + "</div>";
    }).join(""));
  }

  // ───── 粒子の雲 (点 = 集めた情報。中心付近に ENGINE。出来事で光る) ─────
  var CLOUD = (function () {
    var cv = $("cloud"), ctx = cv.getContext("2d");
    var W = 0, H = 0, cx = 0, cy = 0, R = 0, ex = 0, ey = 0;
    var running = false, raf = 0, tmr = 0, last = 0, rot = 0, acc = 0, nAmb = 0;
    var pts = [], links = [], spokes = [], flows = [], outs = [], marks = [], readers = [];
    var data = { count: 0, tone: null, items: [], strategies: [], key: "" };
    var eng = { pulse: 0, color: C.y, msg: "", msgColor: C.y, msgT: 0 };
    var COL = { bull: "#3ddc97", bear: "#ff5d6c", neu: "#c6d4f2", wait: "#46526b" };
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function capN() { return W && W < 600 ? 140 : 300; }
    function target() { return data.count > 0 ? Math.min(capN(), data.count) : 60; }
    function toneCol(s) { return typeof s !== "number" ? COL.neu : s > 0.15 ? COL.bull : s < -0.15 ? COL.bear : COL.neu; }
    function build() {
      var n = target(), ga = Math.PI * (3 - Math.sqrt(5));
      pts = [];
      for (var i = 0; i < n; i++) {
        var y = 1 - (i + 0.5) / n * 2, rr = Math.sqrt(1 - y * y), th = i * ga, k = 0.28 + 0.72 * Math.pow(Math.random(), 0.4);
        pts.push({ x: Math.cos(th) * rr * k, y: y * k, z: Math.sin(th) * rr * k, col: COL.neu, tone: "neu", item: -1, sx: 0, sy: 0, d: 0 });
      }
      links = [];
      for (var a = 0; a < n; a++) {
        var best = -1, bd = 1e9;
        for (var b = 0; b < n; b++) {
          if (a === b) continue;
          var dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y, dz = pts[a].z - pts[b].z, dd = dx * dx + dy * dy + dz * dz;
          if (dd < bd) { bd = dd; best = b; }
        }
        if (best >= 0) links.push([a, best]);
      }
      spokes = [];
      for (var s = 0; s < Math.min(16, n); s++) spokes.push((Math.random() * n) | 0);
      recolor();
      readers.forEach(function (r) { r.a = (Math.random() * n) | 0; r.b = (Math.random() * n) | 0; });
    }
    function recolor() {
      var n = pts.length, perm = [];
      for (var i = 0; i < n; i++) perm.push(i);
      for (var j = n - 1; j > 0; j--) { var k = (Math.random() * (j + 1)) | 0, t = perm[j]; perm[j] = perm[k]; perm[k] = t; }
      var tone = data.tone, tot = tone ? tone.bull + tone.bear + tone.neutral : 0;
      perm.forEach(function (pi, m) {
        var p = pts[pi];
        p.item = -1;
        if (!data.count) { p.col = COL.wait; p.tone = "neu"; return; }
        if (m < data.items.length) { p.item = m; p.col = toneCol(data.items[m].sentiment); }
        else if (tot) { var u = Math.random() * tot; p.col = u < tone.bull ? COL.bull : u < tone.bull + tone.bear ? COL.bear : COL.neu; }
        else p.col = COL.neu;
        p.tone = p.col === COL.bull ? "bull" : p.col === COL.bear ? "bear" : "neu";
      });
    }
    function bez(p, t) {
      var u = 1 - t;
      return [u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
        u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]];
    }
    function layout() {
      var r = cv.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return false;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var small = W < 600;
      cx = W * (small ? 0.5 : 0.47); cy = H * 0.5; R = Math.min(W * (small ? 0.4 : 0.36), H * (small ? 0.4 : 0.44));
      ex = cx + R * 0.26; ey = cy + R * 0.22;
      if (pts.length !== target()) build();
      flows = [];
      for (var i = 0; i < (small ? 4 : 8); i++) {
        var y0 = rnd(H * 0.08, H * 0.96), y3 = cy + rnd(-0.55, 0.55) * R;
        flows.push({ p: [[-10, y0], [cx - R * 1.7, y0 + rnd(-20, 20)], [cx - R * 1.5, y3], [cx - R * 0.8, y3]], t: [Math.random(), Math.random()], sp: rnd(0.07, 0.15) });
      }
      outs = [];
      for (var j = 0; j < (small ? 2 : 3); j++) {
        var ty = rnd(H * 0.12, H * 0.88);
        outs.push({ p: [[ex, ey], [ex + R * 0.9, ey + rnd(-50, 50)], [W - R * 0.5, ty], [W + 10, ty]], t: [Math.random()], sp: rnd(0.1, 0.2) });
      }
      return true;
    }
    function project() {
      var c = Math.cos(rot), s = Math.sin(rot), ct = Math.cos(0.36), st = Math.sin(0.36);
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], x1 = p.x * c + p.z * s, z1 = -p.x * s + p.z * c, y1 = p.y * ct - z1 * st, z2 = p.y * st + z1 * ct;
        var f = 2.25 / (2.9 - z2);
        p.sx = cx + x1 * R * f; p.sy = cy + y1 * R * f; p.d = (z2 + 1) / 2;
      }
    }
    function pick(tone) {
      if (!pts.length) return -1;
      var c = [];
      for (var i = 0; i < pts.length; i++) if (!tone || pts[i].tone === tone) c.push(i);
      if (!c.length) c = pts.map(function (_, i) { return i; });
      return c[(Math.random() * c.length) | 0];
    }
    function pickItem() {
      var c = [];
      for (var i = 0; i < pts.length; i++) if (pts[i].item >= 0) c.push(i);
      return c.length ? c[(Math.random() * c.length) | 0] : pick();
    }
    function setMsg(text, color) { eng.msg = text; eng.msgColor = color; eng.msgT = 6; }
    function mark(i, text, color, link, msg, msgColor) {
      if (i < 0) return;
      marks.push({ i: i, text: text, color: color, link: !!link, t: 0, life: link ? 5 : 3.4, msg: msg || "", msgColor: msgColor || color, fired: false });
      if (marks.length > 7) marks.shift();
    }
    var placed = [];
    function hits(x, y, w, h) {
      for (var i = 0; i < placed.length; i++) { var o = placed[i]; if (x < o[0] + o[2] + 2 && x + w + 2 > o[0] && y < o[1] + o[3] + 2 && y + h + 2 > o[1]) return true; }
      return false;
    }
    /** 枠付きのラベル。既に置いたラベルと重なるときは上下にずらし、置けなければ (must でない限り) 出さない */
    function tag(x, y, text, color, align, must) {
      if (!text) return;
      ctx.font = "600 10.5px " + FONT;
      var w = ctx.measureText(text).width + 12, h = 17;
      var bx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      bx = clamp(bx, 2, W - w - 2); var by0 = clamp(y, 2, H - h - 2), by = by0;
      for (var k = 1; k <= 4 && hits(bx, by, w, h); k++) by = clamp(by0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (h + 4), 2, H - h - 2);
      if (hits(bx, by, w, h) && !must) return;
      placed.push([bx, by, w, h]);
      ctx.fillStyle = "rgba(6,10,20,.88)"; ctx.fillRect(bx, by, w, h);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
      ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillText(text, bx + 6, by + h / 2 + 0.5);
    }
    function curve(x0, y0, x1, y1, bend, frac, color, width) {
      var mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, qx = mx - dy * bend, qy = my + dx * bend;
      var steps = 28, end = Math.max(1, Math.round(steps * frac));
      ctx.beginPath(); ctx.moveTo(x0, y0);
      var hx = x0, hy = y0;
      for (var i = 1; i <= end; i++) {
        var t = i / steps, u = 1 - t;
        hx = u * u * x0 + 2 * u * t * qx + t * t * x1; hy = u * u * y0 + 2 * u * t * qy + t * t * y1;
        ctx.lineTo(hx, hy);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
      return [hx, hy];
    }
    function update(dt) {
      if (!reduce) rot += dt * 0.07;
      eng.pulse = Math.max(0, eng.pulse - dt * 0.7);
      eng.msgT = Math.max(0, eng.msgT - dt);
      acc += dt;
      if (acc > (reduce ? 7 : 2.6) && pts.length && data.count) {
        acc = 0; nAmb++;
        var i = pickItem(), it = pts[i].item >= 0 ? data.items[pts[i].item] : null;
        mark(i, "READING · " + String(it ? it.source : "INTEL").toUpperCase().slice(0, 28), C.c, nAmb % 3 === 0, nAmb % 3 === 0 ? "◆ INTEL · " + String(it ? it.source : "").toUpperCase().slice(0, 20) : "", C.c);
        if (it) $("clNow").innerHTML = '<span class="src">' + esc(String(it.source).toUpperCase()) + "</span>" + esc(it.title);
      }
      for (var k = marks.length - 1; k >= 0; k--) {
        var m = marks[k];
        m.t += dt;
        if (m.link && !m.fired && m.t > 1.3) { m.fired = true; eng.pulse = 1; eng.color = m.msgColor; if (m.msg) setMsg(m.msg, m.msgColor); }
        if (m.t > m.life) marks.splice(k, 1);
      }
      readers.forEach(function (r) {
        r.t += dt / r.dur;
        if (r.t >= 1 && pts.length) { r.a = r.b; r.b = (Math.random() * pts.length) | 0; r.t = 0; r.dur = rnd(2.5, 4.5); }
      });
      flows.forEach(function (f) { for (var i = 0; i < f.t.length; i++) f.t[i] = (f.t[i] + dt * f.sp) % 1; });
      outs.forEach(function (f) { for (var i = 0; i < f.t.length; i++) f.t[i] = (f.t[i] + dt * f.sp) % 1; });
    }
    function draw(ts) {
      ctx.clearRect(0, 0, W, H);
      var bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.35);
      bg.addColorStop(0, "rgba(46,70,140,.20)"); bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      project();
      // 左の外から流れ込む曲線
      ctx.lineWidth = 1;
      flows.forEach(function (f) {
        ctx.strokeStyle = "rgba(130,160,220,.2)";
        ctx.beginPath(); ctx.moveTo(f.p[0][0], f.p[0][1]); ctx.bezierCurveTo(f.p[1][0], f.p[1][1], f.p[2][0], f.p[2][1], f.p[3][0], f.p[3][1]); ctx.stroke();
        if (!reduce) f.t.forEach(function (t) { var q = bez(f.p, t); ctx.fillStyle = "rgba(205,220,255," + (0.35 + 0.5 * Math.sin(t * Math.PI)) + ")"; ctx.fillRect(q[0] - 1, q[1] - 1, 2.2, 2.2); });
      });
      // 右 (SIGNAL STACK) へ伸びる線
      outs.forEach(function (f) {
        ctx.strokeStyle = "rgba(91,124,250,.32)";
        ctx.beginPath(); ctx.moveTo(f.p[0][0], f.p[0][1]); ctx.bezierCurveTo(f.p[1][0], f.p[1][1], f.p[2][0], f.p[2][1], f.p[3][0], f.p[3][1]); ctx.stroke();
        if (!reduce) f.t.forEach(function (t) { var q = bez(f.p, t); ctx.fillStyle = "rgba(140,170,255,.9)"; ctx.fillRect(q[0] - 1.2, q[1] - 1.2, 2.6, 2.6); });
      });
      ctx.globalCompositeOperation = "lighter";
      // 近い点どうしの細い線
      ctx.strokeStyle = "rgba(150,175,230,.09)"; ctx.beginPath();
      links.forEach(function (l) { var a = pts[l[0]], b = pts[l[1]]; ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); });
      ctx.stroke();
      // 中心へ向かう針
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        ctx.globalAlpha = 0.1 + 0.3 * p.d; ctx.strokeStyle = p.col;
        ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(cx + (p.sx - cx) * 0.66, cy + (p.sy - cy) * 0.66); ctx.stroke();
      }
      // 一部の点からエンジンへの光の線
      ctx.strokeStyle = C.y;
      spokes.forEach(function (si) { var p = pts[si]; if (!p) return; ctx.globalAlpha = 0.05 + 0.1 * p.d; ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(ex, ey); ctx.stroke(); });
      // 点
      for (var j = 0; j < pts.length; j++) {
        var q = pts[j], sz = 1.3 + 2.1 * q.d;
        ctx.globalAlpha = 0.3 + 0.7 * q.d; ctx.fillStyle = q.col;
        ctx.fillRect(q.sx - sz / 2, q.sy - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      // ハイライト (波紋・エンジンへの線)
      marks.forEach(function (m) {
        var p = pts[m.i]; if (!p) return;
        var fade = m.t < 0.3 ? m.t / 0.3 : m.t > m.life - 0.7 ? Math.max(0, (m.life - m.t) / 0.7) : 1;
        for (var k = 0; k < 2; k++) {
          var rr = reduce ? 0.4 : ((m.t * 0.8 + k * 0.5) % 1);
          ctx.globalAlpha = (1 - rr) * 0.8 * fade; ctx.strokeStyle = m.color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, 4 + rr * 24, 0, 7); ctx.stroke();
        }
        var gl = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, 10);
        gl.addColorStop(0, m.color); gl.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = fade; ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(p.sx, p.sy, 10, 0, 7); ctx.fill();
        if (m.link) {
          var fr = reduce ? 1 : Math.min(1, m.t / 1.3);
          ctx.globalAlpha = 0.25 * fade; curve(p.sx, p.sy, ex, ey, 0.25, fr, m.color, 4);
          ctx.globalAlpha = 0.95 * fade; var hd = curve(p.sx, p.sy, ex, ey, 0.25, fr, m.color, 1.4);
          if (fr < 1) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(hd[0], hd[1], 2.4, 0, 7); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
      });
      // ENGINE
      var pr = eng.pulse, br = reduce ? 0 : Math.sin(ts / 600), gr = 44 + pr * 20 + br * 3;
      var eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, gr);
      eg.addColorStop(0, "rgba(255,244,200,1)"); eg.addColorStop(0.12, "rgba(255,226,120,.95)"); eg.addColorStop(0.3, pr > 0.05 ? eng.color : "rgba(245,197,66,.55)"); eg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(ex, ey, gr, 0, 7); ctx.fill();
      ctx.strokeStyle = C.y; ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(ex, ey, 15, 0, 7); ctx.stroke();
      ctx.globalAlpha = 0.32; ctx.beginPath(); ctx.arc(ex, ey, 24, 0, 7); ctx.stroke();
      ctx.globalAlpha = 0.16; ctx.beginPath(); ctx.arc(ex, ey, 36, 0, 7); ctx.stroke();
      if (pr > 0) { ctx.globalAlpha = pr; ctx.strokeStyle = eng.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ex, ey, 15 + (1 - pr) * 50, 0, 7); ctx.stroke(); }
      ctx.globalAlpha = 1; ctx.fillStyle = "#fffbe8"; ctx.beginPath(); ctx.arc(ex, ey, 4.5, 0, 7); ctx.fill();
      // 戦略 (読み手) のマーカー
      readers.forEach(function (r) {
        var a = pts[r.a], b = pts[r.b]; if (!a || !b) return;
        var t = r.t < 0 ? 0 : r.t, k = t * t * (3 - 2 * t), x = a.sx + (b.sx - a.sx) * k, y = a.sy + (b.sy - a.sy) * k;
        r.x = x; r.y = y;
        ctx.strokeStyle = C.b; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
        ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.stroke();
        ctx.globalAlpha = 1; ctx.fillStyle = "#9db2ff"; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill();
      });
      ctx.globalCompositeOperation = "source-over";
      // ラベル (重要なものから置く: ENGINE → 判断 → 出来事 → 情報 → 戦略)
      placed = [];
      tag(ex - 26, ey - 32, data.strategies.length ? "ENGINE · " + data.strategies.length + " STRATEGIES" : "ENGINE", C.y, "right", true);
      if (eng.msgT > 0 && eng.msg) tag(ex, ey + 34, eng.msg, eng.msgColor, "center", true);
      if (!data.count) tag(cx, cy - 8, "WAITING FOR INTEL · 情報収集を待っています", C.mut, "center", true);
      [true, false].forEach(function (lk) {
        marks.forEach(function (m) {
          var p = pts[m.i]; if (!p || m.link !== lk || m.t > m.life - 0.3) return;
          tag(p.sx + 12, p.sy - 24, m.text, m.color);
        });
      });
      readers.forEach(function (r) { if (r.x != null) tag(r.x - 8, r.y + 14, r.label, C.b); });
    }
    function loop() { raf = requestAnimationFrame(frame); }
    function frame(ts) {
      raf = 0; tmr = 0;
      if (!running) return;
      if (!W && !layout()) { tmr = setTimeout(loop, 400); return; }
      var dt = last ? (ts - last) / 1000 : 0.016; last = ts;
      update(reduce ? Math.min(1.2, dt) : Math.min(0.1, dt));
      draw(ts);
      if (reduce) tmr = setTimeout(loop, 1000); else loop();
    }
    function kick() { if (running && reduce && tmr) { clearTimeout(tmr); tmr = 0; loop(); } }
    return {
      run: function (on) {
        if (on === running) return;
        running = on;
        if (on) { last = 0; if (!raf && !tmr) loop(); }
        else { if (raf) cancelAnimationFrame(raf); if (tmr) clearTimeout(tmr); raf = 0; tmr = 0; }
      },
      resize: function () { if (running) layout(); else W = 0; },
      setData: function (s) {
        var b = s.brief, items = (b && b.items) || [], count = b ? (b.itemCount != null ? b.itemCount : items.length) : 0;
        var tone = b && b.itemTone ? b.itemTone : null, strat = enabledStrategies();
        var key = count + "|" + (tone ? tone.bull + "/" + tone.bear + "/" + tone.neutral : "") + "|" + items.map(function (x) { return x.title; }).join("|");
        data.items = items; data.strategies = strat;
        if (key !== data.key) {
          var resize = Math.min(capN(), count || 60) !== Math.min(capN(), data.count || 60);
          data.count = count; data.tone = tone; data.key = key;
          if (W) { if (resize || pts.length !== target()) build(); else recolor(); }
        }
        var want = strat.slice(0, W && W < 600 ? 1 : 2);
        if (want.join() !== readers.map(function (r) { return r.id; }).join()) {
          readers = want.map(function (id) { return { id: id, label: String(id).toUpperCase() + " · READING", a: pick(), b: pick(), t: Math.random(), dur: rnd(2.5, 4.5) }; });
        }
        $("clCount").textContent = (count ? num(count, 0) : "0") + " ITEMS" + (count > target() ? " · 表示 " + target() + " 点" : "");
        set("mhCount", esc(num(count, 0)));
        set("mhSt", "● ENGINE READING · " + esc(strat.length) + " / " + esc(STRATS.length) + " STRATEGIES");
        if (!count) $("clNow").innerHTML = '<span class="src">WAITING</span>情報収集の結果を待っています';
        else if (!$("clNow").__set && items.length) { $("clNow").__set = 1; $("clNow").innerHTML = '<span class="src">' + esc(String(items[0].source).toUpperCase()) + "</span>" + esc(items[0].title); }
      },
      event: function (e) {
        var d = e.data || {}, sym = d.symbol ? String(d.symbol) : "";
        if (e.kind === "entry") {
          var up = d.direction !== "short";
          mark(pick(up ? "bull" : "bear"), "READING · " + sym, C.y, true, (up ? "▲ ENTRY " : "▼ ENTRY ") + sym, C.g);
        } else if (e.kind === "exit") {
          var win = typeof d.netPnl === "number" && d.netPnl > 0, col = win ? C.g : C.r;
          mark(pick(win ? "bull" : "bear"), "READING · " + sym, C.y, true, "■ EXIT " + sym + (typeof d.netPnl === "number" ? " " + signed(d.netPnl, 0) : ""), col);
        } else if (e.kind === "skip") {
          mark(pick(), "SCAN · NO EDGE", C.mut, true, "× NO TRADE", C.r);
        } else if (e.kind === "plan") {
          for (var i = 0; i < 5; i++) mark(pick(), i === 0 ? "INTEL · NEW PLAN" : "", C.c, i === 0, "◆ PLAN · RISK-ON " + signed(Number(d.riskOn) || 0, 2), C.c);
        } else if (e.kind === "risk" || e.kind === "order") {
          setMsg("! " + String(e.kind).toUpperCase() + (sym ? " · " + sym : ""), C.r); eng.pulse = 1; eng.color = C.r;
        } else if (e.kind === "learning") {
          setMsg("◇ LEARNING", C.p); eng.pulse = 1; eng.color = C.p;
        }
        kick();
      },
    };
  })();

  // ───── THIS RUN · STRATEGIES ─────
  function renderRun() {
    var bs = (TR ? TR.byStrategy : []).slice().sort(function (a, b) { return b.trades - a.trades; }), st = tradeStats();
    set("runSt", "● T + " + st.n + " TRADES");
    if (!bs.length) { set("run", '<p class="empty" style="padding:8px 10px">取引がたまると戦略ごとの成績を表示します</p>'); return; }
    var bestId = null, bestPnl = 0;
    bs.forEach(function (x) { if (x.netPnl > bestPnl) { bestPnl = x.netPnl; bestId = x.strategyId; } });
    var mx = bs[0].trades || 1;
    set("run", bs.slice(0, 5).map(function (x, i) {
      var best = x.strategyId === bestId, col = best ? C.y : i % 2 ? C.p : C.b;
      return '<div class="rr' + (best ? " best" : "") + '"><span class="tg2">' + esc(horizonOf(x.strategyId)) + "</span>" +
        '<div style="min-width:0"><div class="nm" title="' + esc(x.strategyId) + '">' + esc(x.strategyId) + '</div><div class="sb">' + esc(x.trades + " 件 · 勝率 " + pct(x.winRate, 0) + " · 勝ち " + x.wins + " / 負け " + x.losses) + "</div>" +
        '<div class="db' + (best ? " glow" : "") + '"><i style="width:' + (100 * x.trades / mx).toFixed(1) + "%;--bc:" + col + '"></i></div></div>' +
        '<div class="rv"><b>' + esc(signed(x.avgR, 2)) + 'R</b><span class="' + cls(x.netPnl) + '">' + esc(sbig(x.netPnl)) + "</span></div></div>";
    }).join(""));
  }

  // ───── SIGNAL STACK ─────
  function renderStack() {
    var s = S, bm = biasMap(), dirOf = {}, posPx = {}, h = "";
    if (s.plan) s.plan.symbols.forEach(function (x) { dirOf[x.symbol] = x.directionBias; });
    s.positions.forEach(function (p) { posPx[p.symbol] = p.lastPrice; });
    s.watched.forEach(function (w) {
      var x = bm[baseOf(w.symbol)], sv = x ? x.sentiment : null, t = sv == null ? null : toneOf(sv);
      var px = w.lastPrice != null ? w.lastPrice : posPx[w.symbol] != null ? posPx[w.symbol] : lastCandles && lastCandles.symbol === w.symbol && lastCandles.candles.length ? lastCandles.candles[lastCandles.candles.length - 1].close : null;
      var col = t && t[1] === "bull" ? C.g : t && t[1] === "bear" ? C.r : C.c, d = dirOf[w.symbol];
      h += '<div class="sc" style="--sc:' + col + '"><div class="sq"><span class="tg">WATCH</span><span class="q">' + esc(w.symbol + " · 計画 " + (d ? (d === "both" ? "両方" : DIR[d] || d) : "-") + " · " + String(w.assetClass).toUpperCase()) + "</span>" + (w.lastError ? '<span class="err" title="' + esc(w.lastError) + '">!</span>' : "") + "</div>" +
        '<div class="sv">' + esc(num(px)) + "</div>" +
        '<div class="sf">' + (t ? '<span class="' + t[1] + '">' + esc(t[0] + " " + signed(sv, 2)) + "</span>" + esc(" · 信頼度 " + num(x.confidence, 2) + (x.blackoutUntil ? " · " + time(x.blackoutUntil) + " まで停止" : "")) : "情報なし") + "</div></div>";
    });
    EV.filter(function (e) { return e.kind === "entry" || e.kind === "exit" || e.kind === "skip"; }).slice(0, 5).forEach(function (e) {
      var d = e.data || {};
      if (e.kind === "entry") {
        h += '<div class="sc" style="--sc:' + C.y + '"><div class="sq"><span class="tg">ENTRY</span><span class="q">' + esc(hms(e.ts) + " · " + (d.symbol || "") + " · " + (DIR[d.direction] || "") + " · " + (d.strategyId || "")) + "</span></div>" +
          '<div class="sv">' + esc((d.direction === "short" ? "▼ " : "▲ ") + "@" + num(d.price)) + '</div><div class="sf">' + esc("数量 " + num(d.qty) + " · エントリー") + "</div></div>";
      } else if (e.kind === "exit") {
        var p = typeof d.netPnl === "number" ? d.netPnl : null, col = p > 0 ? C.g : p < 0 ? C.r : C.mut;
        h += '<div class="sc" style="--sc:' + col + '"><div class="sq"><span class="tg">EXIT</span><span class="q">' + esc(hms(e.ts) + " · " + (d.symbol || "") + " · " + (EXIT[d.reason] || d.reason || "決済")) + "</span></div>" +
          '<div class="sv ' + cls(p) + '">' + esc(p == null ? "@" + num(d.exitPrice) : signed(p, 0)) + '</div><div class="sf">' + esc("@" + num(d.exitPrice) + (typeof d.rMultiple === "number" ? " · " + num(d.rMultiple, 2) + "R" : "") + (d.strategyId ? " · " + d.strategyId : "")) + "</div></div>";
      } else {
        h += '<div class="sc" style="--sc:' + C.r + '"><div class="sq"><span class="tg">SKIP</span><span class="q">' + esc(hms(e.ts) + " · 見送り") + '</span></div><div class="sv no">No trade.</div><div class="sf" title="' + esc(d.reason || "") + '">' + esc(d.reason || "-") + "</div></div>";
      }
    });
    set("stack", h || '<p class="empty">監視銘柄がありません</p>');
  }

  // ───── 下段: P&L・戦略別・リスク予算・コスト ─────
  function tapeSvg(trs) {
    if (!trs.length) return '<p class="empty">取引がたまると損益のテープを表示します</p>';
    var W = Math.max(260, Math.round($("tape").clientWidth || 420)), H = 94, L = 6, R = 6, mid = 40;
    var t0 = trs[0].exitTs, t1 = trs[trs.length - 1].exitTs;
    if (t1 === t0) { t0 -= 1; t1 += 1; }
    var mx = 0;
    trs.forEach(function (x) { mx = Math.max(mx, Math.abs(acctPnl(x) || 0)); });
    mx = mx || 1;
    var g = '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + mid + '" y2="' + mid + '" stroke="' + C.line2 + '" />', best = null, worst = null;
    trs.forEach(function (x) {
      var p = acctPnl(x) || 0, xx = L + (x.exitTs - t0) / (t1 - t0) * (W - L - R), k = Math.abs(p) / mx;
      var col = p > 0 ? C.g : p < 0 ? C.r : C.mut, y = mid - (p > 0 ? 1 : p < 0 ? -1 : 0) * (5 + 18 * k);
      g += '<line x1="' + xx.toFixed(1) + '" x2="' + xx.toFixed(1) + '" y1="' + mid + '" y2="' + y.toFixed(1) + '" stroke="' + col + '" stroke-opacity=".5" />' +
        '<circle cx="' + xx.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (2 + 3 * Math.sqrt(k)).toFixed(1) + '" fill="' + col + '" fill-opacity=".9" />';
      if (!best || p > best.p) best = { p: p, x: xx, y: y, s: x.symbol };
      if (!worst || p < worst.p) worst = { p: p, x: xx, y: y, s: x.symbol };
    });
    function lab(o, dy, col) {
      var anchor = o.x > W * 0.6 ? "end" : o.x < W * 0.25 ? "start" : "middle";
      return '<text x="' + o.x.toFixed(1) + '" y="' + (o.y + dy).toFixed(1) + '" text-anchor="' + anchor + '" font-size="10.5" fill="' + col + '">' + esc(signed(o.p, 0) + " " + o.s) + "</text>";
    }
    if (best && best.p > 0) g += lab(best, -9, C.y);
    if (worst && worst.p < 0) g += lab(worst, 14, C.r);
    g += '<text x="' + L + '" y="' + (H - 2) + '" font-size="10.5" fill="' + C.mut + '">' + esc(time(trs[0].exitTs)) + "</text>" +
      '<text x="' + (W - R) + '" y="' + (H - 2) + '" text-anchor="end" font-size="10.5" fill="' + C.mut + '">' + esc(time(trs[trs.length - 1].exitTs)) + "</text>";
    return '<svg viewBox="0 0 ' + W + " " + H + '" height="' + H + '" role="img" aria-label="直近のトレードの損益">' + g + "</svg>";
  }
  function renderPnl() {
    var s = S, e = s.equity, ccy = s.baseCurrency, st = tradeStats(), trs = tradesAsc();
    var diff = e.current - e.initial;
    var realized = e.realized != null ? e.realized : st.pnl;
    var unreal = e.unrealized != null ? e.unrealized : s.positions.reduce(function (a, p) { return a + (p.unrealizedPnlAccount != null ? p.unrealizedPnlAccount : p.unrealizedPnl); }, 0);
    function card(hl, k, badge, bcls, v, rows) {
      return '<div class="bc' + (hl ? " hl" : "") + '"><div class="k">' + k + '</div><span class="bd ' + bcls + '">' + esc(badge) + '</span><div class="v ' + cls(v) + '">' + esc(sbig(v)) + '</div><div class="kv2">' +
        rows.map(function (r) { return "<span>" + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b>"; }).join("") + "</div></div>";
    }
    set("pnlCards",
      card(true, "TOTAL 合計", (diff >= 0 ? "+" : "") + pct(e.initial ? diff / e.initial : 0), cls(diff), diff, [["初期", big(e.initial)], ["評価額", big(e.current)]]) +
      card(false, "REALIZED 実現", "勝ち " + st.wins + " / 負け " + st.losses, "", realized, [["件数", String(st.n)], ["手数料", big(st.fees)]]) +
      card(false, "UNREALIZED 含み", s.positions.length + " POS", s.positions.length ? "pos" : "", unreal, [["余力", big(e.available)], ["保有", s.positions.length + " / " + s.risk.limits.maxOpenPositions]]));
    $("tape").innerHTML = tapeSvg(trs);
    var mxp = null, mnp = null;
    trs.forEach(function (x) { var p = acctPnl(x); if (mxp == null || p > mxp) mxp = p; if (mnp == null || p < mnp) mnp = p; });
    set("tapeCap", trs.length ? esc("~ TRADE TAPE · 直近 " + trs.length + " 件 · 最大 " + signed(mxp, 0) + " / 最小 " + signed(mnp, 0) + " " + ccy) : "");
    set("pnlSt", "● " + esc(ccy) + " · " + (e.realized != null ? "PAPER" : "ACCOUNT"));
  }
  function renderNtr() {
    var bs = (TR ? TR.byStrategy : []).slice().sort(function (a, b) { return b.netPnl - a.netPnl; }), st = tradeStats();
    set("ntrT", "× " + esc(st.n) + " TRADES · BY STRATEGY");
    var h = '<div class="xtop"><div class="xbig"><small>×</small>' + esc(num(st.n, 0)) + '</div><div class="xs">TRADES IN VIEW · 直近の取引<br>勝ち <b>' + esc(st.wins) + "</b> / 負け <b>" + esc(st.losses) + '</b><br>損益 <b class="' + cls(st.pnl) + '">' + esc(signed(st.pnl, 0)) + "</b> " + esc(TR ? TR.baseCurrency : "") + "</div></div>";
    if (!bs.length) { set("ntr", h + '<p class="empty">まだ取引がありません</p>'); return; }
    var mx = 0;
    bs.forEach(function (x) { mx = Math.max(mx, Math.abs(x.netPnl)); });
    mx = mx || 1;
    h += bs.slice(0, 6).map(function (x, i) {
      var best = i === 0 && x.netPnl > 0;
      return '<div class="sr' + (best ? " best" : "") + '"><span class="nm" title="' + esc(x.strategyId) + '">' + esc(x.strategyId) + '</span><span class="pv">' + esc(sbig(x.netPnl)) + '</span><span class="bd' + (x.winRate >= 0.5 ? " g" : "") + '" title="勝率">' + esc(pct(x.winRate, 0)) + "</span>" +
        '<div class="hb"><i class="' + (x.netPnl < 0 ? "neg" : "") + '" style="width:' + (100 * Math.abs(x.netPnl) / mx).toFixed(1) + '%"></i></div></div>';
    }).join("");
    set("ntr", h);
  }
  function renderRiskBudget() {
    var s = S, e = s.equity, r = s.risk, lim = r.limits, ccy = s.baseCurrency;
    var dl = r.dayStartEquity > 0 ? Math.max(0, (r.dayStartEquity - e.current) / r.dayStartEquity) : 0;
    var left = Math.max(0, lim.maxDailyLoss - dl), dd = r.peakEquity > 0 ? Math.max(0, (r.peakEquity - e.current) / r.peakEquity) : 0;
    function row(lb, jp, val, col, frac, ycls) {
      return '<div class="rbr"><div class="top"><div class="lb' + (ycls ? " y" : "") + '">' + esc(lb) + "<span>" + esc(jp) + '</span></div><div class="rv2" style="color:' + col + '">' + esc(val) + "</div></div>" +
        '<div class="db' + (ycls ? " glow" : "") + '"><i style="width:' + (100 * clamp(frac, 0, 1)).toFixed(1) + "%;--bc:" + col + '"></i></div></div>';
    }
    var leftCol = left / (lim.maxDailyLoss || 1) < 0.34 ? C.r : left / (lim.maxDailyLoss || 1) < 0.67 ? C.o : C.g;
    set("rb",
      row("RISK / TRADE", "1 回のリスク · ≈ " + big(e.current * lim.riskPerTrade) + " " + ccy, pct(lim.riskPerTrade), C.y, lim.maxDailyLoss ? lim.riskPerTrade / lim.maxDailyLoss : 0, true) +
      row("AVAILABLE", "余力 (" + ccy + ")", big(e.available), C.c, e.current > 0 ? e.available / e.current : 0) +
      row("POSITIONS", "最大保有数 / 現在", s.positions.length + " / " + lim.maxOpenPositions, C.p, lim.maxOpenPositions ? s.positions.length / lim.maxOpenPositions : 0) +
      row("DAILY LOSS LEFT", "日次損失の上限 " + pct(lim.maxDailyLoss, 0) + " までの残り", pct(left), leftCol, lim.maxDailyLoss ? left / lim.maxDailyLoss : 0) +
      '<p class="note">' + esc("ドローダウン " + pct(dd) + " / 上限 " + pct(lim.maxDrawdown, 0) + (r.reason ? " · " + r.reason : "") + (s.pendingOrders && s.pendingOrders.length ? " · 保留中の注文 " + s.pendingOrders.length : "")) + "</p>");
    var rs = $("rbSt");
    if (r.killSwitch) { rs.textContent = "● KILL SWITCH"; rs.style.color = C.r; }
    else if (r.halted) { rs.textContent = "● HALTED"; rs.style.color = C.y; }
    else { rs.textContent = "● ACTIVE"; rs.style.color = C.g; }
  }
  function renderCost() {
    var st = tradeStats(), ccy = TR ? TR.baseCurrency : "", c = LE && LE.causes ? LE.causes.all || {} : {};
    var gross = st.pnl + st.fees, share = gross > 0 ? st.fees / gross : null;
    var rows = [
      ["FEES", "手数料合計 (" + ccy + ")", big(st.fees)],
      ["PER TRADE", "1 件あたり", st.n ? big(st.fees / st.n) : "-"],
      ["GROSS", "手数料前の損益", sbig(gross)],
      ["FEE DRAG", "手数料・スプレッド負け", (c.fee_drag || 0) + " 件"],
      ["SLIPPAGE", "約定ずれ", (c.slippage || 0) + " 件"],
    ];
    set("cost", '<table class="ct"><tbody>' + rows.map(function (r) { return "<tr><td>" + esc(r[0]) + "<span>" + esc(r[1]) + "</span></td><td>" + esc(r[2]) + "</td></tr>"; }).join("") + "</tbody></table>" +
      '<div class="bill"><div class="k">THE BILL · 手数料率</div><div class="v">' + esc(share == null ? "-" : pct(share, 1)) + '</div><div class="s">' + esc(share == null ? "粗利がまだありません" : "手数料前の利益のうち手数料") + "</div></div>");
    set("costSt", "● " + st.n + " TRADES");
  }

  // ───── ティッカー ─────
  function renderTicker() {
    var s = S, bm = biasMap(), st = tradeStats(), parts = [];
    s.watched.forEach(function (w) {
      var x = bm[baseOf(w.symbol)], sv = x ? x.sentiment : null, t = sv == null ? null : toneOf(sv);
      var px = w.lastPrice != null ? w.lastPrice : null;
      parts.push('<span class="tk-s">' + esc(w.symbol) + "</span> " + esc(num(px)) + (t ? ' <span style="color:' + (t[1] === "bull" ? C.g : t[1] === "bear" ? C.r : C.mut) + '">' + esc((sv >= 0 ? "▲ " : "▼ ") + t[0]) + "</span>" : ""));
    });
    if (s.brief) parts.push('<span class="tk-k">RISK-ON</span> <span style="color:' + (s.brief.riskOn >= 0 ? C.g : C.r) + '">' + esc(signed(s.brief.riskOn, 2)) + "</span>");
    parts.push('<span class="tk-k">EQUITY</span> <span style="color:' + C.y + '">' + esc(num(s.equity.current, 0) + " " + s.baseCurrency) + "</span>");
    var diff = s.equity.current - s.equity.initial;
    parts.push('<span class="tk-k">P&amp;L</span> <span class="' + cls(diff) + '">' + esc(signed(diff, 0)) + "</span>");
    parts.push('<span class="tk-k">WIN</span> ' + esc(st.winRate == null ? "-" : pct(st.winRate, 1)) + ' <span class="tk-k">TRADES</span> ' + esc(st.n));
    s.positions.forEach(function (p) {
      var u = p.unrealizedPnlAccount != null ? p.unrealizedPnlAccount : p.unrealizedPnl;
      parts.push('<span class="tk-k">POS</span> ' + esc(p.symbol + " " + (DIR[p.direction] || "")) + ' <span class="' + cls(u) + '">' + esc(signed(u, 0)) + "</span>");
    });
    if (s.brief && s.brief.events.length) { var ev = s.brief.events[0]; parts.push('<span class="tk-k">NEXT</span> ' + esc(time(ev.ts) + " " + (ev.currency ? ev.currency + " " : "") + ev.title)); }
    parts.push('<span class="tk-k">TICK</span> ' + esc(num(s.tickCount, 0)));
    loopText("tick", parts.join('<span class="sep">·</span>'), 0.3);
  }

  // ───── 他のタブ ─────
  function chart(points, ccy) {
    if (!points || points.length < 2) return '<p class="empty">データがたまるとグラフを表示します</p>';
    // 実際の表示幅で描く (文字が横に伸びないように)
    var W = Math.max(300, Math.round($("chart").clientWidth || 800)), H = 220, L = 70, R = 10, T = 10, B = 24;
    var xs = points.map(function (p) { return p.ts; }), ys = points.map(function (p) { return p.equity; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y1 === y0) { y1 += 1; y0 -= 1; }
    var pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    function X(t) { return L + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * (W - L - R); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
    var d = points.map(function (p, i) { return (i ? "L" : "M") + X(p.ts).toFixed(1) + " " + Y(p.equity).toFixed(1); }).join(" ");
    var area = d + " L" + X(x1).toFixed(1) + " " + (H - B) + " L" + X(x0).toFixed(1) + " " + (H - B) + " Z";
    var color = ys[ys.length - 1] >= ys[0] ? C.g : C.r;
    var grid = "";
    for (var k = 0; k <= 4; k++) {
      var v = y0 + (y1 - y0) * k / 4, y = Y(v).toFixed(1);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + C.line + '" />' +
        '<text x="' + (L - 6) + '" y="' + y + '" text-anchor="end" dominant-baseline="middle" font-size="11" fill="' + C.mut + '">' + esc(num(v, 0)) + "</text>";
    }
    return '<svg viewBox="0 0 ' + W + " " + H + '" height="220" role="img" aria-label="評価額の推移 (' + esc(ccy) + ')">' + grid +
      '<path d="' + area + '" fill="' + color + '" fill-opacity="0.12" />' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" />' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" fill="' + C.mut + '">' + esc(time(x0)) + "</text>" +
      '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end" font-size="11" fill="' + C.mut + '">' + esc(time(x1)) + "</text></svg>";
  }
  // -1 (弱気) 〜 +1 (強気) を中央から左右に伸びる棒で表す
  function dbar(x, wide) {
    var v = typeof x === "number" && isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    var w = Math.abs(v) * 50, color = v >= 0 ? C.g : C.r;
    var pos = v >= 0 ? "left:50%" : "left:" + (50 - w) + "%";
    return '<div class="dbar' + (wide ? " wide" : "") + '"><span style="' + pos + ";width:" + w + "%;background:" + color + '"></span></div>';
  }
  function tone(x, conf) {
    var t = toneOf(x);
    var weak = typeof conf === "number" && conf < 0.3 ? '<span class="muted"> (根拠薄)</span>' : "";
    return '<span class="tone ' + t[1] + '">' + t[0] + "</span>" + weak;
  }
  function renderSentiment(s) {
    var b = s.brief;
    if (!b) { set("sentiment", '<p class="empty">情報収集の結果がまだありません (起動後 1 回目の収集を待っています)</p>'); return; }
    var byAsset = biasMap(), dirOf = {};
    if (s.plan) s.plan.symbols.forEach(function (x) { dirOf[x.symbol] = x.directionBias; });
    var h = '<div class="kv" style="align-items:center"><span class="muted">市場全体</span><span>' + tone(b.riskOn) + " " + esc(signed(b.riskOn, 2)) + "</span></div>" +
      dbar(b.riskOn, true) + '<div class="scale"><span>リスクオフ (弱気)</span><span>中立</span><span>リスクオン (強気)</span></div>' +
      '<p class="note">' + esc(time(b.generatedAt)) + " 時点 / " + (b.stub ? "キーワード辞書で判定 (AI 未使用)" : "Claude で分析") + (b.itemCount != null ? " / 情報 " + esc(b.itemCount) + " 件" : "") + "</p>";
    var seen = {};
    var watchedRows = s.watched.map(function (w) {
      var a = baseOf(w.symbol), x = byAsset[a];
      seen[a] = true;
      var d = dirOf[w.symbol];
      return [esc(w.symbol), x ? tone(x.sentiment, x.confidence) : '<span class="muted">情報なし</span>', x ? dbar(x.sentiment) : "", x ? esc(signed(x.sentiment, 2)) : "-",
        x ? esc(num(x.confidence, 2)) : "-", x ? esc(num(x.eventRisk, 2)) + (x.blackoutUntil ? ' <span class="err">' + esc(time(x.blackoutUntil)) + " まで停止</span>" : "") : "-",
        esc(d ? (d === "both" ? "両方" : DIR[d] || d) : "-")];
    });
    h += "<h2>WATCHED · 監視銘柄</h2>" + table(["銘柄", "判定", "", "スコア", "信頼度", "イベント", "計画の方向"], watchedRows, [false, false, false, true, true, true, false]);
    var others = b.biases.filter(function (x) { return !seen[String(x.asset).toUpperCase()]; })
      .sort(function (p, q) { return Math.abs(q.sentiment) * q.confidence - Math.abs(p.sentiment) * p.confidence; }).slice(0, 15);
    h += "<h2>TRENDING · ニュースで話題の資産</h2>" + table(["資産", "判定", "", "スコア", "信頼度"], others.map(function (x) {
      return [esc(x.asset), tone(x.sentiment, x.confidence), dbar(x.sentiment), esc(signed(x.sentiment, 2)), esc(num(x.confidence, 2))];
    }), [false, false, false, true, true]);
    if (b.events.length) {
      h += "<h2>EVENTS · 重要イベント</h2>" + table(["日時", "通貨", "内容"], b.events.map(function (e) {
        return [esc(time(e.ts)), esc(e.currency || "-"), esc(e.title)];
      }));
    }
    if (b.items && b.items.length) {
      h += "<h2>HEADLINES · 直近の見出し</h2>" + table(["情報源", "判定", "見出し"], b.items.slice(0, 15).map(function (x) {
        return [esc(x.source), typeof x.sentiment === "number" ? tone(x.sentiment) : '<span class="muted">-</span>', esc(x.title)];
      }));
    }
    set("sentiment", '<div class="scroll">' + h + "</div>");
  }
  function renderOverview(s) {
    var ccy = s.baseCurrency, e = s.equity, diff = e.current - e.initial;
    set("equity", esc(num(e.current, 0)) + ' <span class="muted" style="font-size:14px">' + esc(ccy) + "</span>");
    set("equitySub", "初期 " + esc(num(e.initial, 0)) + ' / 損益 <span class="' + cls(diff) + '">' + esc(signed(diff, 0)) + " (" + esc(pct(e.initial ? diff / e.initial : 0)) + ")</span>" +
      (e.realized != null ? "<br>実現 " + esc(signed(e.realized, 0)) + " / 含み " + esc(signed(e.unrealized, 0)) + " / 余力 " + esc(num(e.available, 0)) : "") +
      (s.liveBlockedReason ? '<br><span class="err">' + esc(s.liveBlockedReason) + "</span>" : ""));
    var r = s.risk, dd = r.peakEquity > 0 ? (r.peakEquity - e.current) / r.peakEquity : 0;
    var dl = r.dayStartEquity > 0 ? (r.dayStartEquity - e.current) / r.dayStartEquity : 0;
    set("risk",
      "<span class=muted>状態</span><span>" + esc(r.reason || "通常") + "</span>" +
      "<span class=muted>ドローダウン</span><span>" + esc(pct(dd)) + " / 上限 " + esc(pct(r.limits.maxDrawdown, 0)) + "</span>" +
      "<span class=muted>日次損失</span><span>" + esc(pct(Math.max(0, dl))) + " / 上限 " + esc(pct(r.limits.maxDailyLoss, 0)) + "</span>" +
      "<span class=muted>1回のリスク</span><span>" + esc(pct(r.limits.riskPerTrade)) + "</span>" +
      "<span class=muted>最大保有数</span><span>" + esc(s.positions.length) + " / " + esc(r.limits.maxOpenPositions) + "</span>" +
      "<span class=muted>監視銘柄</span><span>" + s.watched.map(function (w) { return '<span class="chip">' + esc(w.symbol) + (w.lastError ? ' <span class="err">!</span>' : "") + "</span>"; }).join("") + "</span>");
    if (cur === "overview") set("chart", chart(s.equityHistory, ccy));
  }
  function renderPlan(s) {
    var p = s.plan, b = s.brief, h = "";
    if (b) h += "<p>" + esc(b.summary || "-") + '<br><span class="muted">リスクオン指数 ' + esc(num(b.riskOn, 2)) + " / " + esc(time(b.generatedAt)) + (b.stub ? " / AI 未使用" : "") + "</span></p>";
    if (p) {
      h += '<p class="note">' + esc(p.rationale) + "</p>";
      h += '<div class="scroll">' + table(["銘柄", "有効な戦略", "方向", "倍率"], p.symbols.map(function (x) {
        return [esc(x.symbol), x.enabledStrategies.length ? x.enabledStrategies.map(function (id) { return '<span class="chip">' + esc(id) + "</span>"; }).join("") : '<span class="muted">' + esc(x.notes || "停止") + "</span>",
          esc(x.directionBias === "both" ? "両方" : DIR[x.directionBias] || x.directionBias), esc(num(x.riskMultiplier, 2))];
      }), [false, false, false, true]) + "</div>";
      if (p.blackouts.length) h += '<p class="err">ブラックアウト: ' + p.blackouts.map(function (x) { return esc(x.reason + " (" + time(x.start) + "〜" + time(x.end) + ")"); }).join(", ") + "</p>";
    }
    set("plan", h || '<p class="empty">計画はまだありません</p>');
  }
  function renderPositions(s) {
    var ccy = s.baseCurrency;
    set("positions", table(["銘柄", "戦略", "方向", "数量", "建値", "現在値", "ストップ", "利確", "含み損益(" + ccy + ")", "建玉時刻"], s.positions.map(function (x) {
      var u = x.unrealizedPnlAccount != null ? x.unrealizedPnlAccount : x.unrealizedPnl;
      return [esc(x.symbol), esc(x.strategyId), esc(DIR[x.direction]), esc(num(x.qty)), esc(num(x.entryPrice)), esc(num(x.lastPrice)), esc(num(x.stop)),
        esc(x.takeProfit != null ? num(x.takeProfit) : "-"), '<span class="' + cls(u) + '">' + esc(signed(u, 0)) + "</span>", esc(time(x.entryTs))];
    }), [false, false, false, true, true, true, true, true, true, false]));
  }
  function renderTrades(t) {
    var ccy = t.baseCurrency;
    set("trades", table(["決済", "銘柄", "戦略", "方向", "理由", "損益(" + ccy + ")", "R", "要因"], t.trades.map(function (x) {
      var pnl = acctPnl(x);
      var causes = x.attribution ? x.attribution.causes.map(function (c) {
        return '<span class="chip ' + esc(x.attribution.outcome) + '" title="' + esc(c.evidence) + '">' + esc(c.label) + " " + esc(num(c.weight, 2)) + "</span>";
      }).join("") : '<span class="muted">未分析</span>';
      return [esc(time(x.exitTs)), esc(x.symbol) + (x.estimated ? ' <span class="muted" title="約定を確認できず推定した値を含む">(推定)</span>' : ""), esc(x.strategyId), esc(DIR[x.direction]), esc(EXIT[x.exitReason] || x.exitReason),
        '<span class="' + cls(pnl) + '">' + esc(signed(pnl, 0)) + "</span>", '<span class="' + cls(x.rMultiple) + '">' + esc(num(x.rMultiple, 2)) + "</span>", causes];
    }), [false, false, false, false, false, true, true, false]));
    set("byStrategy", table(["戦略", "取引", "勝率", "損益(" + ccy + ")", "平均R"], t.byStrategy.map(function (s) {
      return [esc(s.strategyId), esc(s.trades), esc(pct(s.winRate, 1)), '<span class="' + cls(s.netPnl) + '">' + esc(signed(s.netPnl, 0)) + "</span>", esc(num(s.avgR, 2))];
    }), [false, true, true, true, true]));
  }
  function renderLearning(l) {
    var c = l.causes, labels = l.causeLabels || {};
    var codes = Object.keys(c.all).sort(function (a, b) { return c.all[b] - c.all[a]; });
    var max = codes.length ? c.all[codes[0]] : 1;
    set("causes", c.trades ? '<p class="note">' + esc(c.trades) + " 件 (勝ち " + esc(c.outcomes.win) + " / 負け " + esc(c.outcomes.loss) + ")</p>" +
      table(["要因", "件数", ""], codes.map(function (k) {
        return [esc(labels[k] || k), esc(c.all[k]) + (c.loss[k] ? ' <span class="neg">(負け ' + esc(c.loss[k]) + ")</span>" : ""),
          '<div class="bar" style="width:' + Math.round(100 * c.all[k] / max) + '%"></div>'];
      }), [false, true, false]) : '<p class="empty">まだありません</p>');
    set("lessons", l.lessons.length ? '<ul class="plain">' + l.lessons.map(function (x) {
      return "<li>" + esc(x.text) + ' <span class="muted">[' + esc(x.scope) + " / " + (x.origin === "llm" ? "AI" : "ルール") + "]</span></li>";
    }).join("") + "</ul>" : '<p class="empty">まだありません</p>');
    set("adjustments", table(["日時", "戦略/資産", "パラメータ", "変更", "状態", "検証 (現行→候補)", "理由"], l.adjustments.slice().reverse().map(function (a) {
      return [esc(time(a.createdAt)), esc(a.strategyId + "/" + a.assetClass), esc(a.param), esc(a.from + " → " + a.to), esc(ADJ[a.status] || a.status),
        esc(a.validation ? num(a.validation.baselineScore, 2) + " → " + num(a.validation.candidateScore, 2) + " (" + a.validation.trades + "件)" : "-"), '<span class="muted">' + esc(a.reason) + "</span>"];
    })));
    var src = Object.keys(l.sources).map(function (k) { return l.sources[k]; }).sort(function (a, b) { return b.n - a.n; });
    set("sources", table(["情報源", "件数", "的中", "ニュース", "重み"], src.map(function (x) {
      return [esc(x.source), esc(x.n), esc(x.hits), esc((x.newsHits || 0) + "/" + (x.newsN || 0)), esc(num(x.weight, 2))];
    }), [false, true, true, true, true]) + '<p class="note">件数・的中はトレード由来。ニュースは値動きとの答え合わせ (的中/判定、重み 0.3)。</p>' + '<p class="note">情報の効き具合: ' + Object.keys(l.intelInfluence).map(function (k) { return esc(k + " " + num(l.intelInfluence[k], 2)); }).join(" / ") + "</p>");
    set("arms", table(["腕", "件数", "仮想", "勝率", "期待R", "仮想平均R", "配分倍率", "状態"], l.arms.slice().sort(function (a, b) { return b.n - a.n || (b.shadowN || 0) - (a.shadowN || 0); }).map(function (a) {
      var sn = a.shadowN || 0;
      return [esc(a.key), esc(a.n), esc(sn), esc(pct(a.winRate, 1)), '<span class="' + cls(a.meanR) + '">' + esc(num(a.meanR, 3)) + "</span>",
        sn ? '<span class="' + cls(a.shadowMeanR) + '">' + esc(num(a.shadowMeanR, 3)) + "</span>" : "-", esc(num(a.weight, 2)),
        a.disabled ? '<span class="neg">停止</span>' : "有効"];
    }), [false, true, true, true, true, true, true, false]));
    safe("shadow", function () { renderShadow(l.shadow); });
    safe("newsCheck", function () { renderNewsCheck(l.news); });
  }
  var SH_EXIT = { stop: "損切り", take_profit: "利確", time: "時間切れ", unwatched: "監視終了" };
  function shadowRows(rows) {
    return rows.slice(0, 20).map(function (g) {
      return [esc(g.key), esc(g.n), esc(pct(g.winRate, 1)), '<span class="' + cls(g.avgNetR) + '">' + esc(signed(g.avgNetR, 3)) + "</span>",
        '<span class="' + cls(g.sumNetR) + '">' + esc(signed(g.sumNetR, 2)) + "</span>"];
    });
  }
  function renderShadow(sh) {
    if (!sh) { set("shadow", '<p class="empty">まだありません</p>'); return; }
    var c = sh.counters || {};
    var ex = Object.keys(sh.exitReasons || {}).map(function (k) { return esc((SH_EXIT[k] || k) + " " + sh.exitReasons[k]); }).join(" / ");
    var h = '<p class="note">決済 ' + esc(sh.closed) + " 件 (勝率 " + esc(pct(sh.winRate, 1)) + ' / 平均純R <span class="' + cls(sh.avgNetR) + '">' + esc(signed(sh.avgNetR, 3)) + "</span>) / 未決済 " + esc(sh.open) + " 件" +
      (ex ? " / " + ex : "") + "</p>" +
      '<p class="note">作成 ' + esc(c.created || 0) + " / 重複 " + esc(c.duplicate || 0) + " / 上限で破棄 " + esc((c.droppedCap || 0) + (c.droppedRate || 0)) + " / 監視終了 " + esc(c.unwatched || 0) + "</p>";
    var heads = ["件数", "勝率", "平均純R", "純R合計"], numc = [false, true, true, true, true];
    h += "<h2>BY REASON · 見送り理由ごと</h2>" + '<div class="scroll">' + table(["見送り理由"].concat(heads), shadowRows(sh.byReason || []), numc) + "</div>";
    h += "<h2>BY STRATEGY · 戦略ごと</h2>" + '<div class="scroll">' + table(["戦略"].concat(heads), shadowRows(sh.byStrategy || []), numc) + "</div>";
    h += '<p class="note">純R = 往復手数料・スプレッド・約定ずれ (片道 2bps) を差し引いた R。平均純R が正の見送り理由はフィルターが厳しすぎる可能性があります (設定は自動では変えません)。</p>';
    set("shadow", h);
  }
  function renderNewsCheck(n) {
    if (!n) { set("newsCheck", '<p class="empty">まだありません</p>'); return; }
    var hz = n.horizons || [];
    var h = '<p class="note">記録 ' + esc(n.recorded) + " 件 / 判定待ち " + esc(n.pending) + " 件 / 上限で破棄 " + esc(n.droppedCap) + " / 監視終了 " + esc(n.droppedUnwatched) + "</p>";
    h += "<h2>BY SOURCE · 情報源ごと</h2>" + '<div class="scroll">' + table(["情報源", "判定", "的中", "的中率", "ノイズ"].concat(hz.map(function (x) { return x + " 的中/判定"; })), (n.sources || []).map(function (x) {
      return [esc(x.source), esc(x.n), esc(x.hits), esc(x.n ? pct(x.hitRate, 1) : "-"), esc(x.noise)].concat(hz.map(function (k) {
        var b = (x.byHorizon || {})[k]; return esc(b ? b.hits + "/" + b.n : "0/0");
      }));
    }), [false, true, true, true, true].concat(hz.map(function () { return true; }))) + "</div>";
    h += "<h2>BY HORIZON · 時間ごと</h2>" + '<div class="scroll">' + table(["時間", "判定", "的中", "的中率", "ノイズ", "期限切れ"], (n.byHorizon || []).map(function (x) {
      return [esc(x.horizon), esc(x.n), esc(x.hits), esc(x.n ? pct(x.hitRate, 1) : "-"), esc(x.noise), esc(x.expired)];
    }), [false, true, true, true, true, true]) + "</div>";
    h += '<p class="note">ノイズ = |変化率| が max(1 分足 ATR 比 × √分数 × 0.5, 往復コスト比) 未満の動き (判定せず数えません)。1 判定は重み 0.3 で情報源の信頼度に反映。</p>';
    set("newsCheck", h);
  }

  // ───── まとめて描画 (一部が失敗しても他は続ける) ─────
  function safe(name, f) {
    try { f(); } catch (e) {
      if (window.console && console.error) console.error("render " + name, e);
      $("error").textContent = "表示の一部に失敗: " + name;
    }
  }
  function renderBoardWide() {
    if (cur !== "board" || !S) return;
    safe("chart", renderCandles);
    safe("pnl", renderPnl);
  }
  function renderAll() {
    safe("header", renderHeader);
    safe("symbols", function () { syncSymbols(S); });
    safe("heat", renderHeat);
    safe("alloc", renderAlloc);
    safe("mini", renderMini);
    safe("cloud", function () { CLOUD.setData(S); });
    safe("run", renderRun);
    safe("stack", renderStack);
    safe("pnl", renderPnl);
    safe("ntr", renderNtr);
    safe("risk", renderRiskBudget);
    safe("cost", renderCost);
    safe("marquee", renderMarquee);
    safe("ticker", renderTicker);
    safe("overview", function () { renderOverview(S); });
    safe("market", function () { renderSentiment(S); renderPlan(S); });
    safe("positions", function () { renderPositions(S); });
    safe("trades", function () { renderTrades(TR); });
    safe("learning", function () { renderLearning(LE); });
  }

  // ───── 監査ログの取得 (差分) ─────
  function loadEvents() {
    return get("/api/events?limit=30" + (evSince ? "&since=" + evSince : "")).then(function (r) {
      var evs = r.events || [];
      if (!evs.length) { if (!evBooted) { evBooted = true; safe("log", renderLog); } return; }
      evSince = Math.max(evSince, evs[0].ts);
      EV = evs.concat(EV).slice(0, 80);
      safe("log", renderLog);
      safe("stack", renderStack);
      safe("marquee", renderMarquee);
      safe("mini", renderMini);
      // 初回は最新の数件だけ動かす (古い記録を一度に流さない)
      (evBooted ? evs : evs.slice(0, 3)).slice().reverse().forEach(function (e, i) { setTimeout(function () { CLOUD.event(e); }, 400 + i * 1500); });
      evBooted = true;
    });
  }

  // ───── タブの切り替え (選んだタブはこの端末に記憶する) ─────
  var TAB_KEY = "dashboard.tab", PANES = ["board", "overview", "market", "positions", "trades", "learning"];
  function syncAnim() {
    document.body.classList.toggle("anim-off", !animOK());
    CLOUD.run(animOK());
  }
  function showTab(name) {
    if (name === "live") name = "board"; // 旧「ライブ」タブ
    if (PANES.indexOf(name) < 0) name = "board";
    cur = name;
    var btns = document.querySelectorAll("nav#tabs button");
    for (var j = 0; j < btns.length; j++) btns[j].setAttribute("aria-selected", btns[j].getAttribute("data-tab") === name ? "true" : "false");
    $("board").hidden = name !== "board";
    $("panes").hidden = name === "board";
    var secs = document.querySelectorAll("#panes section[data-pane]");
    for (var k = 0; k < secs.length; k++) secs[k].hidden = secs[k].getAttribute("data-pane") !== name;
    document.body.classList.toggle("on-board", name === "board");
    CLOUD.resize();
    syncAnim();
    if (name === "board") { renderBoardWide(); loadCandles().catch(function () { /* 次の更新で再取得 */ }); }
    if (name === "overview" && S) set("chart", chart(S.equityHistory, S.baseCurrency));
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 保存できなくても表示は続ける */ }
  }
  $("tabs").addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest("button[data-tab]") : null;
    if (t) { showTab(t.getAttribute("data-tab")); window.scrollTo(0, 0); }
  });
  document.addEventListener("visibilitychange", function () { syncAnim(); if (!document.hidden) tickClock(); });
  var rsT = 0;
  window.addEventListener("resize", function () {
    clearTimeout(rsT);
    rsT = setTimeout(function () {
      CLOUD.resize(); renderBoardWide();
      if (cur === "overview" && S) set("chart", chart(S.equityHistory, S.baseCurrency));
    }, 150);
  });
  var saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch (e) { saved = null; }
  showTab(saved || "board");
  tickClock();
  setInterval(tickClock, 1000);

  function get(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }
  function refresh() {
    Promise.all([get("/api/status"), get("/api/trades?limit=100"), get("/api/learning")]).then(function (res) {
      S = res[0]; TR = res[1]; LE = res[2];
      $("error").textContent = "";
      renderAll();
      loadEvents().catch(function () { /* 記録だけ失敗しても他の表示は続ける */ });
      loadCandles().catch(function () { /* チャートだけ失敗しても他の表示は続ける */ });
      $("updated").textContent = new Date().toLocaleTimeString("ja-JP");
    }).catch(function (e) {
      $("error").textContent = "更新に失敗: " + e.message;
    });
  }
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
