from FlagEmbedding import BGEM3FlagModel
import torch

_model: BGEM3FlagModel | None = None

def load_model() -> BGEM3FlagModel:
    global _model
    if _model is not None:
        return _model
    
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'[Embedding] Loading BGE-M3 on {device}...')
    
    _model = BGEM3FlagModel(
        'BAAI/bge-m3',
        use_fp16=True,
        device=device,
    )
    print('[Embedding] BGE-M3 ready ✓')
    return _model

def unload_model():
    global _model
    if _model is None:
        return
    del _model
    _model = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print('[Embedding] BGE-M3 unloaded')

def is_loaded() -> bool:
    return _model is not None