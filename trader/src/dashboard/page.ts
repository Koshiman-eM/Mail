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
@media (max-width: 600px) { main { padding: 8px; gap: 8px; } .big { font-size: 22px; } th, td { padding: 4px; } }
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
<main>
  <section>
    <h2>評価額</h2>
    <div id="equity" class="big">-</div>
    <div id="equitySub" class="muted"></div>
  </section>
  <section>
    <h2>リスク状態</h2>
    <div id="risk" class="kv"></div>
  </section>
  <section class="wide">
    <h2>相場の強気・弱気</h2>
    <div id="sentiment"></div>
  </section>
  <section>
    <h2>計画・情報</h2>
    <div id="plan"></div>
  </section>
  <section class="wide">
    <h2>評価額の推移</h2>
    <div id="chart"></div>
  </section>
  <section class="wide">
    <h2>保有ポジション</h2>
    <div id="positions" class="scroll"></div>
  </section>
  <section class="wide">
    <h2>直近のトレードと損益要因</h2>
    <div id="trades" class="scroll"></div>
  </section>
  <section>
    <h2>戦略別の成績</h2>
    <div id="byStrategy" class="scroll"></div>
  </section>
  <section>
    <h2>損益要因の集計</h2>
    <div id="causes"></div>
  </section>
  <section>
    <h2>教訓</h2>
    <div id="lessons"></div>
  </section>
  <section class="wide">
    <h2>パラメータ調整</h2>
    <div id="adjustments" class="scroll"></div>
  </section>
  <section>
    <h2>情報源の信頼度</h2>
    <div id="sources" class="scroll"></div>
  </section>
  <section class="wide">
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

  function renderStatus(s) {
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

  function get(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }
  function refresh() {
    Promise.all([get("/api/status"), get("/api/trades?limit=50"), get("/api/learning")]).then(function (res) {
      renderStatus(res[0]); renderTrades(res[1]); renderLearning(res[2]);
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
