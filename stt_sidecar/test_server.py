import io, wave, struct
from fastapi.testclient import TestClient
from server import app, _state

def make_silent_wav(seconds=1, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(struct.pack("<" + "h" * rate * seconds, *([0] * rate * seconds)))
    buf.seek(0)
    return buf

class FakeModel:
    def transcribe(self, path, **kwargs):
        seg = type("S", (), {"text": "hello world", "start": 0.0, "end": 1.0,
                             "words": [type("W", (), {"word": "hello", "start": 0.0, "end": 0.5})()]})()
        info = type("I", (), {"language": "en"})()
        return [seg], info

def test_health():
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "ok"

def test_transcribe_returns_text(monkeypatch):
    _state["model"] = FakeModel()
    _state["model_name"] = "small"  # match the default so get_model() reuses the fake, never builds a real model
    client = TestClient(app)
    wav = make_silent_wav()
    r = client.post("/transcribe", files={"file": ("a.wav", wav, "audio/wav")})
    body = r.json()
    assert body["text"] == "hello world"
    assert body["words"][0]["word"] == "hello"

def reset_state():
    _state.update(model=None, model_name=None, device=None, compute=None)

def test_auto_falls_back_to_cpu_when_cuda_fails(monkeypatch):
    reset_state()
    attempts = []
    def fake_ctor(name, device, compute_type):
        attempts.append((device, compute_type))
        if device == "cuda":
            raise RuntimeError("no CUDA runtime")
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    import server
    server.get_model("small")
    assert attempts == [("cuda", "float16"), ("cpu", "int8")]
    assert _state["device"] == "cpu" and _state["compute"] == "int8"

def test_working_device_is_cached_across_rebuilds(monkeypatch):
    reset_state()
    attempts = []
    def fake_ctor(name, device, compute_type):
        attempts.append(device)
        if device == "cuda":
            raise RuntimeError("no CUDA runtime")
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    import server
    server.get_model("small")
    server.get_model("large")  # model-name change forces a rebuild
    assert attempts == ["cuda", "cpu", "cpu"]  # cuda tried exactly once

def test_health_reports_device_and_compute(monkeypatch):
    reset_state()
    monkeypatch.setattr("server.WhisperModel", lambda name, device, compute_type: FakeModel())
    import server
    server.get_model("small")
    body = TestClient(app).get("/health").json()
    assert body["device"] == "cuda" and body["compute"] == "float16"

def test_warmup_inference_failure_falls_back_to_cpu(monkeypatch):
    # Model construction can succeed on a broken cuda runtime (e.g. pip nvidia
    # libs missing from the loader path); the failure only surfaces on the
    # first real inference. get_model's warm-up call must catch that and fall
    # back to cpu instead of leaving a broken cuda model cached.
    reset_state()

    class BrokenCudaModel:
        def __init__(self, device):
            self.device = device
        def transcribe(self, audio, **kwargs):
            if self.device == "cuda":
                raise RuntimeError("Library libcublas.so.12 is not found or cannot be loaded")
            return [], type("I", (), {"language": "en"})()

    attempts = []
    def fake_ctor(name, device, compute_type):
        attempts.append((device, compute_type))
        return BrokenCudaModel(device)
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    import server
    server.get_model("small")
    assert attempts == [("cuda", "float16"), ("cpu", "int8")]
    assert _state["device"] == "cpu" and _state["compute"] == "int8"

def test_transcribe_rebuilds_model_on_name_change(monkeypatch):
    # A model is warm under a different name; a request for "small" must rebuild.
    _state["model"] = FakeModel()
    _state["model_name"] = "large"
    built = {}
    def fake_ctor(name, **kwargs):
        built["name"] = name
        return FakeModel()
    monkeypatch.setattr("server.WhisperModel", fake_ctor)
    client = TestClient(app)
    r = client.post("/transcribe",
                    files={"file": ("a.wav", make_silent_wav(), "audio/wav")},
                    data={"model": "small"})
    assert r.status_code == 200
    assert built["name"] == "small"  # rebuilt with the requested model, not stale "large"


def test_health_reports_batch_size(monkeypatch):
    reset_state()
    monkeypatch.setattr("server.WhisperModel", lambda name, device, compute_type: FakeModel())
    import server
    server.get_model("small")  # device becomes 'cuda' (fake ctor never raises)
    body = TestClient(app).get("/health").json()
    assert "batch_size" in body
    assert body["batch_size"] == 8  # cuda default


def test_batch_size_disabled_uses_sequential(monkeypatch):
    # STT_BATCH_SIZE=0 disables batching; a FakeModel (no feature_extractor)
    # would also force the sequential path. Either way transcribe still works.
    reset_state()
    monkeypatch.setattr("server.STT_BATCH_SIZE", 0)
    _state["model"] = FakeModel()
    _state["model_name"] = "small"
    import server
    assert server.get_batched() is None  # disabled
    r = TestClient(app).post("/transcribe",
                             files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
    assert r.json()["text"] == "hello world"


def test_fake_model_falls_back_to_sequential(monkeypatch):
    # A model without feature_extractor (the test fake) must not be wrapped in the
    # batched pipeline — get_batched returns None so transcribe stays sequential.
    reset_state()
    monkeypatch.setattr("server.STT_BATCH_SIZE", None)  # per-device default (>0)
    _state.update(model=FakeModel(), model_name="small", device="cpu", compute="int8")
    import server
    assert server.get_batched() is None


def test_vocabulary_reaches_sequential_and_batched_transcription(monkeypatch):
    import server
    for batched in (False, True):
        calls = []
        class CapturingModel(FakeModel):
            def transcribe(self, path, **kwargs):
                calls.append(kwargs)
                return super().transcribe(path, **kwargs)
        model = CapturingModel()
        monkeypatch.setattr(server, "get_model", lambda name: model)
        monkeypatch.setattr(server, "get_batched", lambda: model if batched else None)
        r = TestClient(app).post("/transcribe",
                                files={"file": ("a.wav", make_silent_wav(), "audio/wav")},
                                data={"vocabulary": "AWP, connector"})
        assert r.status_code == 200
        assert calls[0]["hotwords"] == "AWP, connector"
        calls.clear()
        r = TestClient(app).post("/transcribe", files={"file": ("a.wav", make_silent_wav(), "audio/wav")})
        assert r.status_code == 200
        assert "hotwords" not in calls[0]
