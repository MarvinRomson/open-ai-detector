# Text Scoring App (FastAPI + Chrome Extension)

This project contains:
- A FastAPI server exposing a `/score` endpoint that calls scorer (1–100).
- A Chrome extension that scans all open pages for text blocks, sends selected to the server, and highlights them by score.
- Rewriting functionality may come later!

---

## 1) Run the FastAPI server locally (without Docker)

**Steps:**
1. Create and activate virtual environment — macOS/Linux: `python -m venv .venv && source .venv/bin/activate`, Windows PowerShell: `python -m venv .venv && .venv\Scripts\Activate.ps1`
2. Install dependencies: `pip install -r server/requirements.txt`
3. Run the server (with auto-reload): `python server/app.py`
4. Check health endpoint: open `http://localhost:8000/health` → should return `{"status":"ok"}`

---

## 1b) Run the FastAPI server with Docker Compose

If you prefer to avoid managing Python and dependencies locally, you can run the API in a Docker container.

**Prerequisites:**
- Docker and Docker Compose installed.

**Build and run:**
From the project root:

```bash
docker-compose up --build
```

This will:
- Build the image from the `Dockerfile` at the repo root.
- Install dependencies from `server/requirements.txt`.
- Start the FastAPI app with Uvicorn on port `8000`.

**Run in the background:**

```bash
docker-compose up -d
```

**Stop containers:**

```bash
docker-compose down
```

**Check health endpoint:**

- Open `http://localhost:8000/health` → should return `{"status":"ok"}`

---

## 2) Load the Chrome extension

Folder: `extension/`

**What it does**
- Scans page text (`p`, `div`, `article`, etc.)
- Sends text blocks to `http://localhost:8000/score`
- Receives scores and highlights each element (red = high, yellow = mid, green = low). High score means high probability of being written by some LLM!

**Permissions:** `tabs`, `scripting`, `storage`, and host access for `http://localhost:8000/*`

**Steps:**
1. Open Chrome → `chrome://extensions`
2. Enable “Developer mode”
3. Click “Load unpacked” → select `extension/` folder
4. Ensure it’s enabled

Note: Server must be running at `http://localhost:8000`. You can change the URL in `extension/background.js` by editing `SERVER_URL`.

---

## 3) Detection & research notes

**DetectGPT (perturbation + probability curvature)**  
Detects AI text by measuring how log-probabilities change under small perturbations.
Current opensource libraries use this approach, that is outdated, but gave us necessary fundamentals. At the same time it can combined with classifier-based detectors for stronger hybrid detection.
Reference: [DetectGPT: Zero-Shot Machine-Generated Text Detection using Probability Curvature (2023)](https://arxiv.org/pdf/2301.11305)

---

**Desklib detector (English-only)**  
[Desklib’s `ai-text-detector-v1.01`](https://huggingface.co/desklib/ai-text-detector-v1.01) uses `DeBERTa-v3-large` fine-tuned for AI vs human classification.  
It outputs an AI probability and supports **English text only** — results on other languages are unreliable.

Mapping ideas:  
- `score = prob_ai * 100` → AI-likelihood  
- `score = (1 - prob_ai) * 100` → Human-likeness

---

**Caveats:**  
Detectors can be bypassed through paraphrasing, style transfer, or reward-tuned stylistic alignment.  
See related Medium articles for background:  
- [The Right Approach to Personalize LLM Style](https://medium.com/towards-artificial-intelligence/the-right-approach-to-personalize-llm-style-rewards-dropout-for-human-styles-alignment-and-7160974764d5)  
- [Fighting Style Collapse](https://medium.com/towards-artificial-intelligence/fighting-style-collapse-reinforcement-learning-with-bit-lora-for-llm-style-personalization-46e818f7495e)

---

## 4) Desklib integration summary

Load the model: `from transformers import AutoTokenizer, AutoModelForSequenceClassification`  
Example:  
`tokenizer = AutoTokenizer.from_pretrained("desklib/ai-text-detector-v1.01")`  
`model = AutoModelForSequenceClassification.from_pretrained("desklib/ai-text-detector-v1.01")`  
Run prediction → apply `torch.sigmoid(logits)` → map to score 1–100.

Response payload should include:  
`"method": "desklib/ai-text-detector-v1.01", "language": "en"`

---

## 5) Customization

- **Thresholds:** tweak low/mid/high highlight logic in `extension/content.js`  
- **Model fusion:** combine Desklib with DetectGPT-style perplexity  
- **Language filter:** restrict to English (`"language": "en"`)  
- **Robustness testing:** try paraphrased and stylized text  
- **Privacy:** avoid sending full text externally; use local inference or hashes

---

## 6) Troubleshooting

- No highlights → ensure FastAPI server is live at `http://localhost:8000/health`
- CORS errors → set `allow_origins=["*"]` in `server/app.py`
- Too many highlights → adjust `MIN_CHARS` in `extension/content.js`
- Poor results on non-English text → model supports **English only**

---

## 7) References

- [DetectGPT Paper (2023)](https://arxiv.org/pdf/2301.11305)  
- [Desklib AI Text Detector v1.01 (English-only)](https://huggingface.co/desklib/ai-text-detector-v1.01)  
- [The Right Approach to Personalize LLM Style](https://medium.com/towards-artificial-intelligence/the-right-approach-to-personalize-llm-style-rewards-dropout-for-human-styles-alignment-and-7160974764d5)  
- [Fighting Style Collapse](https://medium.com/towards-artificial-intelligence/fighting-style-collapse-reinforcement-learning-with-bit-lora-for-llm-style-personalization-46e818f7495e)

---

## 8) Tests

- The detection model is old, so its performance with the new LLMs may be limited. At the same time, similar models families have similar tokens distributions (may distill each other during the training) and similar fingerprints.
- Tested with GPT-4.1 and GPT-5 families, shows very good performance.

---

## 🤝 Contribute & Collaborate

If you're interested in contributing, testing new detection methods, or exploring related projects, feel free to reach out — collaboration is welcome!

📩 Contact: marvinromson@gmail.com  

---

## ❤️ Support

If you find this project helpful or use it in your research, you can support further development:  
📩 Contact: marvinromson@gmail.com
