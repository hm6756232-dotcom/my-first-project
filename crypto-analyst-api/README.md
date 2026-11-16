# ORIGINVAULT Crypto Analyst API

Python service for the optional Gemini and Kronos engines. The browser-only technical analysis in `/crypto-analyst.html` does not depend on this service.

## Local run

Python 3.11 is recommended.

```bash
cd crypto-analyst-api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
git clone --depth 1 https://github.com/shiyu-coder/Kronos.git /opt/Kronos
export PYTHONPATH=/opt/Kronos
export GEMINI_API_KEY="your-key" # optional; never put this in frontend code or Git
export GEMINI_MODEL="gemini-3.8-flash"
export GOPLUS_ACCESS_TOKEN="your-goplus-token" # optional; required only for contract security checks
export CORS_ORIGINS="https://originvault.onrender.com"
uvicorn main:app --host 0.0.0.0 --port 8000
```

The Dockerfile performs the Kronos repository clone and starts the API. Configure `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOPLUS_ACCESS_TOKEN`, and `CORS_ORIGINS` as server environment variables. GoPlus security checks require an access token; obtain one through GoPlus and never place it in the browser. Gemini is optional; without a key, the algorithmic engine and Kronos endpoint can still be used.

## Endpoints

- `GET /health`
- `GET /derivatives/{symbol}` — Binance USD-M perpetual funding, open interest, mark/index prices, and recent liquidation-feed sample
- `GET /marketdata/{symbol}` — Binance 24h quote, top-20 order-book depth/spread/imbalance, and best-match DexScreener pool liquidity
- `GET /token-risk/{chain_id}/{address}` — GoPlus token-security flags, holder concentration and reported LP lock/burn indicators for supported EVM networks

The frontend loads the top 100 CoinMarketCap listings through its keyless public listings endpoint. The ranked universe is broader than Binance's spot listing universe; a coin may appear in the list but lack a Binance `SYMBOLUSDT` candlestick pair. DEX liquidity is matched heuristically by token symbol and the selected pool is shown in the UI; verify the contract and pool before relying on it.
- `POST /analyze` — Gemini interpretation of supplied candle-derived facts
- `POST /forecast` — Kronos-small forecast, default five sampled paths

The API lazily loads Kronos-small and uses CUDA if available, otherwise CPU. First inference can be slow while model weights are downloaded and loaded. Keep request sizes and forecast paths modest on CPU.

## Google Colab

Open `notebooks/ORIGINVAULT_Kronos_Test.ipynb` in Colab to run an interactive model smoke test. Colab runtimes are temporary and resource-limited. The notebook is for interactive testing only, not a persistent API endpoint or production web service. Google explicitly restricts using managed Colab runtimes as unrelated web-service hosting.

## Deployment status and security

The Python service is source code only until deployed to a persistent Python host. Do not enter an API key in the website or commit it to this repository. Before public deployment, add authentication and per-client rate limiting to the model endpoints, monitor resource usage, and set `CORS_ORIGINS` to the exact site origin. A public unauthenticated model endpoint can be abused and incur compute/API costs.

## Model interpretation

Kronos is a financial-candlestick forecasting model, not a news/research LLM. The P10–P90 band is the percentile range of sampled model paths, not a calibrated 80% real-world confidence interval. Forecasts are experimental and are not financial advice.
