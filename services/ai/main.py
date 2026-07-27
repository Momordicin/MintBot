from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from embedding.model import load_model, unload_model, is_loaded, begin_use, end_use
from ner.model import (
    unload_model as unload_ner_model,
    is_loaded as is_ner_loaded,
    extract_entities,
    begin_use as ner_begin_use,
    end_use as ner_end_use,
)

app = FastAPI()

class EmbedRequest(BaseModel):
    texts: list[str]

class EmbedResponse(BaseModel):
    embeddings: list[list[float]]

class UnloadResponse(BaseModel):
    unloaded: bool

class NerEntity(BaseModel):
    text: str
    label: str
    start: int
    end: int

class NerRequest(BaseModel):
    texts: list[str]

class NerResponse(BaseModel):
    results: list[list[NerEntity]]

@app.get('/health')
def health():
    return {'status': 'ok', 'embedding_loaded': is_loaded(), 'ner_loaded': is_ner_loaded()}

@app.post('/embed', response_model=EmbedResponse)
def embed(req: EmbedRequest):
    begin_use()
    try:
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
    finally:
        end_use()

@app.post('/embed/unload', response_model=UnloadResponse)
def unload():
    unloaded = unload_model()
    return UnloadResponse(unloaded=unloaded)

@app.post('/ner', response_model=NerResponse)
def ner(req: NerRequest):
    ner_begin_use()
    try:
        results = extract_entities(req.texts)
        return NerResponse(results=results)
    finally:
        ner_end_use()

@app.post('/ner/unload', response_model=UnloadResponse)
def unload_ner():
    unloaded = unload_ner_model()
    return UnloadResponse(unloaded=unloaded)