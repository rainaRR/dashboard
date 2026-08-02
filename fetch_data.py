# -*- coding: utf-8 -*-
"""
시세를 긁어서 data/market.json 으로 저장합니다.
깃허브 서버(GitHub Actions)가 평일마다 자동으로 실행합니다.
컴퓨터를 켜둘 필요가 없습니다.
"""
import json, os, sys, datetime, traceback

KST = datetime.timezone(datetime.timedelta(hours=9))
OUT = os.path.join(os.path.dirname(__file__), "data", "market.json")

# ── 무엇을 가져올지 ──────────────────────────────────────────
KR_INDEX = [("KS11", "KOSPI"), ("KQ11", "KOSDAQ")]
US_INDEX = [("^GSPC", "S&P 500"), ("^IXIC", "NASDAQ"), ("^DJI", "DOW")]

# 신문 브리핑에 나온 종목들. 바꾸고 싶으면 이 목록만 고치면 됩니다.
STOCKS = {
    "005930": "삼성전자",   "000660": "SK하이닉스",  "009150": "삼성전기",
    "011070": "LG이노텍",   "036930": "주성엔지니어링", "039030": "이오테크닉스",
    "067310": "하나마이크론", "059090": "미코",       "373220": "LG에너지솔루션",
    "006400": "삼성SDI",    "005490": "포스코홀딩스", "003670": "포스코퓨처엠",
    "047050": "포스코인터내셔널", "009540": "HD한국조선해양", "042660": "한화오션",
    "012450": "한화에어로스페이스", "272210": "한화시스템", "010140": "삼성중공업",
    "010950": "S-Oil",      "096770": "SK이노베이션", "028260": "삼성물산",
    "000720": "현대건설",   "006360": "GS건설",      "298040": "효성중공업",
    "005960": "동부건설",
}

log = []
def note(msg):
    print(msg, flush=True)
    log.append(msg)


def pct(now, before):
    if before in (None, 0):
        return None
    return round((now / before - 1) * 100, 2)


def fetch_kr_indices():
    """코스피·코스닥. FinanceDataReader 사용."""
    import FinanceDataReader as fdr
    out = []
    start = (datetime.datetime.now(KST) - datetime.timedelta(days=400)).strftime("%Y-%m-%d")
    for code, name in KR_INDEX:
        try:
            df = fdr.DataReader(code, start)
            if df.empty:
                note(f"[건너뜀] {name}: 데이터 없음")
                continue
            close = df["Close"].dropna()
            price, prev = float(close.iloc[-1]), float(close.iloc[-2])
            yr = close.tail(250)
            out.append({
                "nm": name, "price": round(price, 2),
                "change": round(price - prev, 2), "rate": pct(price, prev),
                "lo": round(float(yr.min()), 2), "hi": round(float(yr.max()), 2),
                "src": "FinanceDataReader",
                "asOf": str(df.index[-1].date()),
            })
            note(f"[성공] {name} {price:,.2f}")
        except Exception as e:
            note(f"[실패] {name}: {type(e).__name__} {e}")
    return out


def fetch_us_indices():
    """미국 지수 + VIX 공포지수. yfinance 사용."""
    import yfinance as yf
    out, vix = [], None
    for tk, name in US_INDEX + [("^VIX", "VIX")]:
        try:
            h = yf.Ticker(tk).history(period="1y")
            if h.empty:
                note(f"[건너뜀] {name}: 데이터 없음")
                continue
            close = h["Close"].dropna()
            price, prev = float(close.iloc[-1]), float(close.iloc[-2])
            if name == "VIX":
                vix = {"price": round(price, 2),
                       "ma200": round(float(close.tail(200).mean()), 2)}
                note(f"[성공] VIX {price:.2f}")
                continue
            out.append({
                "nm": name, "price": round(price, 2),
                "change": round(price - prev, 2), "rate": pct(price, prev),
                "lo": round(float(close.min()), 2), "hi": round(float(close.max()), 2),
                "ma200": round(float(close.tail(200).mean()), 2),
                "src": "Yahoo Finance",
                "asOf": str(close.index[-1].date()),
            })
            note(f"[성공] {name} {price:,.2f}")
        except Exception as e:
            note(f"[실패] {name}: {type(e).__name__} {e}")
    return out, vix


def fetch_stocks():
    """개별 종목 시세."""
    import FinanceDataReader as fdr
    start = (datetime.datetime.now(KST) - datetime.timedelta(days=20)).strftime("%Y-%m-%d")
    out = {}
    for code, name in STOCKS.items():
        try:
            df = fdr.DataReader(code, start)
            if df.empty or len(df) < 2:
                note(f"[건너뜀] {name}({code}): 데이터 부족")
                continue
            close = df["Close"].dropna()
            price, prev = float(close.iloc[-1]), float(close.iloc[-2])
            out[code] = {"name": name, "price": int(round(price)), "rate": pct(price, prev)}
        except Exception as e:
            note(f"[실패] {name}({code}): {type(e).__name__}")
    note(f"[종목] {len(out)} / {len(STOCKS)} 건 수집")
    return out


def gauge(vix, us, kr_breadth=None):
    """공포·탐욕 게이지. 0=극단적 공포, 100=극단적 탐욕."""
    def clamp(v):
        return max(0.0, min(100.0, v))
    parts, detail = [], []
    if vix:
        f = clamp((32 - vix["price"]) / 20 * 100)
        parts.append(f); detail.append(["시장 변동성 (VIX)", round(f, 1), f'{vix["price"]:.2f}'])
    sp = next((x for x in us if x["nm"] == "S&P 500" and x.get("ma200")), None)
    if sp:
        mom = (sp["price"] / sp["ma200"] - 1) * 100
        f = clamp((mom + 5) / 15 * 100)
        parts.append(f); detail.append(["S&P 모멘텀 (200일선)", round(f, 1), f'{mom:+.1f}%'])
    if not parts:
        return None
    return {"score": round(sum(parts) / len(parts)), "detail": detail}


def main():
    prev = {}
    if os.path.exists(OUT):
        try:
            prev = json.load(open(OUT, encoding="utf-8"))
        except Exception:
            pass

    kr = fetch_kr_indices()
    us, vix = fetch_us_indices()
    stocks = fetch_stocks()

    # 하나라도 실패하면 지난번 값을 그대로 둡니다. 빈 화면을 보여주지 않기 위해서입니다.
    if not kr and prev.get("indices"):
        kr = [x for x in prev["indices"] if x["nm"] in ("KOSPI", "KOSDAQ")]
        note("[대체] 국내 지수는 지난번 값을 유지합니다")
    if not us and prev.get("indices"):
        us = [x for x in prev["indices"] if x["nm"] not in ("KOSPI", "KOSDAQ")]
        note("[대체] 해외 지수는 지난번 값을 유지합니다")
    if not stocks and prev.get("stocks"):
        stocks = prev["stocks"]
        note("[대체] 종목 시세는 지난번 값을 유지합니다")

    data = {
        "asOf": datetime.datetime.now(KST).isoformat(timespec="seconds"),
        "indices": kr + us,
        "gauge": gauge(vix, us),
        "stocks": stocks,
        "log": log,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"[완료] {OUT} 저장 · 지수 {len(data['indices'])}개 · 종목 {len(stocks)}개")

    if not data["indices"]:
        note("[경고] 지수를 하나도 못 가져왔습니다")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
