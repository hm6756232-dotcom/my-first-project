import os, threading
from typing import Any
import numpy as np
import pandas as pd
import requests
from fastapi import FastAPI, HTTPException, Request
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

# Public multi-exchange derivatives aggregation. Short cache protects upstream rate limits.
_derivatives_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_derivatives_cooldown: dict[str, float] = {}

def _get_json(url: str, params: dict | None = None, timeout: int = 8):
    response = requests.get(url, params=params, timeout=timeout, headers={"User-Agent":"ORIGINVAULT-CryptoAnalyst/1.0"})
    response.raise_for_status()
    return response.json()

def _number(value):
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None

def _binance_derivatives(symbol: str):
    root = "https://fapi.binance.com"
    out = {"exchange":"Binance USD-M","status":"unavailable","openInterestUsd":None,"fundingRate":None,
           "longRatio":None,"shortRatio":None,"markPrice":None,"indexPrice":None,"timestamp":None,"error":None}
    try:
        p = _get_json(root + "/fapi/v1/premiumIndex", {"symbol":symbol})
        oi = _get_json(root + "/fapi/v1/openInterest", {"symbol":symbol})
        funding = _get_json(root + "/fapi/v1/fundingRate", {"symbol":symbol,"limit":1})
        out.update(status="ok", markPrice=_number(p.get("markPrice")), indexPrice=_number(p.get("indexPrice")),
                   fundingRate=_number(p.get("lastFundingRate")) if p.get("lastFundingRate") is not None else (_number(funding[-1].get("fundingRate")) if funding else None),
                   openInterestUsd=(_number(oi.get("openInterest")) or 0) * (_number(p.get("markPrice")) or 0),
                   timestamp=p.get("time") or oi.get("time"))
        try:
            ratio = _get_json(root + "/futures/data/globalLongShortAccountRatio", {"symbol":symbol,"period":"1h","limit":1})
            if ratio:
                out["longRatio"] = _number(ratio[-1].get("longAccount"))
                out["shortRatio"] = _number(ratio[-1].get("shortAccount"))
        except Exception as e:
            out["ratioNote"] = "Long/short ratio unavailable: " + str(e)[:100]
    except Exception as e:
        out["error"] = str(e)[:180]
    return out

def _bybit_derivatives(symbol: str):
    root = "https://api.bybit.com/v5/market"
    out = {"exchange":"Bybit Linear","status":"unavailable","openInterestUsd":None,"fundingRate":None,
           "longRatio":None,"shortRatio":None,"markPrice":None,"indexPrice":None,"timestamp":None,"error":None}
    try:
        ticker = _get_json(root + "/tickers", {"category":"linear","symbol":symbol})
        rows = ((ticker.get("result") or {}).get("list") or [])
        if not rows:
            raise ValueError("No Bybit linear perpetual for this symbol")
        t = rows[0]
        oi_value = _number(t.get("openInterestValue"))
        if oi_value is None:
            oi_value = (_number(t.get("openInterest")) or 0) * (_number(t.get("markPrice")) or 0)
        out.update(status="ok", openInterestUsd=oi_value, fundingRate=_number(t.get("fundingRate")),
                   markPrice=_number(t.get("markPrice")), indexPrice=_number(t.get("indexPrice")),
                   timestamp=int(__import__("time").time()*1000))
        try:
            ratio = _get_json(root + "/account-ratio", {"category":"linear","symbol":symbol,"period":"1h","limit":1})
            rrows = ((ratio.get("result") or {}).get("list") or [])
            if rrows:
                out["longRatio"] = _number(rrows[0].get("buyRatio"))
                out["shortRatio"] = _number(rrows[0].get("sellRatio"))
        except Exception as e:
            out["ratioNote"] = "Long/short ratio unavailable: " + str(e)[:100]
    except Exception as e:
        out["error"] = str(e)[:180]
    return out

def _okx_derivatives(symbol: str):
    root = "https://www.okx.com/api/v5/public"
    out = {"exchange":"OKX SWAP","status":"unavailable","openInterestUsd":None,"fundingRate":None,
           "longRatio":None,"shortRatio":None,"markPrice":None,"indexPrice":None,"timestamp":None,"error":None}
    base = symbol[:-4] if symbol.endswith(("USDT","USDC","BUSD")) else symbol[:-3] if symbol.endswith("USD") else symbol
    inst = base + "-USDT-SWAP"
    try:
        oi = _get_json(root + "/open-interest", {"instType":"SWAP","instId":inst})
        oirows = oi.get("data") or []
        funding = _get_json(root + "/funding-rate", {"instId":inst})
        frows = funding.get("data") or []
        if not oirows and not frows:
            raise ValueError("No OKX swap market for this symbol")
        o = oirows[0] if oirows else {}
        f = frows[0] if frows else {}
        oi_usd = _number(o.get("oiUsd"))
        if oi_usd is None:
            oi_usd = _number(o.get("oi"))
        out.update(status="ok", openInterestUsd=oi_usd, fundingRate=_number(f.get("fundingRate")),
                   timestamp=_number(o.get("ts") or f.get("fundingTime")))
    except Exception as e:
        out["error"] = str(e)[:180]
    return out

@app.get("/derivatives/{symbol}")
def derivatives(symbol: str):
    import time
    symbol = symbol.upper()
    if not symbol.isalnum() or len(symbol) > 20:
        raise HTTPException(400, "Invalid derivatives symbol")
    now = time.time()
    cached = _derivatives_cache.get(symbol)
    if cached and now - cached[0] < 30:
        return {**cached[1], "cached": True}
    # Query sources independently: one exchange failure must not hide the others.
    sources = [_binance_derivatives(symbol), _bybit_derivatives(symbol), _okx_derivatives(symbol)]
    active = [x for x in sources if x["status"] == "ok"]
    oi_values = [x["openInterestUsd"] for x in active if x.get("openInterestUsd") is not None]
    funding_values = [x["fundingRate"] for x in active if x.get("fundingRate") is not None]
    long_values = [x["longRatio"] for x in active if x.get("longRatio") is not None]
    short_values = [x["shortRatio"] for x in active if x.get("shortRatio") is not None]
    result = {
        "available": bool(active), "symbol": symbol, "sources": sources,
        "exchangesAvailable": len(active), "exchangesChecked": len(sources),
        "openInterestUsd": sum(oi_values) if oi_values else None,
        "averageFundingRate": sum(funding_values)/len(funding_values) if funding_values else None,
        "averageLongRatio": sum(long_values)/len(long_values) if long_values else None,
        "averageShortRatio": sum(short_values)/len(short_values) if short_values else None,
        "markPrice": next((x["markPrice"] for x in active if x.get("markPrice") is not None), None),
        "indexPrice": next((x["indexPrice"] for x in active if x.get("indexPrice") is not None), None),
        "fundingRate": next((x["fundingRate"] for x in active if x.get("fundingRate") is not None), None),
        "openInterest": sum(oi_values) if oi_values else None,
        "longLiquidationsUsd": None, "shortLiquidationsUsd": None,
        "liquidationDataAvailable": False,
        "note": "Open interest is summed across the responding exchanges in USD where supplied or estimated from contract units and mark price. Funding and long/short ratios are cross-exchange arithmetic averages of available values. Liquidation totals are not included because complete public market-wide feeds require exchange WebSockets and are not equivalent to a REST snapshot."
    }
    _derivatives_cache[symbol] = (time.time(), result)
    return result

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


# ---------------- ORIGINVAULT SITE-WIDE AI ASSISTANT ----------------
# Provider keys are optional and must be configured as server-side environment variables.
# Supported providers: Gemini, Groq, and OpenRouter. No paid provider is required by this code.
from collections import defaultdict
import time as _assistant_time

class AssistantChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=8)

_assistant_requests = defaultdict(list)
_ASSISTANT_SYSTEM = """You are OriginVault AI Assistant, the English-only guide for the ORIGINVAULT website.
ALWAYS answer in clear English, even if the user writes in another language. Never output non-English text.
Be accurate, transparent, concise and practical. Do not guess. Distinguish verified facts, estimates, general knowledge and uncertainty.
You know these sections:
1) Media Authenticity (/ai.html): examines image/video/audio for AI-generated signals and provenance; C2PA marker presence is not full cryptographic validation.
2) Token Intelligence (/token-intelligence.html): examines supported EVM token contracts, tokenomics, liquidity, holders and market signals. It is not a guarantee of safety.
3) Evidence Comparison Lab (/evidence-comparison.html): local browser-based file comparison using SHA-256, byte-level checks and perceptual image similarity; selected files are processed in the browser, not uploaded by this assistant.
4) AI Crypto Analyst (/crypto-analyst.html): technical indicators, market data and experimental scenarios. Heuristic scores and model output are not financial advice.
5) OriginVault token overview (/token-project.html): official ORIGINVAI project information.
You may guide users step by step, explain concepts and interpret result text they voluntarily paste. You may direct users to the relevant page using its exact path.
GROUNDING RULES: You do not have automatic live web search or direct access to the site's live databases in this chat endpoint. Never invent current prices, market data, contract status, scan results, citations, source URLs or API status. For time-sensitive or on-chain questions, say you cannot verify live data here and direct the user to the relevant live-data tool or ask them to share its output. Do not present model memory as a verified current fact. If uncertain, say so clearly.
IMPORTANT LIMITS: You cannot directly operate website tools, inspect a user's private files, change account settings, submit transactions, move funds, execute code, or perform actions on their behalf. Never claim an action was completed. Never request or accept wallet seed phrases, private keys, passwords or recovery codes; tell users not to share them. For crypto, avoid personalized investment recommendations and state uncertainty. Do not claim to have run a scan or comparison unless the user provides its result.
If asked to do something beyond these abilities, explain the limitation and provide the exact section/link and next steps. Prefer short structured answers over long walls of text."""

def _assistant_local_reply(message: str) -> str:
    m = message.lower()
    if any(x in m for x in ("which tool", "which section", "where do i start", "what tool")):
        return ("Choose the right OriginVault workspace:\n"
                "• Media, image, video or audio checks: /ai.html\n"
                "• Token contracts and token intelligence: /token-intelligence.html\n"
                "• File comparison: /evidence-comparison.html\n"
                "• Technical market indicators: /crypto-analyst.html\n"
                "• ORIGINVAI project information: /token-project.html")
    if any(x in m for x in ("compare", "file", "sha-256")):
        return ("Open Evidence Comparison Lab: /evidence-comparison.html\n"
                "Select two files to compare. SHA-256 and byte-level checks run in your browser; this assistant does not upload your files.")
    if any(x in m for x in ("token", "contract", "liquidity", "holder")):
        return ("Open Token Intelligence: /token-intelligence.html\n"
                "Check the correct network and contract address. Contract-security flags and market liquidity are different signals; neither guarantees safety.")
    if any(x in m for x in ("crypto", "rsi", "macd", "market", "indicator")):
        return ("Open AI Crypto Analyst: /crypto-analyst.html\n"
                "Choose a symbol, timeframe and indicators. Scores and scenarios are heuristic, uncertain and not financial advice.")
    if any(x in m for x in ("image", "video", "audio", "c2pa", "media")):
        return ("Open Media Authenticity: /ai.html\n"
                "C2PA marker presence alone does not prove that content has been cryptographically validated.")
    return ("I am the built-in OriginVault site guide. I can explain the site's sections and help you choose a workflow. "
            "For a question requiring live prices, blockchain lookups or a new scan, use the relevant specialist tool; this guide cannot verify live data. "
            "Never share passwords, private keys or wallet recovery phrases.")
@app.get("/assistant/health")
def assistant_health():
    providers = []
    if os.getenv("GEMINI_API_KEY"): providers.append("Gemini")
    if os.getenv("GROQ_API_KEY"): providers.append("Groq")
    if os.getenv("OPENROUTER_API_KEY"): providers.append("OpenRouter")
    return {"ok": True, "service": "originvault-assistant", "providers": providers, "mode": "ai" if providers else "site-guide"}

def _assistant_openai_compatible(base_url: str, key: str, model: str, messages: list[dict], extra_headers: dict | None = None):
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if extra_headers: headers.update(extra_headers)
    response = requests.post(base_url, headers=headers,
        json={"model": model, "messages": messages, "temperature": 0.45, "max_tokens": 850},
        timeout=35)
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]

def _assistant_gemini(messages: list[dict]) -> str:
    key = os.getenv("GEMINI_API_KEY")
    model = os.getenv("ASSISTANT_GEMINI_MODEL", "gemini-2.5-flash")
    contents = []
    for item in messages[1:]:
        role = "model" if item["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": item["content"]}]})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    response = requests.post(url, params={"key": key}, json={
        "systemInstruction": {"parts": [{"text": _ASSISTANT_SYSTEM}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.45, "maxOutputTokens": 850}
    }, timeout=35)
    response.raise_for_status()
    data = response.json()
    return "".join(x.get("text", "") for x in data["candidates"][0]["content"]["parts"]).strip()

@app.post("/assistant/chat")
def assistant_chat(req: AssistantChatRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    now = _assistant_time.time()
    recent = [t for t in _assistant_requests[client_ip] if now - t < 60]
    if len(recent) >= 12:
        raise HTTPException(429, "Please wait a moment before sending another message.")
    recent.append(now)
    _assistant_requests[client_ip] = recent

    safe_history = []
    for item in req.history[-8:]:
        role = item.get("role")
        content = str(item.get("content", ""))[:4000]
        if role in ("user", "assistant") and content.strip():
            safe_history.append({"role": role, "content": content})
    if not safe_history or safe_history[-1]["role"] != "user" or safe_history[-1]["content"] != req.message:
        safe_history.append({"role": "user", "content": req.message})
    messages = [{"role": "system", "content": _ASSISTANT_SYSTEM}] + safe_history

    providers = []
    if os.getenv("GEMINI_API_KEY"): providers.append(("Gemini", lambda: _assistant_gemini(messages)))
    if os.getenv("GROQ_API_KEY"):
        providers.append(("Groq", lambda: _assistant_openai_compatible(
            "https://api.groq.com/openai/v1/chat/completions", os.getenv("GROQ_API_KEY"),
            os.getenv("GROQ_ASSISTANT_MODEL", "llama-3.3-70b-versatile"), messages)))
    if os.getenv("OPENROUTER_API_KEY"):
        providers.append(("OpenRouter", lambda: _assistant_openai_compatible(
            "https://openrouter.ai/api/v1/chat/completions", os.getenv("OPENROUTER_API_KEY"),
            os.getenv("OPENROUTER_ASSISTANT_MODEL", "openrouter/free"), messages,
            {"HTTP-Referer": "https://originvault.onrender.com", "X-Title": "ORIGINVAULT AI Assistant"})))
    if not providers:
        return {"reply": _assistant_local_reply(req.message), "provider": "Site Guide",
                "mode": "guide", "note": "No external AI provider is configured on the server."}
    failures = []
    for name, call in providers:
        try:
            answer = call()
            if answer:
                return {"reply": answer[:7000], "provider": name, "mode": "ai"}
            failures.append(name + ": empty response")
        except Exception as exc:
            failures.append(name + ": " + str(exc)[:160])
    raise HTTPException(502, "Configured AI providers are temporarily unavailable. " + " | ".join(failures))
