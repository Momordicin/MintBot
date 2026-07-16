from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from embedding.model import load_model, unload_model, is_loaded

app = FastAPI()

class EmbedRequest(BaseModel):
    texts: list[str]

class EmbedResponse(BaseModel):
    embeddings: list[list[float]]

class UnloadResponse(BaseModel):
    unloaded: bool

@app.get('/health')
def health():
    return {'status': 'ok', 'embedding_loaded': is_loaded()}

@app.post('/embed', response_model=EmbedResponse)
def embed(req: EmbedRequest):
    model = load_model()
    result = model.encode(
        req.texts,
        batch_size=12,
        max_length=8192,
        return_dense=True,
        return_sparse=False,
        return_colbert_vecs=False,
    )
    embeddings = result['dense_vecs'].tolist()
    return EmbedResponse(embeddings=embeddings)

@app.post('/embed/unload', response_model=UnloadResponse)
def unload():
    unload_model()
    return UnloadResponse(unloaded=True)