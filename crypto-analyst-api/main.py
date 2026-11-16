import os, threading
from typing import Any
import numpy as np
import pandas as pd
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from google import genai

app = FastAPI(title="ORIGINVAULT Crypto Analyst API", version="0.1.0")
origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "*").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET","POST"], allow_headers=["*"])

class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0

class AnalysisRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=20, pattern=r"^[A-Z0-9]+$")
    interval: str
    mode: str = "gemini"
    indicators: dict[str, bool] = {}
    candles: list[Candle] = Field(min_length=60, max_length=512)

class ForecastRequest(BaseModel):
    symbol: str
    interval: str
    candles: list[Candle] = Field(min_length=60, max_length=512)
    horizon: int = Field(default=12, ge=1, le=48)
    paths: int = Field(default=5, ge=3, le=20)

_model_lock = threading.Lock()
_predictor = None
def get_predictor():
    global _predictor
    if os.getenv("KRONOS_ENABLED", "true").lower() not in ("1", "true", "yes"):
        raise HTTPException(503, "Kronos is disabled on the free lightweight deployment because its model runtime exceeds the available memory. Other API features remain available.")
    with _model_lock:
        if _predictor is None:
            import torch
            from model import Kronos, KronosTokenizer, KronosPredictor
            tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
            model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            _predictor = KronosPredictor(model, tokenizer, device=device, max_context=512)
        return _predictor

@app.get("/health")
def health():
    return {"ok": True, "service": "originvault-crypto-analyst", "kronos": "enabled" if os.getenv("KRONOS_ENABLED", "true").lower() in ("1", "true", "yes") else "disabled_on_free_plan", "gemini": bool(os.getenv("GEMINI_API_KEY")), "goplus": bool(os.getenv("GOPLUS_ACCESS_TOKEN"))}

@app.post("/analyze")
def analyze(req: AnalysisRequest):
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(503, "Gemini is not configured. Set GEMINI_API_KEY on the server.")
    c = pd.DataFrame([x.model_dump() for x in req.candles])
    close = c.close
    e20 = close.ewm(span=20).mean().iloc[-1]
    e50 = close.ewm(span=50).mean().iloc[-1]
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/14, adjust=False).mean().iloc[-1]
    loss = (-delta.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean().iloc[-1]
    rsi = 100 if loss == 0 else 100 - 100/(1+gain/loss)
    facts = {"symbol":req.symbol,"interval":req.interval,"last_close":float(close.iloc[-1]),"ema20":float(e20),"ema50":float(e50),"rsi14":float(rsi),"high_80":float(c.high.tail(80).max()),"low_80":float(c.low.tail(80).min()),"volume_last":float(c.volume.iloc[-1]),"selected_indicators":req.indicators}
    prompt = ("You are a cautious market-analysis assistant. Interpret only the supplied OHLCV-derived facts. "
              "Do not invent news, fundamentals, prices or certainty. Give bull/base/bear scenarios, key invalidation "
              "conditions, and explain uncertainty. No personalized financial advice or guaranteed entry/exit. "
              "Clearly label any levels as technical reference levels.\nDATA: " + str(facts))
    try:
        client = genai.Client(api_key=key)
        model_name = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
        response = client.models.generate_content(model=model_name, contents=prompt)
        return {"analysis": response.text or "Gemini returned an empty response.", "model": model_name, "facts": facts}
    except Exception as e:
        raise HTTPException(502, "Gemini request failed: " + str(e)[:300])

@app.get("/dex-candles/{symbol}/{interval}")
def dex_candles(symbol: str, interval: str, limit: int = 250):
    symbol = symbol.upper()
    if not symbol.isalnum() or len(symbol) > 20:
        raise HTTPException(400, "Invalid token symbol")
    interval_map = {
        "1m": ("minute", 1, 1), "5m": ("minute", 5, 1), "15m": ("minute", 15, 1),
        "30m": ("minute", 15, 2), "1h": ("hour", 1, 1), "2h": ("hour", 1, 2),
        "4h": ("hour", 4, 1), "1d": ("day", 1, 1), "1w": ("day", 1, 7)
    }
    if interval not in interval_map:
        raise HTTPException(400, "Unsupported DEX chart timeframe")
    timeframe, aggregate, combine = interval_map[interval]
    network_map = {"ethereum":"eth","bsc":"bsc","base":"base","polygon":"polygon_pos",
                   "arbitrum":"arbitrum","optimism":"optimism","avalanche":"avax","solana":"solana"}
    try:
        sr = requests.get("https://api.dexscreener.com/latest/dex/search", params={"q": symbol}, timeout=12)
        sr.raise_for_status()
        pairs = sr.json().get("pairs") or []
        matches = []
        for pair in pairs:
            base_match = (pair.get("baseToken",{}).get("symbol","").upper() == symbol)
            quote_match = (pair.get("quoteToken",{}).get("symbol","").upper() == symbol)
            if base_match or quote_match:
                liquidity = float((pair.get("liquidity") or {}).get("usd") or 0)
                matches.append((liquidity, pair, "base" if base_match else "quote"))
        if not matches:
            raise HTTPException(404, "No DEX pool found for this token symbol")
        matches.sort(key=lambda x:x[0], reverse=True)
        liquidity, pair, token_side = matches[0]
        network = network_map.get(pair.get("chainId"))
        if not network:
            raise HTTPException(422, "DEX pool network is not supported by GeckoTerminal")
        pool = pair.get("pairAddress")
        gr = requests.get(
            f"https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/{timeframe}",
            params={"aggregate":aggregate,"limit":min(1000, max(60, limit*combine)),"currency":"usd","token":token_side},
            headers={"Accept":"application/json;version=20230203"}, timeout=20
        )
        gr.raise_for_status()
        raw = ((gr.json().get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
        bars = sorted(raw, key=lambda x:x[0])
        if combine > 1:
            grouped=[]
            for i in range(0, len(bars), combine):
                chunk=bars[i:i+combine]
                if len(chunk) != combine:
                    continue
                grouped.append([chunk[0][0],chunk[0][1],max(x[2] for x in chunk),min(x[3] for x in chunk),chunk[-1][4],sum(x[5] for x in chunk)])
            bars=grouped
        bars=bars[-min(500,max(60,limit)):]
        if len(bars)<30:
            raise HTTPException(404, "Not enough DEX OHLCV history for this pool")
        candles=[{"time":int(x[0])*1000,"open":float(x[1]),"high":float(x[2]),"low":float(x[3]),"close":float(x[4]),"volume":float(x[5])} for x in bars]
        return {"symbol":symbol,"source":"GeckoTerminal DEX OHLCV","network":network,"dex":pair.get("dexId"),
                "pairAddress":pool,"pairUrl":pair.get("url"),"liquidityUsd":liquidity,
                "volume24h":float((pair.get("volume") or {}).get("h24") or 0),"candles":candles,
                "volumeUnit":"USD","warning":"DEX pool selection uses symbol matching and highest reported liquidity. Verify token contract and pool address before relying on this market."}
    except HTTPException:
        raise
    except requests.RequestException as e:
        raise HTTPException(502, "DEX candle source unavailable: " + str(e)[:180])

@app.get("/marketdata/{symbol}")
def marketdata(symbol: str):
    symbol = symbol.upper()
    if not symbol.isalnum() or len(symbol) > 20:
        raise HTTPException(400, "Invalid market symbol")
    base = "https://data-api.binance.vision/api/v3"
    try:
        ticker_r = requests.get(base + "/ticker/24hr", params={"symbol": symbol}, timeout=12)
        ticker_r.raise_for_status()
        ticker = ticker_r.json()
        depth_r = requests.get(base + "/depth", params={"symbol": symbol, "limit": 20}, timeout=12)
        depth_r.raise_for_status()
        depth = depth_r.json()
        bids = [(float(p), float(q)) for p, q in depth.get("bids", [])]
        asks = [(float(p), float(q)) for p, q in depth.get("asks", [])]
        bid_usd = sum(p*q for p, q in bids)
        ask_usd = sum(p*q for p, q in asks)
        best_bid = bids[0][0] if bids else 0
        best_ask = asks[0][0] if asks else 0
        mid = (best_bid + best_ask)/2 if best_bid and best_ask else 0
        spread = ((best_ask-best_bid)/mid*100) if mid else None
        total_depth = bid_usd + ask_usd
        imbalance = bid_usd/total_depth if total_depth else None
    except requests.RequestException as e:
        raise HTTPException(502, "Binance market depth unavailable: " + str(e)[:180])
    dex_pair = None
    dex_liq = None
    dex_pair_address = None
    dex_url = None
    dex_volume24h = None
    try:
        q = symbol[:-4] if symbol.endswith("USDT") else symbol
        dex_r = requests.get("https://api.dexscreener.com/latest/dex/search", params={"q": q}, timeout=12)
        dex_r.raise_for_status()
        pairs = dex_r.json().get("pairs") or []
        exact = [p for p in pairs if (p.get("baseToken",{}).get("symbol","").upper() == q or p.get("quoteToken",{}).get("symbol","").upper() == q)]
        exact.sort(key=lambda p: float((p.get("liquidity") or {}).get("usd") or 0), reverse=True)
        if exact:
            chosen = exact[0]
            dex_pair = chosen.get("chainId","?") + " / " + chosen.get("dexId","?") + " / " + str(chosen.get("baseToken",{}).get("symbol","")) + "-" + str(chosen.get("quoteToken",{}).get("symbol",""))
            dex_liq = (chosen.get("liquidity") or {}).get("usd")
            dex_pair_address = chosen.get("pairAddress")
            dex_url = chosen.get("url")
            dex_volume24h = (chosen.get("volume") or {}).get("h24")
    except Exception:
        pass
    return {
        "symbol": symbol, "exchange": "Binance Spot", "volume24h": float(ticker.get("quoteVolume") or 0),
        "spreadPct": spread, "imbalance": imbalance, "bidDepthUsd": bid_usd, "askDepthUsd": ask_usd,
        "dexPair": dex_pair, "dexPairAddress": dex_pair_address, "dexUrl": dex_url, "dexVolume24h": dex_volume24h, "dexLiquidityUsd": dex_liq,
        "depthLevels": 20, "note": "Order-book depth is a snapshot and can change rapidly."
    }

# Successful Futures snapshots are cached briefly to avoid repeated upstream calls.
_derivatives_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_derivatives_cooldown: dict[str, float] = {}

@app.get("/derivatives/{symbol}")
def derivatives(symbol: str):
    import time
    from email.utils import parsedate_to_datetime
    symbol = symbol.upper()
    if not symbol.isalnum() or len(symbol) > 20:
        raise HTTPException(400, "Invalid derivatives symbol")
    now = time.time()
    cached = _derivatives_cache.get(symbol)
    if cached and now - cached[0] < 30:
        return {**cached[1], "cached": True}
    blocked_until = _derivatives_cooldown.get(symbol, 0)
    if now < blocked_until:
        return {"available": False, "symbol": symbol, "rateLimited": True,
                "retryAfterSeconds": max(1, int(blocked_until-now)),
                "error": "Binance rate limit cooldown is active; wait before retrying.",
                "markPrice": None, "indexPrice": None, "openInterest": None,
                "fundingRate": None, "longLiquidationsUsd": None, "shortLiquidationsUsd": None}
    base = "https://fapi.binance.com/fapi/v1"
    try:
        premium = requests.get(base + "/premiumIndex", params={"symbol": symbol}, timeout=10)
        premium.raise_for_status()
        p = premium.json()
        oi = requests.get(base + "/openInterest", params={"symbol": symbol}, timeout=10)
        oi.raise_for_status()
        interest = oi.json()
        funding = requests.get(base + "/fundingRate", params={"symbol": symbol, "limit": 1}, timeout=10)
        funding.raise_for_status()
        fdata = funding.json()
        # Public REST liquidation history is not available via allForceOrders.
        result = {"available": True, "symbol": symbol, "markPrice": float(p.get("markPrice") or 0),
                  "indexPrice": float(p.get("indexPrice") or 0), "openInterest": float(interest.get("openInterest") or 0),
                  "fundingRate": float(fdata[-1].get("fundingRate")) if fdata else None,
                  "longLiquidationsUsd": None, "shortLiquidationsUsd": None,
                  "liquidationDataAvailable": False,
                  "note": "Mark price, index price, open interest and funding rate are public Futures REST data. Public REST liquidation history requires the public forceOrder WebSocket stream."}
        _derivatives_cache[symbol] = (time.time(), result)
        _derivatives_cooldown.pop(symbol, None)
        return result
    except requests.RequestException as e:
        response = getattr(e, "response", None)
        if response is not None and response.status_code == 429:
            retry = response.headers.get("Retry-After", "60")
            try:
                wait_seconds = max(30, min(900, int(float(retry))))
            except (TypeError, ValueError):
                wait_seconds = 60
            _derivatives_cooldown[symbol] = time.time() + wait_seconds
            return {"available": False, "symbol": symbol, "rateLimited": True,
                    "retryAfterSeconds": wait_seconds,
                    "error": "Binance returned HTTP 429. Requests are paused to respect its rate limit.",
                    "markPrice": None, "indexPrice": None, "openInterest": None,
                    "fundingRate": None, "longLiquidationsUsd": None, "shortLiquidationsUsd": None}
        return {"available": False, "symbol": symbol, "error": str(e)[:160],
                "markPrice": None, "indexPrice": None, "openInterest": None,
                "fundingRate": None, "longLiquidationsUsd": None, "shortLiquidationsUsd": None}

@app.get("/token-risk/{chain_id}/{address}")
def token_risk(chain_id: int, address: str):
    supported = {1, 56, 8453, 137, 42161, 10, 43114}
    if chain_id not in supported:
        raise HTTPException(400, "Unsupported EVM chain")
    if not (address.startswith("0x") and len(address) == 42):
        raise HTTPException(400, "Invalid EVM contract address")
    goplus_token = os.getenv("GOPLUS_ACCESS_TOKEN")
    if not goplus_token:
        raise HTTPException(503, "GoPlus security is not configured. Set GOPLUS_ACCESS_TOKEN on the server.")
    try:
        r = requests.get(
            f"https://api.gopluslabs.io/api/v1/token_security/{chain_id}",
            params={"contract_addresses": address.lower()},
            headers={"Authorization": "Bearer " + goplus_token},
            timeout=15
        )
        r.raise_for_status()
        payload = r.json()
        token = (payload.get("result") or {}).get(address.lower()) or (payload.get("result") or {}).get(address)
        if not token:
            raise HTTPException(404, "GoPlus returned no token security record for this contract")
        def flag(key):
            value = token.get(key)
            if value in (None, ""):
                return "Unknown"
            return "Yes / flagged" if str(value) == "1" else "No flag reported"
        def yes_no(key):
            value = token.get(key)
            if value in (None, ""):
                return "Unknown"
            return "Yes" if str(value) == "1" else "No"
        checks = {
            "Honeypot flag": flag("is_honeypot"),
            "Buy tax": token.get("buy_tax", "Unknown"),
            "Sell tax": token.get("sell_tax", "Unknown"),
            "Mintable": flag("is_mintable"),
            "Proxy contract": flag("is_proxy"),
            "Owner can change balance": flag("owner_change_balance"),
            "Cannot sell all": flag("cannot_sell_all"),
            "Trading cooldown": flag("trading_cooldown"),
            "Open source": yes_no("is_open_source"),
            "Can pause transfers": flag("transfer_pausable"),
            "Can blacklist wallets": flag("is_blacklisted"),
            "Hidden owner": flag("hidden_owner"),
            "Ownership reclaim": flag("can_take_back_ownership"),
            "Owner token share": token.get("owner_percent", "Unknown"),
            "Contract in DEX": yes_no("is_in_dex"),
            "Other reported risks": token.get("other_potential_risks") or "None reported",
            "Owner address": token.get("owner_address") or "Unknown",
            "Holder count": token.get("holder_count") or "Unknown",
            "Top 10 holder concentration": f"{100*sum(float(h.get('percent') or 0) for h in token.get('holders', [])[:10]):.2f}%" if isinstance(token.get("holders"), list) else "Unknown",
            "LP locked share (reported)": f"{100*sum(float(h.get('percent') or 0) for h in token.get('lp_holders', []) if str(h.get('is_locked')) == '1'):.2f}%" if isinstance(token.get("lp_holders"), list) else "Unknown"
        }
        return {"chainId": chain_id, "address": address, "checks": checks, "source": "GoPlus Token Security API", "warning": "Automated flags are incomplete and can be stale or evaded. This is not an audit or proof of safety."}
    except HTTPException:
        raise
    except requests.RequestException as e:
        raise HTTPException(502, "GoPlus risk lookup unavailable: " + str(e)[:180])

@app.post("/forecast")
def forecast(req: ForecastRequest):
    try:
        predictor = get_predictor()
        df = pd.DataFrame([x.model_dump() for x in req.candles])
        x_df = df[["open","high","low","close","volume"]].copy()
        x_ts = pd.to_datetime(df["time"], unit="ms")
        interval_map = {"1m":"1min","5m":"5min","15m":"15min","30m":"30min","1h":"1h","2h":"2h","4h":"4h","1d":"1D","1w":"7D"}
        freq = interval_map.get(req.interval)
        if not freq:
            raise HTTPException(400, "Unsupported interval")
        last_ts = x_ts.iloc[-1]
        y_ts = pd.date_range(start=last_ts, periods=req.horizon+1, freq=freq)[1:]
        closes=[]
        for _ in range(req.paths):
            pred = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=req.horizon, T=1.0, top_p=0.9, sample_count=1)
            closes.append(np.asarray(pred["close"], dtype=float))
        arr=np.stack(closes)
        return {"p10":np.percentile(arr,10,axis=0).tolist(),"p50":np.percentile(arr,50,axis=0).tolist(),"p90":np.percentile(arr,90,axis=0).tolist(),"paths":req.paths,"horizon":req.horizon,"note":"P10–P90 is the range between sampled model paths, not an 80% calibrated real-world confidence interval.","model":"NeoQuasar/Kronos-small"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, "Kronos inference failed: " + str(e)[:300])
