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
    symbol: str = Field(min_length=5, max_length=20, pattern=r"^[A-Z0-9]+$")
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
    return {"ok": True, "service": "originvault-crypto-analyst", "kronos": "lazy-loaded", "gemini": bool(os.getenv("GEMINI_API_KEY"))}

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
