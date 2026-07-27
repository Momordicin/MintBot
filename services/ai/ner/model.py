from transformers import AutoTokenizer, AutoModelForTokenClassification, pipeline
import torch
import threading

_tokenizer = None
_model = None
_pipeline = None

# 并发守卫：unload_model() 可能与仍在进行中的 extract_entities() 调用竞争（FastAPI 同步路由
# 可能跑在不同的 threadpool 线程上）。_active_count 由调用方在 load_model()/extract_entities()
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

def load_model():
    global _tokenizer, _model, _pipeline
    if _pipeline is not None:
        return _pipeline

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'[NER] Loading bert4ner-base-chinese on {device}...')

    _tokenizer = AutoTokenizer.from_pretrained('shibing624/bert4ner-base-chinese')
    _model = AutoModelForTokenClassification.from_pretrained('shibing624/bert4ner-base-chinese')
    _model.to(device)
    _pipeline = pipeline(
        'token-classification',
        model=_model,
        tokenizer=_tokenizer,
        aggregation_strategy='simple',
        device=0 if device == 'cuda' else -1,
    )
    print('[NER] bert4ner-base-chinese ready ✓')
    return _pipeline

def unload_model() -> bool:
    global _tokenizer, _model, _pipeline
    with _lock:
        if _active_count > 0:
            return False
        if _pipeline is None:
            return True
        del _tokenizer, _model, _pipeline
        _tokenizer = None
        _model = None
        _pipeline = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print('[NER] bert4ner-base-chinese unloaded')
        return True

def is_loaded() -> bool:
    return _pipeline is not None

def extract_entities(texts: list[str]) -> list[list[dict]]:
    ner_pipeline = load_model()
    raw_results = ner_pipeline(texts)
    return [
        [
            {
                # slice from the source text rather than using entity['word'],
                # which inserts spaces between Chinese characters
                'text': text[int(entity['start']):int(entity['end'])],
                'label': entity['entity_group'],
                'start': int(entity['start']),
                'end': int(entity['end']),
            }
            for entity in text_entities
        ]
        for text, text_entities in zip(texts, raw_results)
    ]
