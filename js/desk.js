/* 看盘页。读三个文件：config/tickers.json、data/market.json、data/portfolio.json。
   不连券商，不下单。行情数字来自 market.json，账户和建议来自 portfolio.json。 */
(function () {
  const app = document.getElementById("app");
  const state = {
    tf: "d",
    openGroups: new Set(),
    active: null,
    barIndex: null,
    logOpen: new Set(),
    roleOpen: new Set(),
    newsAll: false,
  };
  let CONFIG = null;
  let MARKET = { symbols: {}, market: {} };
  let PORTFOLIO = null;
  let GROUPS = [];
  let MARK = null;

  const AVATAR = ["#3ee0a0", "#8eb7ff", "#ffc46b", "#ff9b7a", "#d2b0ff", "#7ad7ff", "#f0a36a", "#b6e38a"];
  const TF_LABEL = [["m", "分钟"], ["d", "日"], ["mo", "月"], ["y", "年"]];

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function num(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dirClass(value) {
    const n = num(value);
    if (n == null || Math.abs(n) < 0.005) return "flat";
    return n > 0 ? "up" : "down";
  }

  function usd(value, digits) {
    const n = num(value);
    if (n == null) return "—";
    const d = digits == null ? 2 : digits;
    const body = Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
    return (n < 0 ? "-$" : "$") + body;
  }

  function usdCompact(value) {
    const n = num(value);
    if (n == null) return "—";
    const digits = Math.abs(n - Math.round(n)) < 0.001 ? 0 : 2;
    return usd(n, digits);
  }

  function signedUsd(value) {
    const n = num(value);
    if (n == null) return "—";
    if (Math.abs(n) < 0.005) return usd(0);
    return (n > 0 ? "+" : "-") + usd(Math.abs(n));
  }

  function pct(value, digits) {
    const n = num(value);
    const d = digits == null ? 2 : digits;
    if (n == null) return "—";
    if (Math.abs(n) < 0.5 * Math.pow(10, -d)) return (0).toFixed(d) + "%";
    return (n > 0 ? "+" : "") + n.toFixed(d) + "%";
  }

  function volText(value) {
    const n = num(value);
    if (n == null) return "—";
    return (Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(1)) + "%";
  }

  function pxPlain(value) {
    const n = num(value);
    if (n == null) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value));
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch (err) {
      return "";
    }
    return "";
  }

  function linkify(text) {
    return esc(text).replace(/https?:\/\/[^\s<]+/g, (raw) => {
      const trimmed = raw.replace(/[),。，]+$/g, "");
      const href = safeUrl(trimmed);
      if (!href) return raw;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(trimmed)}</a>`;
    });
  }

  function weekdayZh(iso) {
    const parts = String(iso || "").split("-").map(Number);
    if (parts.length < 3 || parts.some((n) => !n)) return "";
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return "日一二三四五六"[date.getUTCDay()] || "";
  }

  function prefersReduced() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  async function loadJson(path) {
    const response = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error(path + " " + response.status);
    return response.json();
  }

  function buildGroups(config) {
    const defined = new Map();
    for (const group of config.groups || []) {
      defined.set(group.id, {
        id: group.id,
        name: group.name,
        openDefault: !!group.open,
        symbols: [],
      });
    }
    if (!defined.has("other")) {
      defined.set("other", { id: "other", name: "其他", openDefault: false, symbols: [] });
    }
    const order = (config.groups || []).map((group) => group.id);
    if (!order.includes("other")) order.push("other");
    for (const ticker of config.tickers || []) {
      const bucket = defined.get(ticker.group) || defined.get("other");
      bucket.symbols.push(ticker);
    }
    return order.map((id) => defined.get(id)).filter((group) => group && group.symbols.length);
  }

  function groupIdOf(sym) {
    for (const group of GROUPS) {
      if (group.symbols.some((ticker) => ticker.sym === sym)) return group.id;
    }
    return null;
  }

  function tickerOf(sym) {
    for (const group of GROUPS) {
      const found = group.symbols.find((ticker) => ticker.sym === sym);
      if (found) return found;
    }
    return { sym: sym, name: sym, kind: "" };
  }

  function quoteOf(sym) {
    return (MARKET.symbols || {})[sym] || null;
  }

  function adviceOf(sym) {
    return (PORTFOLIO && PORTFOLIO.symbols && PORTFOLIO.symbols[sym]) || null;
  }

  function hasDaily(quote) {
    return !!(quote && quote.bars && quote.bars.d && quote.bars.d.c && quote.bars.d.c.length);
  }

  function applyQuery() {
    const params = new URLSearchParams(location.search);
    const tf = params.get("tf");
    if (tf === "m" || tf === "d" || tf === "mo" || tf === "y") state.tf = tf;
    if (params.get("expand") === "all") state.openGroups = new Set(GROUPS.map((group) => group.id));
    const group = params.get("group");
    if (group) state.openGroups.add(group);
    const sym = (params.get("sym") || "").toUpperCase();
    if (sym && GROUPS.some((item) => item.symbols.some((ticker) => ticker.sym === sym))) {
      state.active = sym;
      const owner = groupIdOf(sym);
      if (owner) state.openGroups.add(owner);
    }
  }

  function computeMark() {
    const account = (PORTFOLIO && PORTFOLIO.account) || {};
    const cash = num(account.cash);
    const start = num(account.start);
    const rows = [];
    let marketValue = 0;
    let priced = true;
    for (const pos of (PORTFOLIO && PORTFOLIO.positions) || []) {
      if (!pos || !pos.sym) continue;
      const qty = num(pos.qty) || 0;
      const cost = num(pos.cost);
      const quote = quoteOf(pos.sym);
      const last = quote && !quote.missing ? num(quote.last) : null;
      const value = last != null ? qty * last : null;
      const pnl = last != null && cost != null ? (last - cost) * qty : null;
      if (qty && last == null) priced = false;
      if (value != null) marketValue += value;
      if (qty) rows.push({ sym: pos.sym, qty: qty, cost: cost, last: last, value: value, pnl: pnl, note: pos.note || "" });
    }
    let equity = null;
    let ret = null;
    if (priced && cash != null) {
      equity = cash + marketValue;
      if (start) ret = (equity / start - 1) * 100;
    } else {
      equity = num(account.equity);
      ret = num(account.returnPct);
    }
    return {
      cash: cash,
      start: start,
      equity: equity,
      ret: ret,
      marketValue: marketValue,
      rows: rows,
      priced: priced,
      trades: account.trades,
      wins: account.wins,
      losses: account.losses,
      startDate: account.startDate || "",
    };
  }

  function positionOf(sym) {
    return MARK.rows.find((row) => row.sym === sym) || null;
  }

  function avatarColor(sym) {
    let hash = 0;
    for (const ch of String(sym)) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
    return AVATAR[hash % AVATAR.length];
  }

  function sigClass(advice) {
    const signal = ((advice && advice.signal) || "").toUpperCase();
    const name = (advice && advice.signalCn) || "";
    if (signal === "BUY" || name.includes("买入")) return "sig-buy";
    if (signal === "SELL" || name.includes("卖") || name.includes("回避")) return "sig-sell";
    if (name.includes("参考")) return "sig-ref";
    if (signal === "WATCH" || name.includes("分批")) return "sig-watch";
    return "sig-hold";
  }

  function badgeText(advice) {
    if (!advice || (!advice.signal && !advice.signalCn)) return "暂无建议";
    if (advice.signal && advice.signalCn && advice.signal !== advice.signalCn) {
      return advice.signal + " · " + advice.signalCn;
    }
    return advice.signalCn || advice.signal;
  }

  function suggestionTitle(advice) {
    if (!advice) return "暂无建议";
    const name = advice.signalCn || advice.signal || "建议";
    const cap = num(advice.cap);
    const planned = ((advice.signal || "").toUpperCase() === "WATCH") || String(advice.signalCn || "").includes("分批");
    if (planned && cap != null) return name + "（上限 " + Math.round(cap * 100) + "% 资金）";
    return name;
  }

  function actClass(act) {
    const key = String(act || "").toUpperCase();
    if (key === "BUY" || key === "SELL" || key === "EXEC") return key === "SELL" ? "tag-sell" : "tag-buy";
    if (key === "BLOCK" || key === "STOP") return "tag-block";
    if (key === "WATCH" || key === "NEWS" || key === "DATA") return "tag-watch";
    return "tag-hold";
  }

  function asOfText() {
    if (MARKET.sessionCloseRome) return "数据截至 " + MARKET.sessionCloseRome + "（罗马时间）";
    if (MARKET.asOfRome) return "数据截至 " + MARKET.asOfRome + "（罗马时间）";
    return "数据时间未知";
  }

  function segHtml() {
    return `<div class="seg" role="group" aria-label="K线周期">${TF_LABEL.map(([id, label]) =>
      `<button type="button" data-act="tf" data-tf="${id}" class="${state.tf === id ? "on" : ""}" aria-pressed="${state.tf === id}">${label}</button>`
    ).join("")}</div>`;
  }

  function logoHtml(open) {
    return `<span class="logo ${open ? "open" : "closed"}" aria-hidden="true"><svg viewBox="0 0 32 32">
      <line x1="11" y1="7" x2="11" y2="25" stroke="#ff6b7a" stroke-width="1.6" stroke-linecap="round"/>
      <rect x="8.2" y="12" width="5.6" height="8" rx="1" fill="#ff6b7a"/>
      <line x1="21" y1="6" x2="21" y2="24" stroke="#3ee0a0" stroke-width="1.6" stroke-linecap="round"/>
      <rect x="18.2" y="10" width="5.6" height="10" rx="1" fill="#3ee0a0"/>
    </svg></span>`;
  }

  function headerHtml() {
    const gate = (PORTFOLIO && PORTFOLIO.gate) || {};
    return `<header class="topbar">${logoHtml(!!gate.open)}<div>
      <h1>股票交易员 · 中长线模拟盘</h1>
      <p class="asof">${esc(asOfText())}</p>
    </div></header>`;
  }

  function accountHtml() {
    if (!PORTFOLIO) {
      return `<section class="account"><p class="warn">没有读到模拟账户。行情仍然可以看。账户文件是 data/portfolio.json。</p></section>`;
    }
    const gate = PORTFOLIO.gate || {};
    const open = !!gate.open;
    const chips = (PORTFOLIO.roles || []).map((role) =>
      `<button type="button" class="chip" data-act="goto-role" data-id="${esc(role.id)}">${esc(role.name || role.id)}</button>`
    ).join("");
    const bookNote = MARK.priced
      ? "总权益按最近收盘价估算：现金 + 持仓股数 × 收盘价。不是实时价。"
      : "有的持仓还没有收盘价，总权益暂时用账本里记下的数字。";
    return `<section class="account">
      <p class="eyebrow">模拟账户${MARK.startDate ? " · 从 " + esc(MARK.startDate) + " 开始" : ""} · 美元</p>
      <div class="equity">${esc(usd(MARK.equity))}</div>
      <div class="ret ${dirClass(MARK.ret)}">收益率 ${esc(pct(MARK.ret))}</div>
      <div class="metrics">
        <div><span>现金</span><b>${esc(usd(MARK.cash))}</b></div>
        <div><span>持仓市值</span><b>${esc(usd(MARK.marketValue))}</b></div>
        <div><span>成交</span><b>${esc(MARK.trades == null ? "—" : MARK.trades + " 笔")}</b></div>
      </div>
      <p class="wins">胜 ${esc(MARK.wins ?? 0)} · 负 ${esc(MARK.losses ?? 0)} · 起始 ${esc(usd(MARK.start))}</p>
      <div class="gate ${open ? "open" : "closed"}">
        <div class="gate-top"><span class="dot"></span>闸门 · ${esc(gate.label || (open ? "已开闸" : "未开闸"))}</div>
        <p>${esc(gate.reason || "还没有写闸门说明。")}</p>
      </div>
      ${PORTFOLIO.hubLine ? `<p class="hub">${esc(PORTFOLIO.hubLine)}</p>` : ""}
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      <p class="estimate">${bookNote}</p>
    </section>`;
  }

  function marketHtml() {
    const items = (CONFIG.market || []).map((item) => {
      const quote = (MARKET.market || {})[item.id] || {};
      if (quote.missing || quote.last == null) {
        return `<article class="mkt"><div class="mkt-k">${esc(item.name)}</div><div class="mkt-v flat">暂无数据</div></article>`;
      }
      return `<article class="mkt">
        <div class="mkt-k">${esc(quote.name || item.name)}</div>
        <div class="mkt-v">${esc(pxPlain(quote.last))}</div>
        <div class="mkt-c ${dirClass(quote.chgPct)}">${esc(pct(quote.chgPct))}</div>
        <div class="mkt-d">${esc(quote.date || "")}${quote.stale ? " · 沿用上次" : ""} 收盘</div>
      </article>`;
    }).join("");
    return `<section class="market"><h2 class="section-label">大盘</h2><div class="market-row">${items}</div></section>`;
  }

  function sparkHtml(quote) {
    const closes = quote && quote.bars && quote.bars.d && quote.bars.d.c;
    const values = (closes || []).map(num).filter((v) => v != null).slice(-40);
    if (values.length < 2) return `<div class="empty-mini">暂无 K 线数据</div>`;
    const w = 160;
    const h = 42;
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const span = max - min || 1;
    const coords = values.map((value, index) => {
      const x = (w * index) / (values.length - 1);
      const y = 3 + (h - 6) * (1 - (value - min) / span);
      return [x, y];
    });
    const line = coords.map((pair) => pair[0].toFixed(1) + "," + pair[1].toFixed(1)).join(" ");
    const up = values[values.length - 1] >= values[0];
    const color = up ? "#3ee0a0" : "#ff6b7a";
    const fill = line + ` ${w},${h} 0,${h}`;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polygon points="${fill}" fill="${color}" opacity="0.14"></polygon>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"></polyline>
    </svg>`;
  }

  function summaryHtml(symbols) {
    const counts = new Map();
    let sum = 0;
    let n = 0;
    let best = null;
    let missing = 0;
    symbols.forEach((ticker) => {
      const advice = adviceOf(ticker.sym);
      const label = (advice && advice.signalCn) || "无建议";
      counts.set(label, (counts.get(label) || 0) + 1);
      const quote = quoteOf(ticker.sym);
      if (!hasDaily(quote)) missing += 1;
      const change = quote && !quote.missing ? num(quote.chgPct) : null;
      if (change == null) return;
      sum += change;
      n += 1;
      if (!best || change > best.chg) best = { sym: ticker.sym, chg: change };
    });
    const order = ["计划分批", "回避", "观察", "行情参考", "无建议"];
    const labels = Array.from(counts.keys()).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const parts = labels.map((label) => esc(label) + " " + counts.get(label));
    if (n) parts.push(`当日平均 <span class="${dirClass(sum / n)}">${esc(pct(sum / n))}</span>`);
    if (best) parts.push(`涨最多 ${esc(best.sym)} <span class="${dirClass(best.chg)}">${esc(pct(best.chg))}</span>`);
    if (missing) parts.push(missing + " 只暂无 K 线");
    return parts.join(" · ");
  }

  function cardHtml(ticker) {
    const quote = quoteOf(ticker.sym);
    const missing = !quote || quote.missing || quote.last == null;
    const pos = positionOf(ticker.sym);
    const active = state.active === ticker.sym;
    const change = quote && !quote.missing ? num(quote.chgPct) : null;
    return `<button type="button" class="card ${active ? "active" : ""}" data-act="open" data-sym="${esc(ticker.sym)}">
      <div class="card-top">
        <span class="av" style="background:${avatarColor(ticker.sym)}">${esc(ticker.sym.slice(0, 1))}</span>
        <span class="sym">${esc(ticker.sym)}</span>
        ${missing ? "" : `<span class="chg ${dirClass(change)}">${esc(pct(change))}</span>`}
      </div>
      <div class="card-px">
        <span class="px">${missing ? "暂无数据" : esc(usd(quote.last))}</span>
        <span class="nm">${esc(ticker.name)}</span>
        ${quote && quote.stale ? `<span class="stale">沿用上次</span>` : ""}
      </div>
      ${sparkHtml(quote)}
      <div class="card-foot">
        <span>${pos ? esc(formatQty(pos.qty)) : "0 笔"}</span>
        <span class="${pos ? dirClass(pos.pnl) : "flat"}">${pos ? esc(signedUsd(pos.pnl)) : "$0.00"}</span>
      </div>
      <div class="card-hint">${active ? "▲ 详情已展开" : "点击查看详情"}</div>
    </button>`;
  }

  function formatQty(qty) {
    const n = num(qty) || 0;
    const body = Math.abs(n - Math.round(n)) < 0.001 ? String(Math.round(n)) : n.toFixed(2);
    return body + " 股";
  }

  function clampIndex(index, length) {
    if (!length) return -1;
    if (index == null || index < 0 || index >= length) return length - 1;
    return index;
  }

  function useLog(tf, bars) {
    if (tf !== "y") return false;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < bars.c.length; i++) {
      const low = num(bars.l[i]);
      const high = num(bars.h[i]);
      if (low != null) min = Math.min(min, low);
      if (high != null) max = Math.max(max, high);
    }
    return min > 0 && max / min > 20;
  }

  function niceTicks(min, max) {
    const span = max - min || 1;
    const rough = span / 3;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const err = rough / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const start = Math.ceil((min + span * 0.02) / step) * step;
    const ticks = [];
    for (let i = 0; i < 6; i++) {
      const value = start + i * step;
      if (value >= max - span * 0.02) break;
      ticks.push(value);
    }
    if (ticks.length < 2) return [min + span * 0.25, min + span * 0.75];
    return ticks;
  }

  function logTicks(min, max) {
    const a = Math.log(min);
    const b = Math.log(max);
    const ticks = [];
    for (let i = 0; i < 4; i++) ticks.push(Math.exp(a + ((b - a) * i) / 3));
    return ticks;
  }

  function axisPx(value) {
    const n = Number(value);
    const digits = Math.abs(n) >= 100 ? 0 : 2;
    const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return (n < 0 ? "-$" : "$") + body;
  }

  function shortDate(tf, label) {
    const text = String(label ?? "");
    if (tf === "d" && text.length >= 10) return text.slice(5);
    if (tf === "mo" && text.length >= 7) return text.slice(2);
    return text;
  }

  function dateTickIndexes(count) {
    const want = count <= 6 ? count : 5;
    const set = new Set();
    for (let i = 0; i < want; i++) set.add(Math.round((i * (count - 1)) / (want - 1 || 1)));
    return Array.from(set.values());
  }

  function maPath(values, xOf, yOf) {
    if (!values) return "";
    let d = "";
    let drawing = false;
    for (let i = 0; i < values.length; i++) {
      const value = num(values[i]);
      if (value == null) {
        drawing = false;
        continue;
      }
      d += (drawing ? "L" : "M") + xOf(i).toFixed(1) + "," + yOf(value).toFixed(1);
      drawing = true;
    }
    return d;
  }

  function chartSvg(bars, tf, selected) {
    const n = bars.c.length;
    const W = 720;
    const H = 292;
    const left = 58;
    const right = 10;
    const top = 12;
    const bottom = 26;
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    let min = Infinity;
    let max = -Infinity;
    const consider = (value) => {
      const parsed = num(value);
      if (parsed == null) return;
      min = Math.min(min, parsed);
      max = Math.max(max, parsed);
    };
    for (let i = 0; i < n; i++) {
      consider(bars.l[i]);
      consider(bars.h[i]);
      if (bars.ma50) consider(bars.ma50[i]);
      if (bars.ma200) consider(bars.ma200[i]);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return `<div class="empty-chart">暂无 K 线数据</div>`;
    const log = useLog(tf, bars);
    if (log) {
      const a = Math.log(min);
      const b = Math.log(max);
      const pad = (b - a) * 0.08 || 0.04;
      min = Math.exp(a - pad);
      max = Math.exp(b + pad);
    } else {
      const pad = (max - min) * 0.08 || Math.abs(max) * 0.04 || 1;
      min -= pad;
      max += pad;
      if (min < 0) min = 0;
    }
    const yOf = (value) => {
      if (log) {
        const a = Math.log(min);
        const b = Math.log(max);
        return top + ((b - Math.log(value)) / (b - a || 1)) * plotH;
      }
      return top + ((max - value) / (max - min || 1)) * plotH;
    };
    const slot = plotW / n;
    const xOf = (i) => left + slot * (i + 0.5);
    const bodyW = Math.max(1.6, Math.min(12, slot * 0.62));
    const parts = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="K线图">`];
    const ticks = log ? logTicks(min, max) : niceTicks(min, max);
    ticks.forEach((tick) => {
      const y = yOf(tick);
      parts.push(`<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" stroke="rgba(232,237,245,0.08)"></line>`);
      parts.push(`<text x="${left - 6}" y="${y.toFixed(1)}" fill="#93a0b5" font-size="11" text-anchor="end" dominant-baseline="middle">${esc(axisPx(tick))}</text>`);
    });
    for (let i = 0; i < n; i++) {
      const open = num(bars.o[i]);
      const high = num(bars.h[i]);
      const low = num(bars.l[i]);
      const close = num(bars.c[i]);
      if (open == null || high == null || low == null || close == null) continue;
      const up = close >= open;
      const color = up ? "#3ee0a0" : "#ff6b7a";
      const x = xOf(i);
      const yHigh = yOf(high);
      const yLow = yOf(low);
      const yOpen = yOf(open);
      const yClose = yOf(close);
      const topY = Math.min(yOpen, yClose);
      const height = Math.max(1, Math.abs(yClose - yOpen));
      parts.push(`<line x1="${x.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1.2"></line>`);
      parts.push(`<rect x="${(x - bodyW / 2).toFixed(1)}" y="${topY.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${height.toFixed(1)}" fill="${color}" rx="0.6"></rect>`);
      if (i === selected) {
        parts.push(`<rect x="${(x - bodyW / 2 - 1.2).toFixed(1)}" y="${(topY - 1.5).toFixed(1)}" width="${(bodyW + 2.4).toFixed(1)}" height="${(height + 3).toFixed(1)}" fill="none" stroke="#e8edf5" stroke-width="1" rx="1"></rect>`);
      }
    }
    const ma50 = maPath(bars.ma50, xOf, yOf);
    const ma200 = maPath(bars.ma200, xOf, yOf);
    if (ma50) parts.push(`<path d="${ma50}" fill="none" stroke="#7eb6ff" stroke-width="1.4" stroke-dasharray="5 4"></path>`);
    if (ma200) parts.push(`<path d="${ma200}" fill="none" stroke="#f0a36a" stroke-width="1.4" stroke-dasharray="1.5 3"></path>`);
    if (selected >= 0) {
      const x = xOf(selected);
      parts.push(`<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${top + plotH}" stroke="rgba(232,237,245,0.38)" stroke-dasharray="3 3"></line>`);
    }
    dateTickIndexes(n).forEach((index, order, all) => {
      const anchor = order === 0 ? "start" : order === all.length - 1 ? "end" : "middle";
      const x = order === 0 ? left : order === all.length - 1 ? W - right : xOf(index);
      parts.push(`<text x="${x.toFixed(1)}" y="${H - 6}" fill="#93a0b5" font-size="11" text-anchor="${anchor}">${esc(shortDate(tf, bars.t[index]))}</text>`);
    });
    for (let i = 0; i < n; i++) {
      const x = left + slot * i;
      parts.push(`<rect class="hit" data-act="bar" data-i="${i}" x="${x.toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"></rect>`);
    }
    parts.push("</svg>");
    return `<div class="chart">${parts.join("")}</div>`;
  }

  function describe(tf, bars, quote) {
    const n = bars.c.length;
    const start = bars.t[0];
    const end = bars.t[n - 1];
    if (tf === "m") {
      const date = bars.date || "";
      const week = weekdayZh(date);
      return `5 分钟 K · ${date}${week ? "（周" + week + "）" : ""}美东 ${start}–16:00 · ${n} 根 · 收盘后快照，不是实时 · 来源 Yahoo Finance`;
    }
    if (tf === "d") {
      const has200 = Array.isArray(bars.ma200) && bars.ma200.some((value) => value != null);
      const has50 = Array.isArray(bars.ma50) && bars.ma50.some((value) => value != null);
      let ma = "没有均线";
      if (has50 && has200) ma = "虚线 = 50 / 200 日均线";
      else if (has50) ma = "虚线 = 50 日均线（历史不满 200 个交易日，没有 200 日线）";
      let extra = "";
      if (quote && quote.sessions && quote.sessions < 252 && quote.listedFrom) {
        extra = ` · 自 ${quote.listedFrom} 起，现有 ${quote.sessions} 个交易日`;
      }
      return `日 K · 最近 ${n} 个交易日（${start} 至 ${end}）${extra} · ${ma} · 来源 Yahoo Finance`;
    }
    if (tf === "mo") return `月 K · ${start} 至 ${end} · ${n} 根 · 最后一根是还没结束的月份 · 来源 Yahoo Finance`;
    const first = bars.first || start;
    const log = useLog(tf, bars);
    return `年 K · ${start} 至 ${end} · ${n} 根 · 从 ${first} 起算 · 今年还没结束 · 按拆股调整${log ? " · 价格相差很大，用对数刻度" : ""} · 来源 Yahoo Finance`;
  }

  function ohlcHtml(bars, tf, index) {
    const open = num(bars.o[index]);
    const high = num(bars.h[index]);
    const low = num(bars.l[index]);
    const close = num(bars.c[index]);
    const prev = index > 0 ? num(bars.c[index - 1]) : null;
    const change = prev ? (close / prev - 1) * 100 : null;
    const label = tf === "m" && bars.date ? bars.date + " " + bars.t[index] : bars.t[index];
    let html = `${esc(label)} 开 ${esc(usd(open))} 高 ${esc(usd(high))} 低 ${esc(usd(low))} 收 ${esc(usd(close))}`;
    if (change != null) html += `（<span class="${dirClass(change)}">${esc(pct(change))}</span>）`;
    if (bars.ma50 && num(bars.ma50[index]) != null) html += ` · 50日线 ${esc(usd(bars.ma50[index]))}`;
    if (bars.ma200 && num(bars.ma200[index]) != null) html += ` · 200日线 ${esc(usd(bars.ma200[index]))}`;
    return html;
  }

  function legendHtml(bars) {
    const has50 = bars && Array.isArray(bars.ma50) && bars.ma50.some((value) => value != null);
    const has200 = bars && Array.isArray(bars.ma200) && bars.ma200.some((value) => value != null);
    return `<div class="legend">
      <span><i class="swatch up"></i>涨（收≥开）</span>
      <span><i class="swatch down"></i>跌</span>
      ${has50 ? `<span><i class="ma-key ma50"></i>50日均线</span>` : ""}
      ${has200 ? `<span><i class="ma-key ma200"></i>200日均线</span>` : ""}
    </div>`;
  }

  function chartBlock(quote, tf) {
    const bars = quote && quote.bars && quote.bars[tf];
    if (!bars || !bars.c || !bars.c.length) {
      return `<div class="empty-chart">暂无 K 线数据</div><p class="note">这个周期暂时没有数据。</p>`;
    }
    const selected = clampIndex(state.barIndex, bars.c.length);
    return legendHtml(bars) + chartSvg(bars, tf, selected) +
      `<p class="ohlc">${ohlcHtml(bars, tf, selected)}</p><p class="note">${esc(describe(tf, bars, quote))}</p>`;
  }

  function stat(label, value, cls) {
    return `<div class="stat"><span class="k">${esc(label)}</span><span class="v ${cls || ""}">${esc(value)}</span></div>`;
  }

  function detailHtml(ticker) {
    const quote = quoteOf(ticker.sym) || {};
    const advice = adviceOf(ticker.sym);
    const missing = !quote || quote.missing || quote.last == null;
    const bars = quote.bars && quote.bars[state.tf];
    const ddName = quote.ddSpan && quote.ddSpan < 252 ? "距最高收盘" : "距一年最高收盘";
    const risks = (advice && advice.risks) || [];
    const triggers = (advice && advice.triggers) || [];
    const facts = (advice && advice.facts) || [];
    const news = newsFor(ticker.sym, ticker.kind).slice(0, 6);
    const stats = missing ? `<p class="muted">暂无数据</p>` : `<div class="stats">
      ${stat("最新价", usd(quote.last))}
      ${stat("当日", pct(quote.chgPct), dirClass(quote.chgPct))}
      ${stat("近 1 月", pct(quote.r1m, 1), dirClass(quote.r1m))}
      ${stat("近 3 月", pct(quote.r3m, 1), dirClass(quote.r3m))}
      ${stat("52 周最高", usd(quote.hi52))}
      ${stat("52 周最低", usd(quote.lo52))}
      ${stat(ddName, pct(quote.dd, 1), dirClass(quote.dd))}
      ${stat("20 日波动率", volText(quote.vol20))}
      ${stat("50 日均线", quote.sma50 == null ? "—" : usd(quote.sma50))}
      ${stat("200 日均线", quote.sma200 == null ? "不满 200 天" : usd(quote.sma200))}
    </div>`;
    const adviceBlock = `<div class="advice">
      <div class="advice-title">${esc(suggestionTitle(advice))}</div>
      <p>${advice && advice.reason ? linkify(advice.reason) : "暂无建议。"}</p>
      ${advice && advice.watch ? `<p class="watch-line">${linkify(advice.watch)}</p>` : ""}
    </div>`;
    const riskBlock = risks.length ? `<div><div class="block-title">风险</div><ul class="list">${risks.map((item) =>
      `<li><span class="bang">!</span><span>${linkify(item)}</span></li>`).join("")}</ul></div>` : "";
    const triggerBlock = triggers.length ? `<div><div class="block-title">什么时候买（触发条件）</div><ul class="list">${triggers.map((item) =>
      `<li><span class="arrow">→</span><span>${linkify(item)}</span></li>`).join("")}</ul></div>` : "";
    const split = riskBlock || triggerBlock
      ? `<div class="split ${riskBlock && triggerBlock ? "two" : ""}">${riskBlock}${triggerBlock}</div>`
      : "";
    const factBlock = facts.length ? `<div class="block-title">关键事实</div><ul class="facts">${facts.map((item) => `<li>${linkify(item)}</li>`).join("")}</ul>` : "";
    const newsBlock = news.length ? `<div class="block-title">相关消息</div>${news.map(newsItem).join("")}` : "";
    return `<article class="detail" id="detail">
      <div class="detail-top">
        <div class="id-block">
          <div class="id-line">
            <span class="av" style="background:${avatarColor(ticker.sym)}">${esc(ticker.sym.slice(0, 1))}</span>
            <strong>${esc(ticker.sym)}</strong>
            <span class="who">${esc(ticker.name)}${ticker.kind ? " · " + esc(ticker.kind) : ""}</span>
            <span class="badge ${sigClass(advice)}">${esc(badgeText(advice))}</span>
          </div>
        </div>
        <button type="button" class="close" data-act="close">关闭 ×</button>
      </div>
      <div class="chart-head">
        <p class="kicker">K线大图 · 点按钮切换周期</p>
        ${segHtml()}
      </div>
      ${chartBlock(quote, state.tf)}
      <div class="block-title">关键数字</div>
      ${stats}
      ${quote.date ? `<p class="note">收盘日 ${esc(quote.date)}。点一根 K 线，看那天的开高低收。</p>` : ""}
      <div class="block-title">建议</div>
      ${adviceBlock}
      ${split}
      ${factBlock}
      ${newsBlock}
    </article>`;
  }

  function newsFor(sym, kind) {
    return ((PORTFOLIO && PORTFOLIO.news) || []).filter((item) => {
      const tokens = String(item.sym || "").split(/\s+/).filter(Boolean);
      if (tokens.includes(sym)) return true;
      return kind === "ETF" && tokens.includes("大盘");
    });
  }

  function newsItem(item) {
    const href = safeUrl(item.href);
    const meta = [item.site, item.date, item.sym].filter(Boolean).map(esc).join(" · ");
    const body = `<span class="news-title">${esc(item.title || "未命名")}</span><span class="news-meta">${meta}</span>`;
    if (!href) return `<div class="news">${body}</div>`;
    return `<a class="news" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${body}</a>`;
  }

  function watchHtml() {
    const groups = GROUPS.map((group) => {
      const open = state.openGroups.has(group.id);
      const names = group.symbols.map((ticker) => ticker.sym).join(" · ");
      const cards = open ? `<div class="cards">${group.symbols.map(cardHtml).join("")}</div>` : "";
      const detail = open && state.active && group.symbols.some((ticker) => ticker.sym === state.active)
        ? detailHtml(tickerOf(state.active))
        : "";
      return `<section class="group ${open ? "open" : ""}">
        <button type="button" class="group-h" data-act="toggle-group" data-id="${esc(group.id)}" aria-expanded="${open}">
          <div class="group-line">
            <span class="chev"></span>
            <span class="gname">${esc(group.name)}</span>
            <span class="gmeta">${group.symbols.length} 只 · ${esc(names)}</span>
            <span class="gact">${open ? "收起" : "展开"}</span>
          </div>
          <div class="gsum">${summaryHtml(group.symbols)}</div>
        </button>
        ${cards}
        ${detail}
      </section>`;
    }).join("");
    return `<section class="watch">
      <div class="toolbar">
        <div>
          <h2 class="section-label">自选</h2>
          ${segHtml()}
        </div>
        <div class="toolbar-actions">
          <button type="button" class="text-btn" data-act="expand">全部展开</button>
          <button type="button" class="text-btn" data-act="collapse">全部收起</button>
        </div>
      </div>
      ${groups}
    </section>`;
  }

  function positionsHtml() {
    if (!PORTFOLIO) return "";
    const rows = MARK.rows.length
      ? MARK.rows.map((row) => {
          const ticker = tickerOf(row.sym);
          return `<div class="pos">
            <b>${esc(row.sym)}</b><span class="muted">${esc(ticker.name)}</span>
            <span>${esc(formatQty(row.qty))}</span>
            <span>成本 ${esc(usd(row.cost))}</span>
            <span>现价 ${row.last == null ? "暂无数据" : esc(usd(row.last))}</span>
            <span>市值 ${row.value == null ? "—" : esc(usd(row.value))}</span>
            <span class="${dirClass(row.pnl)}">盈亏 ${esc(signedUsd(row.pnl))}</span>
            ${row.note ? `<span class="muted">${esc(row.note)}</span>` : ""}
          </div>`;
        }).join("")
      : `<p class="muted">还没有持仓，账户里全是现金。</p>`;
    return `<h2 class="section-label">持仓</h2><section class="panel">${rows}</section>`;
  }

  function logHtml() {
    const entries = (PORTFOLIO && PORTFOLIO.log) || [];
    if (!PORTFOLIO) return "";
    const rows = entries.length ? entries.map((entry, index) => {
      const open = state.logOpen.has(String(index));
      return `<div class="log-card">
        <button type="button" class="log" data-act="log" data-i="${index}">
          <span class="time">${esc(entry.t || "")}</span>
          <span class="tag ${actClass(entry.act)}">${esc(entry.act || "")}</span>
          <span class="msg">${esc(entry.msg || "")}</span>
          <span class="val">${esc(entry.val || "")}</span>
        </button>
        ${open && entry.detail ? `<div class="log-detail">${linkify(entry.detail)}</div>` : ""}
      </div>`;
    }).join("") : `<p class="muted">还没有记录。</p>`;
    return `<h2 class="section-label">记录</h2><section class="panel">${rows}<p class="note">点一条可以展开。最新的一条在最上面。这里只是模拟记录，不会真的下单。</p></section>`;
  }

  function ladderHtml() {
    const ladder = (PORTFOLIO && PORTFOLIO.ladder) || [];
    if (!PORTFOLIO) return "";
    if (!ladder.length) return `<h2 class="section-label">分批计划</h2><section class="panel"><p class="muted">还没有分批计划。</p></section>`;
    const by = new Map();
    ladder.forEach((row) => {
      if (!by.has(row.sym)) by.set(row.sym, []);
      by.get(row.sym).push(row);
    });
    const blocks = Array.from(by.entries()).map(([sym, rows]) => {
      const ticker = tickerOf(sym);
      return `<div class="ladder-sym"><h3>${esc(sym)} ${esc(ticker.name || "")}</h3>${rows.map((row) =>
        `<div class="ladder-row"><span>${esc(row.step || "")}</span><span>${esc(row.trigger || "")}</span><b>${esc(usd(row.px))} · ${esc(usdCompact(row.size))}</b></div>`
      ).join("")}</div>`;
    }).join("");
    return `<h2 class="section-label">分批计划</h2><section class="panel">${blocks}<p class="note">这是计划里的限价和大概金额，不是已经成交的单。</p></section>`;
  }

  function rulesHtml() {
    const rules = (PORTFOLIO && PORTFOLIO.rules) || [];
    if (!rules.length) return "";
    return `<h2 class="section-label">规则</h2><section class="panel"><ol class="rules">${rules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ol></section>`;
  }

  function rolesHtml() {
    const roles = (PORTFOLIO && PORTFOLIO.roles) || [];
    if (!roles.length) return "";
    const rows = roles.map((role) => {
      const open = state.roleOpen.has(role.id);
      return `<button type="button" class="role" id="role-${esc(role.id)}" data-act="role" data-id="${esc(role.id)}">
        <span class="name">${esc(role.name || role.id)}</span>
        <span class="status">${esc(role.status || "")}</span>
        ${open && role.plain ? `<p>${esc(role.plain)}</p>` : ""}
      </button>`;
    }).join("");
    return `<h2 class="section-label">角色</h2><section class="panel">${rows}<p class="note">点一条看这角色是干什么的。</p></section>`;
  }

  function newsHtml() {
    const items = (PORTFOLIO && PORTFOLIO.news) || [];
    if (!items.length) return "";
    const shown = state.newsAll ? items : items.slice(0, 6);
    const more = items.length > 6
      ? `<button type="button" class="more" data-act="news">${state.newsAll ? "收起消息" : "展开其余 " + (items.length - 6) + " 条"}</button>`
      : "";
    return `<h2 class="section-label">消息</h2><section class="panel">${shown.map(newsItem).join("")}${more}</section>`;
  }

  function footerHtml() {
    return `<footer class="footer">
      <p>${esc(MARKET.note || "")}</p>
      <p>模拟盘，只看行情和记账，不会连接券商，也不会下单。价格不是实时的，每个交易日美股收盘后更新一次。SPY、QQQ 是美国本土 ETF，人在欧洲一般买不了，这里只当大盘参考。这些文字不是投资建议。</p>
    </footer>`;
  }

  function pageHtml() {
    MARK = computeMark();
    const banner = MARKET.fetchStatus && MARKET.fetchStatus !== "ok"
      ? `<p class="banner">这次有的行情没抓全。缺的部分沿用上次成功的数据；完全没有旧数据的，显示「暂无数据」。</p>`
      : "";
    return headerHtml() + banner + `<div class="top">${accountHtml()}${marketHtml()}</div>` +
      watchHtml() + positionsHtml() + logHtml() + ladderHtml() + rulesHtml() + rolesHtml() + newsHtml() + footerHtml();
  }

  function activeBars() {
    const quote = state.active ? quoteOf(state.active) : null;
    const bars = quote && quote.bars && quote.bars[state.tf];
    if (!bars || !bars.c || !bars.c.length) return null;
    return bars;
  }

  function render(opts) {
    const y = window.scrollY;
    let html = "";
    try {
      html = pageHtml();
    } catch (err) {
      console.error(err);
      app.innerHTML = `<p class="warn">页面显示出错了。请刷新再试一次。</p>`;
      return;
    }
    app.innerHTML = html;
    if (opts && opts.scrollDetail) {
      const detail = document.getElementById("detail");
      if (detail) detail.scrollIntoView({ block: "start", behavior: prefersReduced() ? "auto" : "smooth" });
      return;
    }
    window.scrollTo(0, y);
  }

  function onClick(event) {
    const el = event.target.closest("[data-act]");
    if (!el || !app.contains(el)) return;
    const act = el.dataset.act;
    if (act === "toggle-group") {
      const id = el.dataset.id;
      if (state.openGroups.has(id)) {
        state.openGroups.delete(id);
        if (state.active && groupIdOf(state.active) === id) state.active = null;
      } else {
        state.openGroups.add(id);
      }
      render();
      return;
    }
    if (act === "expand") {
      state.openGroups = new Set(GROUPS.map((group) => group.id));
      render();
      return;
    }
    if (act === "collapse") {
      state.openGroups = new Set();
      state.active = null;
      render();
      return;
    }
    if (act === "open") {
      const sym = el.dataset.sym;
      if (state.active === sym) {
        state.active = null;
        render();
        return;
      }
      state.active = sym;
      state.barIndex = null;
      const owner = groupIdOf(sym);
      if (owner) state.openGroups.add(owner);
      render({ scrollDetail: true });
      return;
    }
    if (act === "close") {
      state.active = null;
      state.barIndex = null;
      render();
      return;
    }
    if (act === "tf") {
      state.tf = el.dataset.tf;
      state.barIndex = null;
      render();
      return;
    }
    if (act === "bar") {
      state.barIndex = Number(el.dataset.i);
      render();
      return;
    }
    if (act === "log") {
      const key = String(el.dataset.i);
      if (state.logOpen.has(key)) state.logOpen.delete(key);
      else state.logOpen.add(key);
      render();
      return;
    }
    if (act === "role") {
      const id = el.dataset.id;
      if (state.roleOpen.has(id)) state.roleOpen.delete(id);
      else state.roleOpen.add(id);
      render();
      return;
    }
    if (act === "goto-role") {
      const id = el.dataset.id;
      state.roleOpen.add(id);
      render();
      const node = document.getElementById("role-" + id);
      if (node) node.scrollIntoView({ block: "start", behavior: prefersReduced() ? "auto" : "smooth" });
      return;
    }
    if (act === "news") {
      state.newsAll = !state.newsAll;
      render();
    }
  }

  function onKey(event) {
    if (event.key === "Escape" && state.active) {
      state.active = null;
      state.barIndex = null;
      render();
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && state.active) {
      const bars = activeBars();
      if (!bars) return;
      const current = clampIndex(state.barIndex, bars.c.length);
      const next = event.key === "ArrowRight" ? Math.min(bars.c.length - 1, current + 1) : Math.max(0, current - 1);
      state.barIndex = next;
      event.preventDefault();
      render();
    }
  }

  async function boot() {
    const loaded = await Promise.allSettled([
      loadJson("config/tickers.json"),
      loadJson("data/market.json"),
      loadJson("data/portfolio.json"),
    ]);
    if (loaded[0].status !== "fulfilled" || loaded[1].status !== "fulfilled") {
      app.innerHTML = `<p class="warn">读不到行情文件。请用网站地址打开这个页面，不要把文件直接拖进浏览器。</p>`;
      return;
    }
    CONFIG = loaded[0].value;
    MARKET = loaded[1].value || {};
    PORTFOLIO = loaded[2].status === "fulfilled" ? loaded[2].value : null;
    GROUPS = buildGroups(CONFIG);
    state.openGroups = new Set(GROUPS.filter((group) => group.openDefault).map((group) => group.id));
    applyQuery();
    render();
    app.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
  }

  boot();
})();
