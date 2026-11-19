/** ダッシュボードの単一 HTML (日本語・インライン CSS/JS・外部 CDN なし・5 秒ごとに自動更新) */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>自動売買ダッシュボード</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --fg: #1d2330; --muted: #667085; --line: #e4e7ec;
  --accent: #2563eb; --pos: #15803d; --neg: #b91c1c; --warn: #b45309; --chip: #eef2f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1218; --card: #171b23; --fg: #e6e9ef; --muted: #98a2b3; --line: #2a303b;
    --accent: #60a5fa; --pos: #4ade80; --neg: #f87171; --warn: #fbbf24; --chip: #222834;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; z-index: 1; }
header h1 { font-size: 16px; margin: 0; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--chip); }
.badge.paper { color: var(--accent); }
.badge.live { color: #fff; background: var(--neg); }
.badge.ok { color: var(--pos); }
.badge.ng { color: #fff; background: var(--neg); }
.badge.warn { color: var(--warn); }
.muted { color: var(--muted); }
main { padding: 16px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); max-width: 1400px; margin: 0 auto; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
section.wide { grid-column: 1 / -1; }
section h2 { font-size: 14px; margin: 0 0 8px; }
.big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.pos { color: var(--pos); } .neg { color: var(--neg); }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; }
.chip { display: inline-block; margin: 1px 2px; padding: 0 6px; border-radius: 6px; background: var(--chip); font-size: 12px; }
.chip.loss { color: var(--neg); } .chip.win { color: var(--pos); }
ul.plain { margin: 0; padding-left: 18px; }
ul.plain li { margin: 2px 0; }
svg { width: 100%; height: 220px; display: block; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
.bar { height: 8px; background: var(--accent); border-radius: 4px; }
.err { color: var(--neg); }
.dbar { position: relative; height: 10px; min-width: 120px; background: var(--chip); border-radius: 5px; }
.dbar::after { content: ""; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px; background: var(--muted); }
.dbar span { position: absolute; top: 0; bottom: 0; border-radius: 5px; }
.dbar.wide { height: 14px; }
.tone { display: inline-block; min-width: 64px; text-align: center; padding: 0 6px; border-radius: 6px; font-size: 12px; font-weight: 600; background: var(--chip); }
.tone.bull { color: var(--pos); } .tone.bear { color: var(--neg); }
.scale { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
nav#tabs { display: flex; gap: 4px; padding: 6px 8px; background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: var(--hdr, 49px); z-index: 1; overflow-x: auto; -webkit-overflow-scrolling: touch; }
nav#tabs button { flex: 1 0 auto; padding: 8px 12px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
nav#tabs button[aria-selected="true"] { background: var(--chip); color: var(--accent); }
section[hidden] { display: none; }
section.live { background: #05070d; border-color: #1b2233; color: #cfd8ea; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans JP", monospace; }
.lv-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 12px; margin-bottom: 6px; }
.lv-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; animation: lvBlink 1.2s infinite; align-self: center; }
.lv-tag { color: #22c55e; font-weight: 700; letter-spacing: .1em; }
.lv-k { color: #64748b; letter-spacing: .08em; }
.lv-v { color: #f8fafc; font-weight: 700; font-variant-numeric: tabular-nums; }
.lv-v.up { color: #4ade80; text-shadow: 0 0 8px rgba(74,222,128,.6); } .lv-v.down { color: #f87171; text-shadow: 0 0 8px rgba(248,113,113,.6); }
.lv-stage { position: relative; border: 1px solid #1b2233; border-radius: 8px; overflow: hidden; background: radial-gradient(ellipse at center, #0b1224 0%, #05070d 70%); }
#lvCanvas { display: block; width: 100%; height: 420px; }
.lv-toast { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); font-size: 12px; padding: 3px 10px; border-radius: 6px; background: rgba(15,23,42,.85); border: 1px solid #334155; color: #e2e8f0; opacity: 0; transition: opacity .3s; pointer-events: none; white-space: nowrap; }
.lv-toast.on { opacity: 1; }
.lv-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; margin: 6px 0 2px; }
.lv-h { color: #64748b; letter-spacing: .1em; font-size: 12px !important; margin-top: 10px !important; }
.lv-trace { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; font-size: 12px; }
.lv-trace li { display: grid; grid-template-columns: 44px 64px 1fr; gap: 6px; padding: 4px 2px; border-bottom: 1px dashed #1b2233; animation: lvIn .5s ease-out; }
.lv-trace .t { color: #64748b; } .lv-trace .k { font-weight: 700; } .lv-trace .d { color: #cbd5e1; overflow-wrap: anywhere; }
@keyframes lvBlink { 50% { opacity: .25; } }
@keyframes lvIn { from { opacity: 0; transform: translateX(-12px); background: rgba(56,189,248,.18); } to { opacity: 1; transform: none; background: transparent; } }
@media (max-width: 600px) { #lvCanvas { height: 360px; } }
@media (prefers-reduced-motion: reduce) { .lv-dot, .lv-trace li { animation: none; } }
.ctl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
.ctl select { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
.seg { display: inline-flex; flex-wrap: wrap; gap: 2px; background: var(--chip); border-radius: 8px; padding: 2px; }
.seg button { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px; font-weight: 600; padding: 5px 10px; border-radius: 6px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--card); color: var(--accent); }
#candles svg { height: 300px; }
@media (max-width: 600px) { .dbar { min-width: 56px; } .tone { min-width: 0; } main { padding: 8px; gap: 8px; } .big { font-size: 22px; } th, td { padding: 4px; } }
</style>
</head>
<body>
<header>
  <h1>自動売買ダッシュボード</h1>
  <span id="mode" class="badge">-</span>
  <span id="riskBadge" class="badge">-</span>
  <span class="muted">更新: <span id="updated">-</span></span>
  <span id="error" class="err"></span>
</header>
<nav id="tabs" role="tablist">
  <button type="button" data-tab="live">ライブ</button>
  <button type="button" data-tab="overview">概要</button>
  <button type="button" data-tab="market">強気・弱気</button>
  <button type="button" data-tab="positions">ポジション</button>
  <button type="button" data-tab="trades">取引</button>
  <button type="button" data-tab="learning">学習</button>
</nav>
<main>
  <section class="wide live" data-tab="live">
    <div class="lv-top">
      <span class="lv-dot"></span><span class="lv-tag">LIVE</span>
      <span class="lv-k">評価額</span><span id="lvEquity" class="lv-v">-</span>
      <span class="lv-k">損益</span><span id="lvPnl" class="lv-v">-</span>
      <span class="lv-k">市場</span><span id="lvRisk" class="lv-v">-</span>
      <span class="lv-k">TICK</span><span id="lvTick" class="lv-v">-</span>
    </div>
    <div class="lv-stage"><canvas id="lvCanvas" aria-label="判断の流れのアニメーション"></canvas><div id="lvToast" class="lv-toast"></div></div>
    <div class="lv-legend"><span style="color:#38bdf8">● 情報源</span><span style="color:#f59e0b">● 銘柄</span><span style="color:#a78bfa">● 戦略</span><span style="color:#f472b6">● リスク管理</span><span style="color:#34d399">● 取引所</span></div>
    <h2 class="lv-h">TRACE ― 判断の記録</h2>
    <ul id="lvTrace" class="lv-trace"></ul>
  </section>
  <section data-tab="overview">
    <h2>評価額</h2>
    <div id="equity" class="big">-</div>
    <div id="equitySub" class="muted"></div>
  </section>
  <section data-tab="overview">
    <h2>リスク状態</h2>
    <div id="risk" class="kv"></div>
  </section>
  <section class="wide" data-tab="market">
    <h2>相場の強気・弱気</h2>
    <div id="sentiment"></div>
  </section>
  <section data-tab="market">
    <h2>計画・情報</h2>
    <div id="plan"></div>
  </section>
  <section class="wide" data-tab="overview">
    <h2>チャート</h2>
    <div class="ctl">
      <select id="chartSymbol" aria-label="銘柄"></select>
      <div id="chartTfs" class="seg" role="group" aria-label="時間足"></div>
    </div>
    <div id="candles"></div>
    <div id="candleInfo" class="muted"></div>
  </section>
  <section class="wide" data-tab="overview">
    <h2>評価額の推移</h2>
    <div id="chart"></div>
  </section>
  <section class="wide" data-tab="positions">
    <h2>保有ポジション</h2>
    <div id="positions" class="scroll"></div>
  </section>
  <section class="wide" data-tab="trades">
    <h2>直近のトレードと損益要因</h2>
    <div id="trades" class="scroll"></div>
  </section>
  <section data-tab="trades">
    <h2>戦略別の成績</h2>
    <div id="byStrategy" class="scroll"></div>
  </section>
  <section data-tab="learning">
    <h2>損益要因の集計</h2>
    <div id="causes"></div>
  </section>
  <section data-tab="learning">
    <h2>教訓</h2>
    <div id="lessons"></div>
  </section>
  <section class="wide" data-tab="learning">
    <h2>パラメータ調整</h2>
    <div id="adjustments" class="scroll"></div>
  </section>
  <section data-tab="learning">
    <h2>情報源の信頼度</h2>
    <div id="sources" class="scroll"></div>
  </section>
  <section class="wide" data-tab="learning">
    <h2>腕の成績 (戦略×レジーム×資産クラス)</h2>
    <div id="arms" class="scroll"></div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var EXIT = { stop: "損切り", take_profit: "利確", trailing: "トレーリング", signal: "シグナル", time: "時間切れ", kill_switch: "キルスイッチ", manual: "手動" };
  var ADJ = { proposed: "提案のみ", applied: "適用", rejected: "却下", reverted: "差し戻し" };
  var DIR = { long: "買い", short: "売り" };
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
  function table(headers, rows, numeric) {
    if (!rows.length) return '<p class="muted">まだありません</p>';
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
  function set(id, html) { document.getElementById(id).innerHTML = html; }

  function chart(points, ccy) {
    if (!points || points.length < 2) return '<p class="muted">データがたまるとグラフを表示します</p>';
    var W = 800, H = 220, L = 70, R = 10, T = 10, B = 24;
    var xs = points.map(function (p) { return p.ts; }), ys = points.map(function (p) { return p.equity; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y1 === y0) { y1 += 1; y0 -= 1; }
    var pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    function X(t) { return L + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * (W - L - R); }
    function Y(v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); }
    var d = points.map(function (p, i) { return (i ? "L" : "M") + X(p.ts).toFixed(1) + " " + Y(p.equity).toFixed(1); }).join(" ");
    var area = d + " L" + X(x1).toFixed(1) + " " + (H - B) + " L" + X(x0).toFixed(1) + " " + (H - B) + " Z";
    var up = ys[ys.length - 1] >= ys[0];
    var color = up ? "var(--pos)" : "var(--neg)";
    var grid = "";
    for (var k = 0; k <= 4; k++) {
      var v = y0 + (y1 - y0) * k / 4, y = Y(v).toFixed(1);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)" />' +
        '<text x="' + (L - 6) + '" y="' + y + '" text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--muted)">' + esc(num(v, 0)) + "</text>";
    }
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="評価額の推移 (' + esc(ccy) + ')">' + grid +
      '<path d="' + area + '" fill="' + color + '" fill-opacity="0.12" />' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" />' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" fill="var(--muted)">' + esc(time(x0)) + "</text>" +
      '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + esc(time(x1)) + "</text></svg>";
  }

  // -1 (弱気) 〜 +1 (強気) を中央から左右に伸びる棒で表す
  function dbar(x, wide) {
    var v = typeof x === "number" && isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    var w = Math.abs(v) * 50, color = v >= 0 ? "var(--pos)" : "var(--neg)";
    var pos = v >= 0 ? "left:50%" : "left:" + (50 - w) + "%";
    return '<div class="dbar' + (wide ? " wide" : "") + '"><span style="' + pos + ";width:" + w + "%;background:" + color + '"></span></div>';
  }
  function tone(x, conf) {
    var t = x >= 0.3 ? ["強気", "bull"] : x >= 0.1 ? ["やや強気", "bull"] : x <= -0.3 ? ["弱気", "bear"] : x <= -0.1 ? ["やや弱気", "bear"] : ["中立", ""];
    var weak = typeof conf === "number" && conf < 0.3 ? '<span class="muted"> (根拠薄)</span>' : "";
    return '<span class="tone ' + t[1] + '">' + t[0] + "</span>" + weak;
  }
  function baseOf(sym) { return String(sym).split(/[\/:|-]/)[0].toUpperCase(); }
  function renderSentiment(s) {
    var b = s.brief;
    if (!b) { set("sentiment", '<p class="muted">情報収集の結果がまだありません (起動後 1 回目の収集を待っています)</p>'); return; }
    var byAsset = {};
    b.biases.forEach(function (x) { byAsset[String(x.asset).toUpperCase()] = x; });
    var dirOf = {};
    if (s.plan) s.plan.symbols.forEach(function (x) { dirOf[x.symbol] = x.directionBias; });
    var h = '<div class="kv" style="align-items:center"><span class="muted">市場全体</span><span>' + tone(b.riskOn) + " " + esc(signed(b.riskOn, 2)) + "</span></div>" +
      dbar(b.riskOn, true) + '<div class="scale"><span>リスクオフ (弱気)</span><span>中立</span><span>リスクオン (強気)</span></div>' +
      '<p class="muted">' + esc(time(b.generatedAt)) + " 時点 / " + (b.stub ? "キーワード辞書で判定 (AI 未使用)" : "Claude で分析") + "</p>";
    var seen = {};
    var watchedRows = s.watched.map(function (w) {
      var a = baseOf(w.symbol), x = byAsset[a];
      seen[a] = true;
      var d = dirOf[w.symbol];
      return [esc(w.symbol), x ? tone(x.sentiment, x.confidence) : '<span class="muted">情報なし</span>', x ? dbar(x.sentiment) : "", x ? esc(signed(x.sentiment, 2)) : "-",
        x ? esc(num(x.confidence, 2)) : "-", x ? esc(num(x.eventRisk, 2)) + (x.blackoutUntil ? ' <span class="err">' + esc(time(x.blackoutUntil)) + " まで停止</span>" : "") : "-",
        esc(d ? (d === "both" ? "両方" : DIR[d] || d) : "-")];
    });
    h += '<h2 style="margin-top:12px">監視銘柄</h2>' + table(["銘柄", "判定", "", "スコア", "信頼度", "イベント", "計画の方向"], watchedRows, [false, false, false, true, true, true, false]);
    var others = b.biases.filter(function (x) { return !seen[String(x.asset).toUpperCase()]; })
      .sort(function (p, q) { return Math.abs(q.sentiment) * q.confidence - Math.abs(p.sentiment) * p.confidence; }).slice(0, 15);
    h += '<h2 style="margin-top:12px">ニュースで話題の資産</h2>' + table(["資産", "判定", "", "スコア", "信頼度"], others.map(function (x) {
      return [esc(x.asset), tone(x.sentiment, x.confidence), dbar(x.sentiment), esc(signed(x.sentiment, 2)), esc(num(x.confidence, 2))];
    }), [false, false, false, true, true]);
    if (b.events.length) {
      h += '<h2 style="margin-top:12px">重要イベント</h2>' + table(["日時", "通貨", "内容"], b.events.map(function (e) {
        return [esc(time(e.ts)), esc(e.currency || "-"), esc(e.title)];
      }));
    }
    set("sentiment", '<div class="scroll">' + h + "</div>");
  }

  // ───── 監視銘柄のチャート (銘柄と時間足はこの端末に記憶する) ─────
  var CHART_KEY = "dashboard.chart";
  var chartSel = { symbol: null, tf: null };
  try { var cs = JSON.parse(localStorage.getItem(CHART_KEY) || "null"); if (cs) chartSel = cs; } catch (e) { /* 既定に戻す */ }
  var lastStatus = null, lastCandles = null;
  function saveChartSel() { try { localStorage.setItem(CHART_KEY, JSON.stringify(chartSel)); } catch (e) { /* 無視 */ } }
  var TF_LABEL = { "1m": "1分", "5m": "5分", "15m": "15分", "1h": "1時間", "4h": "4時間", "1d": "日足" };
  function syncSymbols(s) {
    var sel = document.getElementById("chartSymbol");
    var syms = s.watched.map(function (w) { return w.symbol; });
    if (sel.options.length !== syms.length || syms.some(function (x, i) { return sel.options[i].value !== x; })) {
      sel.innerHTML = syms.map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + "</option>"; }).join("");
    }
    if (!chartSel.symbol || syms.indexOf(chartSel.symbol) < 0) chartSel.symbol = syms[0] || null;
    sel.value = chartSel.symbol || "";
  }
  function syncTfs(tfs) {
    if (!chartSel.tf || tfs.indexOf(chartSel.tf) < 0) chartSel.tf = tfs[0] || null;
    set("chartTfs", tfs.map(function (tf) {
      return '<button type="button" data-tf="' + esc(tf) + '" aria-pressed="' + (tf === chartSel.tf ? "true" : "false") + '">' + esc(TF_LABEL[tf] || tf) + "</button>";
    }).join(""));
  }
  function candleChart(cs, lines) {
    if (!cs || cs.length < 2) return '<p class="muted">足がたまるとチャートを表示します</p>';
    // 実際の表示幅で描く (縦横比を崩さず、スマホでも文字がつぶれないように)
    var W = Math.max(300, Math.round(document.getElementById("candles").clientWidth || 800)), H = 300, L = 4, R = 96, T = 8, VOL = 46, B = 22;
    var ph = H - T - B - VOL - 6;
    var lo = Infinity, hi = -Infinity, vmax = 0;
    cs.forEach(function (c) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); vmax = Math.max(vmax, c.volume || 0); });
    lines.forEach(function (l) { if (l.v > lo - (hi - lo) && l.v < hi + (hi - lo)) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); } });
    if (hi === lo) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    var n = cs.length, step = (W - L - R) / n, bw = Math.max(1, step * 0.7);
    function X(i) { return L + step * i + step / 2; }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * ph; }
    var g = "";
    for (var k = 0; k <= 4; k++) {
      var v = lo + (hi - lo) * k / 4, y = Y(v).toFixed(1);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)" />' +
        '<text x="' + (W - R + 4) + '" y="' + y + '" dominant-baseline="middle" font-size="11" fill="var(--muted)">' + esc(num(v)) + "</text>";
    }
    var vy0 = H - B, body = "";
    cs.forEach(function (c, i) {
      var up = c.close >= c.open, col = up ? "var(--pos)" : "var(--neg)", x = X(i);
      var y1 = Y(Math.max(c.open, c.close)), y2 = Y(Math.min(c.open, c.close));
      body += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + Y(c.high).toFixed(1) + '" y2="' + Y(c.low).toFixed(1) + '" stroke="' + col + '" />' +
        '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, y2 - y1).toFixed(1) + '" fill="' + col + '" />';
      if (vmax > 0 && c.volume > 0) {
        var vh = (c.volume / vmax) * VOL;
        body += '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + (vy0 - vh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + vh.toFixed(1) + '" fill="' + col + '" fill-opacity="0.35" />';
      }
    });
    var ov = "";
    lines.forEach(function (l) {
      if (l.v < lo || l.v > hi) return;
      var y = Y(l.v).toFixed(1);
      ov += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + l.color + '" stroke-dasharray="' + (l.dash || "4 3") + '" />' +
        '<rect x="' + (W - R + 1) + '" y="' + (Number(y) - 8) + '" width="' + (R - 2) + '" height="16" rx="3" fill="' + l.color + '" />' +
        '<text x="' + (W - R + 4) + '" y="' + y + '" dominant-baseline="middle" font-size="10" fill="#fff">' + esc(l.label + " " + num(l.v)) + "</text>";
    });
    var t0 = time(cs[0].ts), t1 = time(cs[n - 1].ts);
    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="ローソク足チャート">' + g + body + ov +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" fill="var(--muted)">' + esc(t0) + "</text>" +
      '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + esc(t1) + "</text></svg>";
  }
  function renderCandles() {
    var data = lastCandles;
    if (!data || data.symbol !== chartSel.symbol || data.tf !== chartSel.tf) return;
    var cs = data.candles, lines = [];
    var last = cs.length ? cs[cs.length - 1] : null;
    if (last) lines.push({ v: last.close, label: "現在", color: "var(--accent)", dash: "2 2" });
    (lastStatus ? lastStatus.positions : []).forEach(function (p) {
      if (p.symbol !== data.symbol) return;
      lines.push({ v: p.entryPrice, label: "建値", color: "#6b7280" });
      lines.push({ v: p.stop, label: "損切", color: "var(--neg)" });
      if (p.takeProfit != null) lines.push({ v: p.takeProfit, label: "利確", color: "var(--pos)" });
    });
    set("candles", candleChart(cs, lines));
    var chg = cs.length > 1 ? (last.close - cs[0].open) / cs[0].open : null;
    set("candleInfo", last ? esc(data.symbol) + " " + esc(TF_LABEL[data.tf] || data.tf) + " / 現在 " + esc(num(last.close)) +
      (chg != null ? ' / 表示期間 <span class="' + cls(chg) + '">' + esc((chg > 0 ? "+" : "") + pct(chg)) + "</span>" : "") +
      " / " + esc(cs.length) + " 本" + (cs.every(function (c) { return !c.volume; }) ? " (出来高なし)" : "") : "");
  }
  function loadCandles() {
    if (!chartSel.symbol) return Promise.resolve();
    var q = "/api/candles?limit=120&symbol=" + encodeURIComponent(chartSel.symbol) + (chartSel.tf ? "&tf=" + encodeURIComponent(chartSel.tf) : "");
    return fetch(q, { cache: "no-store" }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (res) {
      if (res.j && res.j.timeframes) syncTfs(res.j.timeframes);
      if (!res.ok) { set("candles", '<p class="muted">' + esc(res.j && res.j.error || "チャートを取得できません") + "</p>"); set("candleInfo", ""); return; }
      lastCandles = res.j;
      if (!chartSel.tf) chartSel.tf = res.j.tf;
      renderCandles();
    });
  }
  document.getElementById("chartSymbol").addEventListener("change", function (ev) {
    chartSel.symbol = ev.target.value; saveChartSel(); set("candles", '<p class="muted">読み込み中…</p>'); loadCandles();
  });
  document.getElementById("chartTfs").addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest("button[data-tf]") : null;
    if (!b) return;
    chartSel.tf = b.getAttribute("data-tf"); saveChartSel();
    var bs = document.querySelectorAll("#chartTfs button");
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute("aria-pressed", bs[i] === b ? "true" : "false");
    set("candles", '<p class="muted">読み込み中…</p>'); loadCandles();
  });

  // ───── ライブ: 判断の流れをネットワークのアニメーションで表示する ─────
  var LV = (function () {
    var STRATS = ["scalp_obi", "scalp_vwap_revert", "scalp_momentum_burst", "short_ema_trend", "short_rsi_revert", "short_breakout", "mid_trend_follow", "long_momentum", "meme_momentum"];
    var SLABEL = { scalp_obi: "板の偏り", scalp_vwap_revert: "VWAP逆張り", scalp_momentum_burst: "急騰ブレイク", short_ema_trend: "EMAトレンド", short_rsi_revert: "RSI逆張り", short_breakout: "ブレイクアウト", mid_trend_follow: "中期トレンド", long_momentum: "長期モメンタム", meme_momentum: "ミーム" };
    var SOURCES = ["ニュース", "Fear&Greed", "CoinGecko", "DexScreener", "経済指標"];
    var C = { src: "#38bdf8", sym: "#f59e0b", strat: "#a78bfa", risk: "#f472b6", ex: "#34d399", core: "#e2e8f0", up: "#4ade80", down: "#f87171" };
    var cv = document.getElementById("lvCanvas"), ctx = cv.getContext("2d");
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var W = 0, H = 0, dpr = 1, nodes = {}, edges = [], dendrites = [], dust = [], particles = [], visible = true, raf = 0, last = 0;
    var state = { symbols: [], sentiment: {}, enabled: {}, weights: {}, venue: "取引所", riskOn: 0 };
    function rand(a, b) { return a + Math.random() * (b - a); }
    function node(id, label, kind, x, y, r, color) {
      var n = nodes[id] || { pulse: 0, flash: null };
      n.id = id; n.label = label; n.kind = kind; n.x = x; n.y = y; n.r = r; n.color = color;
      nodes[id] = n; return n;
    }
    function edge(a, b, color) { edges.push({ a: a, b: b, color: color, bend: rand(-0.25, 0.25) }); }
    function layout() {
      var rect = cv.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(280, rect.width); H = Math.max(260, rect.height);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cx = W / 2, cy = H * 0.5, R = Math.min(W, H) * 0.42, small = W < 500;
      var keep = {}; edges = [];
      function arc(list, a0, a1, rr, f, sx) {
        list.forEach(function (it, i) {
          var t = list.length === 1 ? 0.5 : i / (list.length - 1), a = a0 + (a1 - a0) * t;
          f(it, cx + Math.cos(a) * rr * (sx != null ? sx : small ? 1.05 : 1.25), cy + Math.sin(a) * rr);
        });
      }
      var core = node("core", "AI エンジン", "core", cx, cy, small ? 22 : 28, C.core); keep.core = 1;
      arc(SOURCES, Math.PI * 0.76, Math.PI * 1.24, R, function (n, x, y) { node("src:" + n, n, "src", x, y, 7, C.src); keep["src:" + n] = 1; edge("src:" + n, "core", C.src); });
      var syms = state.symbols.length ? state.symbols : ["-"];
      var spread = Math.min(0.12, 0.04 * syms.length);
      arc(syms, Math.PI * (1.5 - spread), Math.PI * (1.5 + spread), R * 0.92, function (n, x, y) {
        var sv = state.sentiment[n], col = sv == null ? C.sym : sv > 0.1 ? C.up : sv < -0.1 ? C.down : C.sym;
        node("sym:" + n, n, "sym", x, y, 9, col); keep["sym:" + n] = 1; edge("sym:" + n, "core", C.sym);
      }, small ? 1.3 : 1.6);
      arc(STRATS, -Math.PI * 0.2, Math.PI * 0.22, R, function (n, x, y) {
        var w = state.weights[n] != null ? state.weights[n] : 1;
        node("st:" + n, SLABEL[n] || n, "strat", x, y, 4 + 4 * Math.min(1.5, w), C.strat); keep["st:" + n] = 1;
        edge("core", "st:" + n, C.strat); edge("st:" + n, "risk", C.strat);
      });
      node("risk", "リスク管理", "risk", cx + R * 0.22, cy + R * 0.86, 12, C.risk); keep.risk = 1;
      node("ex", state.venue, "ex", cx - R * 0.32, cy + R * 0.86, 13, C.ex); keep.ex = 1;
      edge("risk", "ex", C.risk); edge("ex", "core", C.ex);
      Object.keys(nodes).forEach(function (k) { if (!keep[k]) delete nodes[k]; });
      // 中心から伸びる樹状の光 (飾り)
      dendrites = [];
      function grow(x, y, a, len, depth, col) {
        if (depth <= 0 || len < 4) return;
        var x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
        dendrites.push([x, y, x2, y2, col, depth]);
        grow(x2, y2, a + rand(-0.6, 0.1), len * rand(0.62, 0.8), depth - 1, col);
        if (Math.random() < 0.7) grow(x2, y2, a + rand(0.1, 0.7), len * rand(0.5, 0.72), depth - 1, col);
      }
      var cols = [C.src, C.sym, C.strat, C.risk, C.ex];
      for (var i = 0; i < (small ? 10 : 16); i++) grow(cx, cy, (i / (small ? 10 : 16)) * Math.PI * 2 + rand(-0.2, 0.2), R * rand(0.18, 0.3), 5, cols[i % cols.length]);
      dust = [];
      for (var j = 0; j < (small ? 70 : 140); j++) dust.push({ x: rand(0, W), y: rand(0, H), r: rand(0.3, 1.3), v: rand(0.02, 0.12), p: rand(0, 6) });
      void core;
    }
    function ctrl(e) {
      var a = nodes[e.a], b = nodes[e.b];
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
      return { a: a, b: b, cx: mx - dy * e.bend, cy: my + dx * e.bend };
    }
    function qp(c, t) {
      var u = 1 - t;
      return { x: u * u * c.a.x + 2 * u * t * c.cx + t * t * c.b.x, y: u * u * c.a.y + 2 * u * t * c.cy + t * t * c.b.y };
    }
    function findEdge(a, b) { for (var i = 0; i < edges.length; i++) if (edges[i].a === a && edges[i].b === b) return edges[i]; return null; }
    function shoot(a, b, color, size, delay, then) {
      var e = findEdge(a, b); if (!e || !nodes[a] || !nodes[b]) return;
      particles.push({ e: e, t: -(delay || 0), sp: rand(0.5, 0.8), color: color || e.color, size: size || 2.2, then: then, trail: [] });
    }
    function pulse(id, color) { var n = nodes[id]; if (n) { n.pulse = 1; n.flash = color || null; } }
    function toast(text, color) {
      var el = document.getElementById("lvToast");
      el.textContent = text; el.style.color = color || "#e2e8f0"; el.className = "lv-toast on";
      clearTimeout(toast._t); toast._t = setTimeout(function () { el.className = "lv-toast"; }, 3500);
    }
    function ambient(dt) {
      if (reduce) return;
      var rate = 2.2 * dt;
      while (Math.random() < rate) {
        rate -= 1;
        var e = edges[(Math.random() * edges.length) | 0];
        if (e) particles.push({ e: e, t: 0, sp: rand(0.25, 0.45), color: e.color, size: rand(0.8, 1.5), trail: [] });
      }
    }
    function draw(ts) {
      raf = 0;
      if (!visible) return;
      var dt = last ? Math.min(0.1, (ts - last) / 1000) : 0.016; last = ts;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      dust.forEach(function (d) {
        d.y -= d.v; d.p += dt * 2; if (d.y < 0) { d.y = H; d.x = rand(0, W); }
        ctx.fillStyle = "rgba(148,163,184," + (0.15 + 0.15 * Math.sin(d.p)) + ")";
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
      });
      var breathe = 0.55 + 0.25 * Math.sin(ts / 900);
      dendrites.forEach(function (l) {
        ctx.strokeStyle = l[4]; ctx.globalAlpha = 0.08 + 0.05 * l[5] * breathe; ctx.lineWidth = 0.4 + l[5] * 0.25;
        ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(l[2], l[3]); ctx.stroke();
      });
      edges.forEach(function (e) {
        var c = ctrl(e);
        ctx.strokeStyle = e.color; ctx.globalAlpha = 0.16; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(c.a.x, c.a.y); ctx.quadraticCurveTo(c.cx, c.cy, c.b.x, c.b.y); ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ambient(dt);
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i]; p.t += dt * p.sp;
        if (p.t < 0) continue;
        var c = ctrl(p.e), pt = qp(c, Math.min(1, p.t));
        p.trail.push(pt); if (p.trail.length > 10) p.trail.shift();
        for (var k = 0; k < p.trail.length; k++) {
          var q = p.trail[k], f = (k + 1) / p.trail.length;
          ctx.globalAlpha = 0.5 * f; ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(q.x, q.y, p.size * f, 0, 7); ctx.fill();
        }
        ctx.globalAlpha = 1; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, p.size, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        if (p.t >= 1) { particles.splice(i, 1); if (p.then) p.then(); else if (p.size > 1.8) pulse(p.e.b); }
      }
      Object.keys(nodes).forEach(function (id) {
        var n = nodes[id], col = n.flash || n.color, r = n.r * (n.kind === "core" ? 1 + 0.06 * Math.sin(ts / 500) : 1);
        var g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2);
        g.addColorStop(0, col); g.addColorStop(0.35, col + "55"); g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = 0.9; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r * 3.2, 0, 7); ctx.fill();
        ctx.globalAlpha = n.kind === "strat" && state.enabled[n.id.slice(3)] === false ? 0.35 : 1;
        ctx.fillStyle = n.kind === "core" ? "#f8fafc" : col; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill();
        if (n.pulse > 0) {
          ctx.globalAlpha = n.pulse; ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + (1 - n.pulse) * 26, 0, 7); ctx.stroke();
          n.pulse = Math.max(0, n.pulse - dt * 1.2); if (n.pulse === 0) n.flash = null;
        }
        ctx.globalAlpha = 1;
      });
      ctx.globalCompositeOperation = "source-over";
      ctx.font = (W < 500 ? 9 : 11) + "px ui-monospace, Menlo, monospace"; ctx.textAlign = "center";
      Object.keys(nodes).forEach(function (id) {
        var n = nodes[id];
        if (n.kind === "core") {
          ctx.fillStyle = "#0b1224"; ctx.font = "bold " + (W < 500 ? 11 : 13) + "px ui-monospace, Menlo, monospace"; ctx.fillText("AI", n.x, n.y + 4);
          ctx.font = (W < 500 ? 9 : 11) + "px ui-monospace, Menlo, monospace"; ctx.fillStyle = "#cbd5e1"; ctx.fillText(n.label, n.x, n.y + n.r + 14);
          return;
        }
        ctx.fillStyle = n.kind === "strat" && state.enabled[n.id.slice(3)] === false ? "#64748b" : "#e2e8f0";
        var lx = n.x, ly = n.y + n.r + 12;
        if (n.kind === "strat") { ctx.textAlign = "right"; lx = n.x - n.r - 5; ly = n.y + 3; }
        if (n.kind === "src") { ctx.textAlign = "left"; lx = n.x + n.r + 5; ly = n.y + 3; }
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.strokeText(n.label, lx, ly);
        ctx.fillText(n.label, lx, ly); ctx.textAlign = "center";
      });
      if (!reduce || particles.length) raf = requestAnimationFrame(draw);
    }
    function start() { if (!raf && visible) { last = 0; raf = requestAnimationFrame(draw); } }
    var api = {
      setVisible: function (v) { visible = v; if (v) { layout(); start(); } },
      update: function (s, learn) {
        var syms = s.watched.map(function (w) { return w.symbol; });
        var sent = {};
        if (s.brief) s.brief.biases.forEach(function (b) { sent[String(b.asset).toUpperCase()] = b.sentiment; });
        var symSent = {}; syms.forEach(function (x) { var v = sent[baseOf(x)]; if (v != null) symSent[x] = v; });
        var enabled = {};
        if (s.plan) { STRATS.forEach(function (id) { enabled[id] = false; }); s.plan.symbols.forEach(function (x) { x.enabledStrategies.forEach(function (id) { enabled[id] = true; }); }); }
        var weights = {};
        if (learn && learn.arms) learn.arms.forEach(function (a) { var id = String(a.key).split("|")[0]; weights[id] = Math.max(weights[id] || 0, a.weight); });
        var venue = s.watched.length ? String(s.watched[0].venue).replace(/^ccxt:/, "") : "取引所";
        var changed = syms.join() !== state.symbols.join() || venue !== state.venue || JSON.stringify(symSent) !== JSON.stringify(state.sentiment) || JSON.stringify(enabled) !== JSON.stringify(state.enabled);
        state.symbols = syms; state.sentiment = symSent; state.enabled = enabled; state.weights = weights; state.venue = venue; state.riskOn = s.brief ? s.brief.riskOn : 0;
        if (changed || !W) layout();
        // 市場データの取り込み (毎回)
        syms.forEach(function (x, i) { shoot("sym:" + x, "core", C.sym, 2, i * 0.15); });
        start();
      },
      event: function (e) {
        var d = e.data || {}, st = d.strategyId ? "st:" + d.strategyId : null;
        if (e.kind === "entry") {
          toast("▲ エントリー " + (d.symbol || "") + " " + (SLABEL[d.strategyId] || d.strategyId || ""), C.up);
          if (d.symbol) shoot("sym:" + d.symbol, "core", C.up, 3);
          shoot("core", st || "st:scalp_obi", C.up, 3, 0.3, function () { shoot(st || "st:scalp_obi", "risk", C.up, 3, 0, function () { pulse("risk", C.up); shoot("risk", "ex", C.up, 3.5, 0, function () { pulse("ex", C.up); }); }); });
        } else if (e.kind === "exit") {
          var win = typeof d.netPnl === "number" && d.netPnl > 0, col = win ? C.up : C.down;
          toast("■ 決済 " + (d.symbol || "") + " " + (typeof d.netPnl === "number" ? (d.netPnl > 0 ? "+" : "") + num(d.netPnl, 0) : ""), col);
          pulse("ex", col); shoot("ex", "core", col, 3.5, 0, function () { pulse("core", col); });
        } else if (e.kind === "skip") {
          shoot("core", "st:scalp_obi", "#94a3b8", 1.8, 0, function () { shoot("st:scalp_obi", "risk", "#94a3b8", 1.8, 0, function () { pulse("risk", C.down); }); });
        } else if (e.kind === "plan") {
          toast("◆ 計画を更新 (リスクオン " + signed(Number(d.riskOn) || 0, 2) + ")", C.src);
          SOURCES.forEach(function (n, i) { shoot("src:" + n, "core", C.src, 2.6, i * 0.12); });
          STRATS.forEach(function (n, i) { shoot("core", "st:" + n, C.strat, 2, 0.8 + i * 0.06); });
        } else if (e.kind === "risk" || e.kind === "order") {
          toast("! " + label(e), C.risk); pulse("risk", C.risk);
        } else if (e.kind === "learning") {
          pulse("core", C.strat);
        }
        start();
      },
    };
    window.addEventListener("resize", function () { if (visible) { layout(); start(); } });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && visible) start(); });
    return api;
  })();
  window.__lv = LV;

  var EVT = { entry: ["ENTRY", "#4ade80"], exit: ["EXIT", "#fbbf24"], skip: ["SKIP", "#94a3b8"], plan: ["PLAN", "#38bdf8"], order: ["ORDER", "#f472b6"], risk: ["RISK", "#f87171"], learning: ["LEARN", "#a78bfa"], system: ["SYS", "#64748b"], intel: ["INTEL", "#38bdf8"] };
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
  var lvSince = 0, lvBooted = false, lvEquity = null;
  function countTo(el, to, fmt) {
    var from = el.__v != null ? el.__v : to, t0 = performance.now();
    el.__v = to;
    function step(now) {
      var k = Math.min(1, (now - t0) / 700), v = from + (to - from) * (1 - Math.pow(1 - k, 3));
      el.textContent = fmt(v); if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function renderLiveTop(s) {
    var e = s.equity, ccy = s.baseCurrency, el = document.getElementById("lvEquity");
    countTo(el, e.current, function (v) { return num(v, 0) + " " + ccy; });
    el.className = "lv-v" + (lvEquity != null && e.current !== lvEquity ? (e.current > lvEquity ? " up" : " down") : "");
    lvEquity = e.current;
    var diff = e.current - e.initial, pe = document.getElementById("lvPnl");
    countTo(pe, diff, function (v) { return signed(v, 0); });
    pe.className = "lv-v " + (diff > 0 ? "up" : diff < 0 ? "down" : "");
    var r = s.brief ? s.brief.riskOn : null, re = document.getElementById("lvRisk");
    re.textContent = r == null ? "-" : (r >= 0.1 ? "強気 " : r <= -0.1 ? "弱気 " : "中立 ") + signed(r, 2);
    re.className = "lv-v " + (r > 0.1 ? "up" : r < -0.1 ? "down" : "");
    document.getElementById("lvTick").textContent = String(s.tickCount);
  }
  function loadEvents() {
    return get("/api/events?limit=30" + (lvSince ? "&since=" + lvSince : "")).then(function (r) {
      var evs = r.events || [];
      if (!evs.length) return;
      lvSince = Math.max(lvSince, evs[0].ts);
      var ul = document.getElementById("lvTrace"), html = "";
      evs.forEach(function (e) {
        var k = EVT[e.kind] || [e.kind, "#94a3b8"], d = new Date(e.ts);
        html += '<li><span class="t">' + esc(("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2)) + '</span><span class="k" style="color:' + k[1] + '">' + esc(k[0]) + '</span><span class="d">' + esc(label(e)) + "</span></li>";
      });
      ul.insertAdjacentHTML("afterbegin", html);
      while (ul.children.length > 60) ul.removeChild(ul.lastChild);
      // 初回は最新の数件だけ動かす (古い記録を一度に流さない)
      (lvBooted ? evs : evs.slice(0, 2)).slice().reverse().forEach(function (e, i) { setTimeout(function () { LV.event(e); }, i * 900); });
      lvBooted = true;
    });
  }

  function renderStatus(s) {
    lastStatus = s;
    renderLiveTop(s);
    syncSymbols(s);
    renderSentiment(s);
    var ccy = s.baseCurrency;
    var m = document.getElementById("mode");
    m.textContent = s.mode === "live" ? "実弾 (LIVE)" : "ペーパー";
    m.className = "badge " + (s.mode === "live" ? "live" : "paper");
    var rb = document.getElementById("riskBadge");
    if (s.risk.killSwitch) { rb.textContent = "キルスイッチ作動中"; rb.className = "badge ng"; }
    else if (s.risk.halted) { rb.textContent = "新規停止中"; rb.className = "badge warn"; }
    else { rb.textContent = "稼働中"; rb.className = "badge ok"; }
    var e = s.equity, diff = e.current - e.initial;
    set("equity", esc(num(e.current, 0)) + ' <span class="muted" style="font-size:14px">' + esc(ccy) + "</span>");
    set("equitySub", '初期 ' + esc(num(e.initial, 0)) + ' / 損益 <span class="' + cls(diff) + '">' + esc(signed(diff, 0)) + " (" + esc(pct(e.initial ? diff / e.initial : 0)) + ")</span>" +
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
    var p = s.plan, b = s.brief, h = "";
    if (b) h += "<p>" + esc(b.summary || "-") + '<br><span class="muted">リスクオン指数 ' + esc(num(b.riskOn, 2)) + " / " + esc(time(b.generatedAt)) + (b.stub ? " / AI 未使用" : "") + "</span></p>";
    if (p) {
      h += '<p class="muted">' + esc(p.rationale) + "</p>";
      h += table(["銘柄", "有効な戦略", "方向", "倍率"], p.symbols.map(function (x) {
        return [esc(x.symbol), x.enabledStrategies.length ? x.enabledStrategies.map(function (id) { return '<span class="chip">' + esc(id) + "</span>"; }).join("") : '<span class="muted">' + esc(x.notes || "停止") + "</span>",
          esc(x.directionBias === "both" ? "両方" : DIR[x.directionBias] || x.directionBias), esc(num(x.riskMultiplier, 2))];
      }), [false, false, false, true]);
      if (p.blackouts.length) h += '<p class="err">ブラックアウト: ' + p.blackouts.map(function (x) { return esc(x.reason + " (" + time(x.start) + "〜" + time(x.end) + ")"); }).join(", ") + "</p>";
    }
    set("plan", h || '<p class="muted">計画はまだありません</p>');
    set("chart", chart(s.equityHistory, ccy));
    set("positions", table(["銘柄", "戦略", "方向", "数量", "建値", "現在値", "ストップ", "利確", "含み損益(" + ccy + ")", "建玉時刻"], s.positions.map(function (x) {
      var u = x.unrealizedPnlAccount != null ? x.unrealizedPnlAccount : x.unrealizedPnl;
      return [esc(x.symbol), esc(x.strategyId), esc(DIR[x.direction]), esc(num(x.qty)), esc(num(x.entryPrice)), esc(num(x.lastPrice)), esc(num(x.stop)),
        esc(x.takeProfit != null ? num(x.takeProfit) : "-"), '<span class="' + cls(u) + '">' + esc(signed(u, 0)) + "</span>", esc(time(x.entryTs))];
    }), [false, false, false, true, true, true, true, true, true, false]));
  }

  function renderTrades(t) {
    var ccy = t.baseCurrency;
    set("trades", table(["決済", "銘柄", "戦略", "方向", "理由", "損益(" + ccy + ")", "R", "要因"], t.trades.map(function (x) {
      var pnl = x.netPnlAccount != null ? x.netPnlAccount : x.netPnl;
      var causes = x.attribution ? x.attribution.causes.map(function (c) {
        return '<span class="chip ' + esc(x.attribution.outcome) + '" title="' + esc(c.evidence) + '">' + esc(c.label) + " " + esc(num(c.weight, 2)) + "</span>";
      }).join("") : '<span class="muted">未分析</span>';
      return [esc(time(x.exitTs)), esc(x.symbol), esc(x.strategyId), esc(DIR[x.direction]), esc(EXIT[x.exitReason] || x.exitReason),
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
    set("causes", c.trades ? '<p class="muted">' + esc(c.trades) + " 件 (勝ち " + esc(c.outcomes.win) + " / 負け " + esc(c.outcomes.loss) + ")</p>" +
      table(["要因", "件数", ""], codes.map(function (k) {
        return [esc(labels[k] || k), esc(c.all[k]) + (c.loss[k] ? ' <span class="neg">(負け ' + esc(c.loss[k]) + ")</span>" : ""),
          '<div class="bar" style="width:' + Math.round(100 * c.all[k] / max) + '%"></div>'];
      }), [false, true, false]) : '<p class="muted">まだありません</p>');
    set("lessons", l.lessons.length ? '<ul class="plain">' + l.lessons.map(function (x) {
      return "<li>" + esc(x.text) + ' <span class="muted">[' + esc(x.scope) + " / " + (x.origin === "llm" ? "AI" : "ルール") + "]</span></li>";
    }).join("") + "</ul>" : '<p class="muted">まだありません</p>');
    set("adjustments", table(["日時", "戦略/資産", "パラメータ", "変更", "状態", "検証 (現行→候補)", "理由"], l.adjustments.slice().reverse().map(function (a) {
      return [esc(time(a.createdAt)), esc(a.strategyId + "/" + a.assetClass), esc(a.param), esc(a.from + " → " + a.to), esc(ADJ[a.status] || a.status),
        esc(a.validation ? num(a.validation.baselineScore, 2) + " → " + num(a.validation.candidateScore, 2) + " (" + a.validation.trades + "件)" : "-"), '<span class="muted">' + esc(a.reason) + "</span>"];
    })));
    var src = Object.keys(l.sources).map(function (k) { return l.sources[k]; }).sort(function (a, b) { return b.n - a.n; });
    set("sources", table(["情報源", "件数", "的中", "重み"], src.map(function (x) {
      return [esc(x.source), esc(x.n), esc(x.hits), esc(num(x.weight, 2))];
    }), [false, true, true, true]) + '<p class="muted">情報の効き具合: ' + Object.keys(l.intelInfluence).map(function (k) { return esc(k + " " + num(l.intelInfluence[k], 2)); }).join(" / ") + "</p>");
    set("arms", table(["腕", "件数", "勝率", "期待R", "配分倍率", "状態"], l.arms.slice().sort(function (a, b) { return b.n - a.n; }).map(function (a) {
      return [esc(a.key), esc(a.n), esc(pct(a.winRate, 1)), '<span class="' + cls(a.meanR) + '">' + esc(num(a.meanR, 3)) + "</span>", esc(num(a.weight, 2)),
        a.disabled ? '<span class="neg">停止</span>' : "有効"];
    }), [false, true, true, true, true, false]));
  }

  // タブの切り替え (選んだタブはこの端末に記憶する)
  var TAB_KEY = "dashboard.tab";
  function showTab(name) {
    var btns = document.querySelectorAll("nav#tabs button");
    var ok = false;
    for (var i = 0; i < btns.length; i++) if (btns[i].getAttribute("data-tab") === name) ok = true;
    if (!ok) name = "live";
    for (var j = 0; j < btns.length; j++) btns[j].setAttribute("aria-selected", btns[j].getAttribute("data-tab") === name ? "true" : "false");
    var secs = document.querySelectorAll("main section[data-tab]");
    for (var k = 0; k < secs.length; k++) secs[k].hidden = secs[k].getAttribute("data-tab") !== name;
    if (window.__lv) window.__lv.setVisible(name === "live");
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 保存できなくても表示は続ける */ }
  }
  document.getElementById("tabs").addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest("button[data-tab]") : null;
    if (t) { showTab(t.getAttribute("data-tab")); window.scrollTo(0, 0); }
  });
  function fitHeader() { document.documentElement.style.setProperty("--hdr", document.querySelector("header").offsetHeight + "px"); }
  window.addEventListener("resize", function () { fitHeader(); if (typeof renderCandles === "function") renderCandles(); });
  fitHeader();
  var saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch (e) { saved = null; }
  showTab(saved || "live");

  function get(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }
  function refresh() {
    Promise.all([get("/api/status"), get("/api/trades?limit=50"), get("/api/learning")]).then(function (res) {
      renderStatus(res[0]); renderTrades(res[1]); renderLearning(res[2]);
      LV.update(res[0], res[2]);
      loadEvents().catch(function () { /* ライブの記録だけ失敗しても他の表示は続ける */ });
      loadCandles().catch(function () { /* チャートだけ失敗しても他の表示は続ける */ });
      document.getElementById("updated").textContent = new Date().toLocaleTimeString("ja-JP");
      document.getElementById("error").textContent = "";
    }).catch(function (e) {
      document.getElementById("error").textContent = "更新に失敗: " + e.message;
    });
  }
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
