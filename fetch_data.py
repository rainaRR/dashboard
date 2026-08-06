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


import signal
from contextlib import contextmanager


class Timeout(Exception):
    pass


@contextmanager
def limit(seconds, what):
    """정해진 시간 안에 안 끝나면 포기합니다.
    응답 없는 서버를 무한정 기다리다 전체가 멈추는 걸 막습니다."""
    def handler(signum, frame):
        raise Timeout(f"{what}: {seconds}초 초과")
    old = signal.signal(signal.SIGALRM, handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)


log = []
def note(msg):
    print(msg, flush=True)
    log.append(msg)


def pct(now, before):
    if before in (None, 0):
        return None
    return round((now / before - 1) * 100, 2)



def hi_lo(close):
    """52주(약 250거래일) 전고점·전저점과, 지금이 거기서 얼마나 떨어져 있는지."""
    yr = close.tail(250)
    if len(yr) < 5:
        return {}
    price = float(yr.iloc[-1])
    hi, lo = float(yr.max()), float(yr.min())
    return {
        "lo": round(lo, 2), "hi": round(hi, 2),
        "hiDate": str(yr.idxmax().date()), "loDate": str(yr.idxmin().date()),
        "fromHi": round((price / hi - 1) * 100, 2),   # 전고점 대비 (보통 음수)
        "fromLo": round((price / lo - 1) * 100, 2),   # 전저점 대비 (보통 양수)
    }


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
            row = {
                "nm": name, "price": round(price, 2),
                "change": round(price - prev, 2), "rate": pct(price, prev),
                "src": "FinanceDataReader",
                "asOf": str(df.index[-1].date()),
            }
            row.update(hi_lo(close))
            out.append(row)
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
            row = {
                "nm": name, "price": round(price, 2),
                "change": round(price - prev, 2), "rate": pct(price, prev),
                "ma200": round(float(close.tail(200).mean()), 2),
                "src": "Yahoo Finance",
                "asOf": str(close.index[-1].date()),
            }
            row.update(hi_lo(close))
            out.append(row)
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
            with limit(12, f"{name} 조회"):
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



def fetch_history():
    """차트용 지수 1년치. 코스피·코스닥 종가만 모읍니다."""
    import FinanceDataReader as fdr
    start = (datetime.datetime.now(KST) - datetime.timedelta(days=400)).strftime("%Y-%m-%d")
    out = {}
    for code, name in KR_INDEX:
        try:
            with limit(40, f"{name} 히스토리"):
                df = fdr.DataReader(code, start)
            close = df["Close"].dropna().tail(260)
            out[name] = {
                "d": [str(i.date()) for i in close.index],
                "v": [round(float(v), 2) for v in close.values],
            }
            note(f"[히스토리] {name} {len(close)}일")
        except Exception as e:
            note(f"[실패] {name} 히스토리: {type(e).__name__}")
    return out


def fetch_investor():
    """외국인·기관·개인 매매동향. pykrx가 필요합니다.
    이 부분이 실패해도 나머지 화면은 정상 동작합니다."""
    try:
        from pykrx import stock as krx
    except ImportError:
        note("[건너뜀] pykrx가 설치되지 않았습니다")
        return None

    today = datetime.datetime.now(KST)
    end = today.strftime("%Y%m%d")
    begin = (today - datetime.timedelta(days=40)).strftime("%Y%m%d")
    out = {}
    for market in ("KOSPI", "KOSDAQ"):
        try:
            with limit(45, f"{market} 투자자별 매매"):
                df = krx.get_market_trading_value_by_date(begin, end, market)
            if df is None or df.empty:
                note(f"[건너뜀] {market} 투자자별 매매: 데이터 없음")
                continue
            df = df.tail(20)
            cols = {c: c for c in df.columns}
            def pick(*names):
                for n in names:
                    if n in cols:
                        return n
                return None
            c_for = pick("외국인합계", "외국인")
            c_ins = pick("기관합계", "기관")
            c_ind = pick("개인")
            if not (c_for and c_ins and c_ind):
                note(f"[건너뜀] {market}: 컬럼 이름을 찾지 못했습니다 {list(df.columns)}")
                continue
            # 억원 단위로 환산해서 보기 쉽게
            out[market] = {
                "d": [str(i.date()) if hasattr(i, "date") else str(i) for i in df.index],
                "foreign": [round(float(v) / 1e8) for v in df[c_for].values],
                "inst":    [round(float(v) / 1e8) for v in df[c_ins].values],
                "indiv":   [round(float(v) / 1e8) for v in df[c_ind].values],
            }
            note(f"[투자자] {market} {len(df)}일")
        except Exception as e:
            note(f"[실패] {market} 투자자별 매매: {type(e).__name__} {str(e)[:80]}")
    return out or None



CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"


def fetch_cnn_fng():
    """CNN 공포·탐욕지수 원본을 가져옵니다.
    CNN이 자기 웹페이지에 쓰는 공개 주소입니다. 문서화된 API가 아니라
    언제든 막히거나 형태가 바뀔 수 있습니다. 실패해도 나머지는 정상 동작합니다."""
    import urllib.request, json as _json
    req = urllib.request.Request(CNN_URL, headers={
        # 브라우저인 척해야 응답합니다
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://edition.cnn.com/markets/fear-and-greed",
    })
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read().decode("utf-8", "replace")

    # 응답이 커서 통째로 파싱하면 무거우므로 필요한 부분만 떼어냅니다
    m = re.search(r'"fear_and_greed":\s*(\{.*?\})', raw)
    if not m:
        raise ValueError("응답에서 지수를 찾지 못했습니다")
    fg = _json.loads(m.group(1))

    KOR = {"extreme fear": "극단적 공포", "fear": "공포", "neutral": "중립",
           "greed": "탐욕", "extreme greed": "극단적 탐욕"}
    out = {
        "score": round(float(fg["score"]), 1),
        "rating": fg.get("rating", ""),
        "label": KOR.get(fg.get("rating", ""), fg.get("rating", "")),
        "asOf": str(fg.get("timestamp", ""))[:10],
        "prev": {
            "전일":   round(float(fg["previous_close"]), 1),
            "1주 전": round(float(fg["previous_1_week"]), 1),
            "1개월 전": round(float(fg["previous_1_month"]), 1),
            "1년 전": round(float(fg["previous_1_year"]), 1),
        },
        "src": "CNN",
    }

    # 최근 3개월 흐름 (그래프용)
    pairs = re.findall(r'\{"x":\s*([\d.]+),\s*"y":\s*([\d.]+)', raw)
    hist = [[int(float(x) / 1000), round(float(y), 1)] for x, y in pairs]
    hist.sort(key=lambda r: r[0])          # 오래된 것부터
    if hist:
        out["hist"] = hist[-90:]           # 최근 90일치만

    note(f"[성공] CNN 공포탐욕지수 {out['score']} ({out['label']})")
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

    def guarded(fn, seconds, what, default):
        try:
            with limit(seconds, what):
                return fn()
        except Timeout as e:
            note(f"[시간초과] {e}")
        except Exception as e:
            note(f"[실패] {what}: {type(e).__name__} {str(e)[:80]}")
        return default

    kr      = guarded(fetch_kr_indices, 90,  "국내 지수", [])
    us_vix  = guarded(fetch_us_indices, 120, "해외 지수", ([], None))
    us, vix = us_vix if isinstance(us_vix, tuple) else ([], None)
    stocks  = guarded(fetch_stocks,     240, "종목 시세", {})
    history = guarded(fetch_history,    120, "차트 히스토리", {})
    investor= guarded(fetch_investor,   120, "투자자별 매매", None)
    cnn     = guarded(fetch_cnn_fng,     40, "CNN 공포탐욕지수", None)

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
    if not history and prev.get("history"):
        history = prev["history"]
        note("[대체] 차트 히스토리는 지난번 값을 유지합니다")
    if not investor and prev.get("investor"):
        investor = prev["investor"]
        note("[대체] 투자자별 매매는 지난번 값을 유지합니다")
    if not cnn and prev.get("cnn"):
        cnn = prev["cnn"]
        note("[대체] CNN 지수는 지난번 값을 유지합니다")

    data = {
        "asOf": datetime.datetime.now(KST).isoformat(timespec="seconds"),
        "indices": kr + us,
        "cnn": cnn,
        "gauge": gauge(vix, us),
        "stocks": stocks,
        "history": history,
        "investor": investor,
        "log": log,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"[완료] 저장 · 지수 {len(data['indices'])}개 · 종목 {len(stocks)}개 · "
         f"차트 {len(history or {})}개 · 투자자 {len(investor or {})}개 · "
         f"CNN {'있음' if cnn else '없음'}")

    if not data["indices"]:
        note("[경고] 지수를 하나도 못 가져왔습니다")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
