#!/usr/bin/env python3
"""抓取收盘行情，写入 data/market.json。

数据来自 Yahoo Finance 的公开 chart 接口，不需要 API key。
这个脚本只改 data/market.json。它绝不修改 data/portfolio.json
（模拟账户由助手手改，自动任务不能覆盖）。

某只股票抓取失败时，沿用 market.json 里上次成功的数据。
一只都没有旧数据时，写成 missing，网页会显示「暂无数据」，不会整页崩溃。
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, time as dtime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "tickers.json"
MARKET_PATH = ROOT / "data" / "market.json"
PORTFOLIO_PATH = ROOT / "data" / "portfolio.json"

ET = ZoneInfo("America/New_York")
ROME = ZoneInfo("Europe/Rome")
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}
PAUSE = 0.4


def rnd(value, digits=4):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return round(number, digits)


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_chart(sym: str, query: str) -> dict:
    encoded = quote(sym, safe="")
    last_error: Exception | None = None
    for attempt in range(4):
        host = "query1" if attempt == 3 else "query2"
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{encoded}?{query}"
        try:
            request = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            chart = payload.get("chart") or {}
            result = (chart.get("result") or [None])[0]
            if not result:
                raise RuntimeError(chart.get("error") or "empty chart")
            return result
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError, KeyError) as exc:
            last_error = exc
            wait = 1.6 * (attempt + 1)
            print(f"  retry {sym} {query} ({exc}); wait {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"{sym} {query}: {last_error}")


def rows_from_result(result: dict) -> list[dict]:
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    rows = []
    for index, stamp in enumerate(timestamps):
        try:
            open_, high, low, close = opens[index], highs[index], lows[index], closes[index]
        except IndexError:
            continue
        if None in (open_, high, low, close):
            continue
        open_, high, low, close = float(open_), float(high), float(low), float(close)
        if min(open_, high, low, close) <= 0:
            continue
        when = datetime.fromtimestamp(int(stamp), ET)
        rows.append(
            {
                "t": int(stamp),
                "o": open_,
                "h": max(high, open_, close),
                "l": min(low, open_, close),
                "c": close,
                "date": when.date().isoformat(),
                "hm": when.strftime("%H:%M"),
            }
        )
    rows.sort(key=lambda row: row["t"])
    deduped = []
    for row in rows:
        if deduped and deduped[-1]["t"] == row["t"]:
            deduped[-1] = row
        else:
            deduped.append(row)
    return deduped


def complete_daily(rows: list[dict]) -> list[dict]:
    """Drop today's daily bar until 16:10 ET so a midday run is not treated as the close."""
    if not rows:
        return rows
    now = datetime.now(ET)
    last = datetime.fromtimestamp(rows[-1]["t"], ET)
    if last.date() == now.date() and (now.hour, now.minute) < (16, 10):
        return rows[:-1]
    return rows


def aggregate(rows: list[dict], mode: str) -> list[dict]:
    buckets: list[dict] = []
    current: dict | None = None
    for row in rows:
        key = row["date"][:7] if mode == "month" else row["date"][:4]
        if current is None or current["label"] != key:
            current = {
                "o": row["o"],
                "h": row["h"],
                "l": row["l"],
                "c": row["c"],
                "date": row["date"],
                "start": row["date"],
                "label": key,
            }
            buckets.append(current)
        else:
            current["h"] = max(current["h"], row["h"])
            current["l"] = min(current["l"], row["l"])
            current["c"] = row["c"]
            current["date"] = row["date"]
    return buckets


def rolling_sma(values: list[float], window: int) -> list[float | None]:
    points: list[float | None] = [None] * len(values)
    if window <= 0 or len(values) < window:
        return points
    total = sum(values[:window])
    points[window - 1] = total / window
    for index in range(window, len(values)):
        total += values[index] - values[index - window]
        points[index] = total / window
    return points


def stdev(values: list[float]) -> float | None:
    count = len(values)
    if count < 2:
        return None
    mean = sum(values) / count
    variance = sum((value - mean) ** 2 for value in values) / (count - 1)
    return variance ** 0.5


def lookback(closes: list[float], steps: int) -> float | None:
    if len(closes) < steps or closes[-steps] <= 0:
        return None
    return (closes[-1] / closes[-steps] - 1) * 100


def pack(rows: list[dict], ma50=None, ma200=None, date=None, first=None) -> dict:
    body = {
        "t": [row["label"] for row in rows],
        "o": [rnd(row["o"]) for row in rows],
        "h": [rnd(row["h"]) for row in rows],
        "l": [rnd(row["l"]) for row in rows],
        "c": [rnd(row["c"]) for row in rows],
    }
    if ma50 is not None and any(value is not None for value in ma50):
        body["ma50"] = [rnd(value) for value in ma50]
    if ma200 is not None and any(value is not None for value in ma200):
        body["ma200"] = [rnd(value) for value in ma200]
    if date:
        body["date"] = date
    if first:
        body["first"] = first
    return body


def label_rows(rows: list[dict], field: str) -> list[dict]:
    labeled = []
    for row in rows:
        item = dict(row)
        item["label"] = row[field]
        labeled.append(item)
    return labeled


def minute_session(rows: list[dict]) -> tuple[str, list[dict]] | None:
    by_date: dict[str, list[dict]] = {}
    for row in rows:
        when = datetime.fromtimestamp(row["t"], ET)
        minutes = when.hour * 60 + when.minute
        if minutes < 9 * 60 + 30 or minutes > 15 * 60 + 55:
            continue
        item = dict(row)
        item["label"] = when.strftime("%H:%M")
        item["date"] = when.date().isoformat()
        by_date.setdefault(item["date"], []).append(item)
    if not by_date:
        return None
    now = datetime.now(ET)
    today = now.date().isoformat()

    def rank(day: str) -> tuple:
        count = len(by_date[day])
        complete_enough = count >= 60
        if day == today and (now.hour, now.minute) < (16, 10):
            complete_enough = False
        return (complete_enough, count, day)

    best = max(by_date, key=rank)
    chosen = sorted(by_date[best], key=lambda row: row["t"])
    if len(chosen) < 10:
        return None
    return best, chosen


def should_rebuild_from_daily(daily: list[dict], monthly: list[dict]) -> bool:
    """New listings (SPCX) can have a gap in Yahoo's monthly series. Rebuild those from daily bars."""
    if not monthly:
        return bool(daily)
    if not daily:
        return False
    return daily[0]["date"][:7] < monthly[0]["date"][:7]


def build_symbol(sym: str, meta_name: str, kind: str) -> dict:
    daily_result = fetch_chart(sym, "interval=1d&range=2y")
    time.sleep(PAUSE)
    daily = complete_daily(rows_from_result(daily_result))
    if len(daily) < 2:
        raise RuntimeError(f"{sym} 日线不足")

    try:
        monthly_5y = rows_from_result(fetch_chart(sym, "interval=1mo&range=5y"))
    except Exception as exc:  # noqa: BLE001 — keep the daily series even if monthly fails
        print(f"  {sym} monthly 5y failed: {exc}", file=sys.stderr)
        monthly_5y = []
    time.sleep(PAUSE)

    try:
        monthly_max = rows_from_result(fetch_chart(sym, "interval=1mo&range=max"))
    except Exception as exc:  # noqa: BLE001
        print(f"  {sym} monthly max failed: {exc}", file=sys.stderr)
        monthly_max = []
    time.sleep(PAUSE)

    minute_rows = []
    try:
        minute_rows = rows_from_result(
            fetch_chart(sym, "interval=5m&range=5d&includePrePost=false")
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  {sym} minute failed: {exc}", file=sys.stderr)
    time.sleep(PAUSE)

    closes = [row["c"] for row in daily]
    ma50_full = rolling_sma(closes, 50)
    ma200_full = rolling_sma(closes, 200)
    view = daily[-60:]
    start = len(daily) - len(view)
    for row in view:
        row["label"] = row["date"]

    if should_rebuild_from_daily(daily, monthly_5y):
        monthly = aggregate(daily, "month")
    else:
        monthly = aggregate(monthly_5y, "month")
    monthly = monthly[-60:]

    if should_rebuild_from_daily(daily, monthly_max or monthly_5y):
        yearly_source = aggregate(daily, "month")
    else:
        yearly_source = aggregate(monthly_max or monthly_5y, "month")
    yearly = aggregate(yearly_source, "year")

    minute = minute_session(minute_rows)
    quote_meta = daily_result.get("meta") or {}
    last = closes[-1]
    prev = closes[-2]
    window = closes[-252:]
    peak = max(window)
    log_returns = []
    for index in range(1, len(closes)):
        if closes[index - 1] > 0 and closes[index] > 0:
            log_returns.append(__import__("math").log(closes[index] / closes[index - 1]))
    sample = log_returns[-20:]
    volatility = stdev(sample)
    hi52 = quote_meta.get("fiftyTwoWeekHigh")
    lo52 = quote_meta.get("fiftyTwoWeekLow")
    if not hi52:
        hi52 = max(row["h"] for row in daily[-252:])
    if not lo52:
        lo52 = min(row["l"] for row in daily[-252:])

    bars = {
        "d": pack(view, ma50_full[start:], ma200_full[start:]),
        "mo": pack(label_rows(monthly, "label")) if monthly else None,
        "y": pack(
            label_rows(yearly, "label"),
            first=(yearly[0].get("start") or yearly[0]["date"])[:7] if yearly else None,
        ) if yearly else None,
        "m": pack(minute[1], date=minute[0]) if minute else None,
    }
    return {
        "sym": sym,
        "name": meta_name,
        "kind": kind,
        "currency": quote_meta.get("currency") or "USD",
        "last": rnd(last),
        "prev": rnd(prev),
        "chgPct": rnd((last / prev - 1) * 100, 2),
        "date": daily[-1]["date"],
        "listedFrom": daily[0]["date"],
        "sessions": len(daily),
        "hi52": rnd(hi52),
        "lo52": rnd(lo52),
        "sma50": rnd(ma50_full[-1]),
        "sma200": rnd(ma200_full[-1]),
        "r1m": rnd(lookback(closes, 22), 2),
        "r3m": rnd(lookback(closes, 64), 2),
        "dd": rnd((last / peak - 1) * 100, 2) if peak else None,
        "ddSpan": len(window),
        "vol20": rnd(volatility * (252 ** 0.5) * 100, 2) if volatility is not None and len(sample) >= 10 else None,
        "missing": False,
        "bars": bars,
    }


def build_market_quote(item: dict) -> dict:
    result = fetch_chart(item["sym"], "interval=1d&range=1mo")
    time.sleep(PAUSE)
    rows = complete_daily(rows_from_result(result))
    if len(rows) < 1:
        raise RuntimeError(f"{item['sym']} 没有日线")
    last = rows[-1]["c"]
    prev = rows[-2]["c"] if len(rows) > 1 else None
    change = (last / prev - 1) * 100 if prev else None
    return {
        "id": item["id"],
        "sym": item["sym"],
        "name": item["name"],
        "last": rnd(last),
        "prev": rnd(prev),
        "chgPct": rnd(change, 2),
        "date": rows[-1]["date"],
        "missing": False,
    }


def load_old() -> dict:
    if not MARKET_PATH.exists():
        return {}
    try:
        return json.loads(MARKET_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print("existing market.json is unreadable; starting fresh", file=sys.stderr)
        return {}


def write_market(payload: dict) -> None:
    MARKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    temporary = MARKET_PATH.with_suffix(".json.tmp")
    temporary.write_text(text + "\n", encoding="utf-8")
    temporary.replace(MARKET_PATH)


def rome_close_label(session_iso: str | None) -> str | None:
    if not session_iso:
        return None
    year, month, day = (int(part) for part in session_iso.split("-"))
    close = datetime.combine(datetime(year, month, day).date(), dtime(16, 0), tzinfo=ET)
    return close.astimezone(ROME).strftime("%Y-%m-%d %H:%M")


def main() -> int:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    old = load_old()
    old_symbols = old.get("symbols") or {}
    old_market = old.get("market") or {}
    portfolio_before = sha256(PORTFOLIO_PATH)

    symbols: dict[str, dict] = {}
    errors: list[str] = []
    tickers = config.get("tickers") or []
    for index, ticker in enumerate(tickers, start=1):
        sym = ticker["sym"]
        print(f"[{index}/{len(tickers)}] {sym}", flush=True)
        try:
            symbols[sym] = build_symbol(sym, ticker.get("name") or sym, ticker.get("kind") or "")
            quote = symbols[sym]
            minute_count = len((quote["bars"].get("m") or {}).get("c") or [])
            print(
                f"  {quote['date']} last {quote['last']} chg {quote['chgPct']}% "
                f"d {len(quote['bars']['d']['c'])} mo {len((quote['bars'].get('mo') or {}).get('c') or [])} "
                f"y {len((quote['bars'].get('y') or {}).get('c') or [])} m {minute_count}",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 — one ticker must not abort the whole desk
            print(f"  FAIL {sym}: {exc}", file=sys.stderr)
            if sym in old_symbols and not old_symbols[sym].get("missing"):
                kept = dict(old_symbols[sym])
                kept["stale"] = True
                symbols[sym] = kept
                errors.append(f"{sym} 抓取失败，沿用上次数据")
            else:
                symbols[sym] = {
                    "sym": sym,
                    "name": ticker.get("name") or sym,
                    "kind": ticker.get("kind") or "",
                    "missing": True,
                    "error": str(exc),
                    "bars": {"d": None, "mo": None, "y": None, "m": None},
                }
                errors.append(f"{sym} 抓取失败，暂无数据")

    market: dict[str, dict] = {}
    for item in config.get("market") or []:
        key = item["id"]
        print(f"[market] {item['sym']}", flush=True)
        try:
            market[key] = build_market_quote(item)
            quote = market[key]
            print(f"  {quote['date']} last {quote['last']} chg {quote['chgPct']}%", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAIL {item['sym']}: {exc}", file=sys.stderr)
            if key in old_market and not old_market[key].get("missing"):
                kept = dict(old_market[key])
                kept["stale"] = True
                market[key] = kept
                errors.append(f"{item['name']} 抓取失败，沿用上次数据")
            else:
                market[key] = {
                    "id": key,
                    "sym": item["sym"],
                    "name": item["name"],
                    "missing": True,
                    "error": str(exc),
                }
                errors.append(f"{item['name']} 抓取失败，暂无数据")

    dates = [item.get("date") for item in symbols.values() if item.get("date")]
    session = max(dates) if dates else None
    now = datetime.now(ROME)
    status = "ok" if not errors else "partial"
    if symbols and all(item.get("missing") for item in symbols.values()):
        status = "failed"
    note = "行情为美股最近一个交易日的收盘价，不是实时。来源 Yahoo Finance，价格按拆股调整。月K和年K的最后一根还没走完。"
    if session:
        note += f" 收盘日 {session}。"
    note += f" 抓取于 {now.strftime('%Y-%m-%d %H:%M')}（罗马时间）。"
    if errors:
        note += " 有的代码这次没抓到，页面沿用上次成功的数据；完全没有旧数据的显示「暂无数据」。"

    payload = {
        "asOf": now.isoformat(timespec="seconds"),
        "asOfRome": now.strftime("%Y-%m-%d %H:%M"),
        "tz": "Europe/Rome",
        "sessionDate": session,
        "sessionCloseRome": rome_close_label(session),
        "source": "Yahoo Finance",
        "fetchStatus": status,
        "errors": errors,
        "note": note,
        "symbols": symbols,
        "market": market,
    }
    write_market(payload)
    portfolio_after = sha256(PORTFOLIO_PATH)
    if portfolio_before != portfolio_after:
        raise SystemExit("refusing to finish: data/portfolio.json was modified")
    print(f"wrote {MARKET_PATH} status={status} errors={len(errors)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
