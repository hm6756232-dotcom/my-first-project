# ORIGINVAULT Crypto Analyst API

Python service for the optional Gemini and Kronos engines. The browser-only technical analysis in `/crypto-analyst.html` does not depend on this service.

## Free Render deployment

The repository-level `render.yaml` preserves the existing static website service and adds a separate **Free** Python web service named `originvault-crypto-analyst-api`. In the Render Dashboard, open the existing Blueprint and apply/sync the new service after this commit appears. Do not create a paid instance.

The lightweight free deployment supports market-data, DEX OHLCV, multi-exchange derivatives aggregation (Binance, Bybit, OKX), and optional Gemini/GoPlus routes. **Kronos is intentionally disabled** in this profile because loading its PyTorch model is not reliable within the free instance's 512 MB memory. The full `requirements.txt` and Dockerfile remain for a larger host. Render free services sleep after 15 minutes without traffic and may take about a minute to wake.

After Render creates the service, copy its actual `onrender.com` URL into the Python API URL field on `/crypto-analyst.html`. The API hostname is assigned by Render and is not guessed or hard-coded.

Optional environment variables in the new API service:
- `GEMINI_API_KEY` — enables Gemini interpretation; keep it server-side only.
- `GEMINI_MODEL` — optional model override.
- `GOPLUS_ACCESS_TOKEN` — enables GoPlus contract checks.
- `CORS_ORIGINS` is set by the Blueprint to the production website origin.
- `KRONOS_ENABLED=false` is set by the Blueprint for the free profile.

Do not add paid services or paid resources.

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
- `GET /dex-candles/{symbol}/{interval}` — DexScreener pool discovery plus GeckoTerminal DEX OHLCV fallback (no API key; public rate limit is approximately 10 requests/minute)
- `GET /derivatives/{symbol}` — independently queries public Binance USD-M, Bybit Linear, and OKX USDT-SWAP market data; returns per-exchange open interest (USD where available/estimated), funding rate, available long/short account ratios, coverage status, and indicative aggregates. Results are briefly cached to reduce upstream rate-limit pressure. Liquidation totals are intentionally not fabricated: a complete live feed requires exchange WebSocket streams and is not represented by these REST snapshots.
- `GET /marketdata/{symbol}` — Binance 24h quote, top-20 order-book depth/spread/imbalance, and best-match DexScreener pool liquidity
- `GET /token-risk/{chain_id}/{address}` — GoPlus token-security flags, holder concentration and reported LP lock/burn indicators for supported EVM networks

The frontend loads the top 100 CoinMarketCap listings through its keyless public listings endpoint. For chart data it first tries Binance spot pairs with several quote currencies, then uses the configured Python API to discover a DEX pool and fetch GeckoTerminal OHLCV when no CEX pair is available. The ranked universe is broader than Binance's spot listing universe; a coin may appear in the list but lack a Binance `SYMBOLUSDT` candlestick pair. DEX liquidity and fallback chart pools are matched heuristically by token symbol and highest reported liquidity; the selected pool address is shown in the UI. This is not a verified CMC-ID-to-contract mapping: verify token contract, chain, and pool before relying on any DEX figures. GeckoTerminal's public API is beta/cached and rate-limited; it may throttle or return no historical bars for thin pools.
- `POST /analyze` — Gemini interpretation of supplied candle-derived facts
- `POST /forecast` — Kronos-small forecast, default five sampled paths

The API lazily loads Kronos-small and uses CUDA if available, otherwise CPU. First inference can be slow while model weights are downloaded and loaded. Keep request sizes and forecast paths modest on CPU.

## Google Colab

Open `notebooks/ORIGINVAULT_Kronos_Test.ipynb` in Colab to run an interactive model smoke test. Colab runtimes are temporary and resource-limited. The notebook is for interactive testing only, not a persistent API endpoint or production web service. Google explicitly restricts using managed Colab runtimes as unrelated web-service hosting.

## Deployment status and security

The Python service is source code only until deployed to a persistent Python host. Do not enter an API key in the website or commit it to this repository. Before public deployment, add authentication and per-client rate limiting to the model endpoints, monitor resource usage, and set `CORS_ORIGINS` to the exact site origin. A public unauthenticated model endpoint can be abused and incur compute/API costs.

## Model interpretation

Kronos is a financial-candlestick forecasting model, not a news/research LLM. The P10–P90 band is the percentile range of sampled model paths, not a calibrated 80% real-world confidence interval. Forecasts are experimental and are not financial advice.


## Multi-exchange derivatives notes

The derivatives endpoint queries Binance, Bybit and OKX independently. A symbol can exist on one venue but not another; the response reports each venue's status and only aggregates fields actually returned. Open interest is reported in USD when the exchange supplies a USD value, or estimated as contract quantity × mark price where possible. Funding and long/short account ratios are arithmetic averages of the available venue values, not a volume-weighted CoinGlass-style composite. Do not compare raw open-interest contract quantities across venues. Public exchange APIs are rate-limited and can be temporarily unavailable. Liquidations are not shown as totals because complete market-wide feeds require WebSocket subscriptions and exchange-specific event interpretation.


## OriginVault AI Assistant

The site-wide assistant is available at `/ai-assistant.html` and uses the existing lightweight API service:
- `GET /assistant/health` — reports whether optional AI providers are configured.
- `POST /assistant/chat` — answers site questions using configured providers, with provider fallback.

Optional server-side environment variables (never place these in frontend files or Git):
- `GEMINI_API_KEY` — enables Gemini; assistant model defaults to `gemini-2.5-flash` and can be changed with `ASSISTANT_GEMINI_MODEL`.
- `GROQ_API_KEY` — enables Groq; optional model override: `GROQ_ASSISTANT_MODEL`.
- `OPENROUTER_API_KEY` — enables OpenRouter; optional model override: `OPENROUTER_ASSISTANT_MODEL`.

The router tries configured providers in this order: Gemini, Groq, OpenRouter. If no provider key is set, a built-in site-guide mode answers common navigation questions without an external model. Free model availability, rate limits and quotas are controlled by each provider and can change. The endpoint applies a basic per-IP in-memory request limit; this is not a substitute for production-grade authentication or distributed abuse protection. The assistant is informational and cannot execute arbitrary actions, access user files, submit transactions or move funds. Never share passwords, wallet private keys or recovery phrases.
