"""Exercise the real faster-whisper/PyAV boundary, without model downloads."""
import io
import wave

import numpy as np
import pytest
from faster_whisper.audio import decode_audio


@pytest.mark.parametrize("rate,channels", [(16000, 1), (48000, 2)])
def test_wav_decoding_and_resampling(rate, channels):
    # A non-silent tone checks decoded samples as well as API compatibility.
    samples = (np.sin(2 * np.pi * 440 * np.arange(rate) / rate) * 8192).astype("<i2")
    pcm = np.repeat(samples[:, None], channels, axis=1).tobytes()
    wav = io.BytesIO()
    with wave.open(wav, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(pcm)
    wav.seek(0)

    decoded = decode_audio(wav, sampling_rate=16000)
    assert decoded.shape == (16000,)
    assert decoded.dtype == np.float32
    assert np.isfinite(decoded).all()
    assert np.max(np.abs(decoded)) > 0.1
