from FlagEmbedding import BGEM3FlagModel
import torch
import threading

_model: BGEM3FlagModel | None = None

# 并发守卫：unload_model() 可能与仍在进行中的 encode() 调用竞争（FastAPI 同步路由
# 可能跑在不同的 threadpool 线程上）。_active_count 由调用方在 load_model()/encode()
# 整段用量期间维持 >0，unload_model() 据此在有调用仍在进行时提前返回、跳过本次释放
_active_count = 0
_lock = threading.Lock()

def begin_use():
    global _active_count
    with _lock:
        _active_count += 1

def end_use():
    global _active_count
    with _lock:
        _active_count -= 1

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

def unload_model() -> bool:
    global _model
    with _lock:
        if _active_count > 0:
            return False
        if _model is None:
            return True
        del _model
        _model = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print('[Embedding] BGE-M3 unloaded')
        return True

def is_loaded() -> bool:
    return _model is not None