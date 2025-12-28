from typing import List, Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

import torch
from transformers import AutoTokenizer

from classifier import DesklibAIDetectionModel, predict_batch_texts, export_model

# Add logging
#logging.basicConfig(level=logging.DEBUG)

reward_model_directory = "desklib/ai-text-detector-v1.01"
EXPORT = False
COMPILE = False
REWARD_MODEL = DesklibAIDetectionModel.from_pretrained(reward_model_directory)
REWARD_TOKENIZER = AutoTokenizer.from_pretrained(reward_model_directory)
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if EXPORT and DEVICE==torch.device('cpu'):
    REWARD_MODEL = export_model(REWARD_MODEL, REWARD_TOKENIZER, "Hi, how are you?")
# --- Set up device ---
else:
    REWARD_MODEL.to(DEVICE)
if COMPILE:
    REWARD_MODEL.compile()
LENGTH_TO_IGNORE = 5
BATCH_SIZE = 4

def get_texts_scores(inp: list[str]) -> list[float | None]:
    predictions = [None] * len(inp)  # preserve order
    valid_indices = [i for i, text in enumerate(inp) if len(text.strip()) > LENGTH_TO_IGNORE]
    valid_texts = [inp[i] for i in valid_indices]
    print(valid_texts)
    # process in batches
    for start in range(0, len(valid_texts), BATCH_SIZE):
        batch = valid_texts[start:start + BATCH_SIZE]
        # predict_batch_texts(text, model, tokenizer, device)
        if len(batch)>0:
            batch_scores = predict_batch_texts(batch, REWARD_MODEL, REWARD_TOKENIZER, DEVICE).tolist()
            for idx, score in zip(valid_indices[start:start + len(batch)], batch_scores):
                predictions[idx] = score
    return predictions


class TextBlock(BaseModel):
    id: str = Field(..., description="A unique id for the element/text block, controlled by the client")
    text: str = Field(..., description="The text content of the element")


class ScoreRequest(BaseModel):
    blocks: List[TextBlock]


class ScoredBlock(BaseModel):
    id: str
    score: float


class ScoreResponse(BaseModel):
    scores: List[ScoredBlock]
    scale: str = Field(default="1-100")


app = FastAPI(title="Text Scoring API", version="0.1.0")

# Allow requests from any origin (Chrome extensions, various pages)
# If you want to restrict, replace allow_origins with specific origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # You can restrict this later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/score", response_model=ScoreResponse)
def score_text(request: ScoreRequest):
    # results = []
    # for block in request.blocks:
    #     s = get_text_score(block.text)
    #     results.append(ScoredBlock(id=block.id, score=s))
    # print("Texts to process")
    # for block in request.blocks:
    #     print(block.text)
    results = get_texts_scores([block.text for block in request.blocks])
    results = [ScoredBlock(id=block.id, score=res) for block, res in zip(request.blocks,results)]
    # print(results)
    return ScoreResponse(scores=results)


class RewriteRequest(BaseModel):
    text: str = Field(..., description="Text to rewrite")


class RewriteResponse(BaseModel):
    text: str


# ========== To be implemented later ==========
def rewrite(inp: str) -> str:
    """
    Placeholder rewrite function. To be replaced later with the AI-detection bypass model.
    Currently returns the input unchanged.
    """
    return (inp or "")
# ================================================================


@app.post("/rewrite", response_model=RewriteResponse)
def rewrite_endpoint(request: RewriteRequest):
    return RewriteResponse(text=rewrite(request.text))


if __name__ == "__main__":
    # Run: python server/app.py
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
