# Speech-to-text worker for the console's mic button (voice.mjs starts it, one at a time).
# Protocol: one JSON object per line on stdin {"id", "path", "model", "lang", "mode"} -> one JSON line on stdout {"id", "text", "lang", "prob", "first", "ms"}
# (mode "segments": also "segments" [{lang, prob, start, end}] and "langs") or {"id", "error"}.
# The model stays loaded between requests (the first one pays the load); a different model name swaps it. voice.mjs kills this process
# after the idle time, which is what frees the RAM. Never prints audio or text anywhere but the reply line (stderr stays free of content).
import json, os, sys, time

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

THREADS = int(os.environ.get("VOICE_THREADS", "16"))   # 16 of 40 cores: measured as fast as 20+ on the loaded box, leaves room for the seats
model, loaded = None, None
SR, MIN_SEG = 16000, 1.5   # sample rate of the WAV voice.mjs writes; shortest piece (s) that gets its own language

def load(name):
    global model, loaded
    if loaded != name:
        model, loaded = None, None   # drop the old one first (a failed load must not leave the old name cached): two large models at once would double the RAM
        model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=THREADS)
        loaded = name
    return model

def reply(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n"); sys.stdout.flush()

SPOKEN = ("he", "en", "de")   # the owner speaks only these: detection picks the likeliest of the three, never e.g. Arabic

def segments(m, path):
    # Live dictation that switches language between sentences: Whisper detects ONE language per call, so a he + en + de dictation came back
    # all in one of them. Here the speech is cut at pauses (silero VAD), pieces under MIN_SEG are merged into their neighbour (too short to
    # detect reliably), and each piece is detected among SPOKEN and read in its own language. A switch inside one sentence stays one piece.
    audio = decode_audio(path, sampling_rate=SR)
    spans = [[c["start"], c["end"]] for c in get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=600, speech_pad_ms=200))]
    merged = []
    for s in spans:
        if merged and (merged[-1][1] - merged[-1][0] < MIN_SEG * SR or s[1] - s[0] < MIN_SEG * SR):
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    out, texts = [], []
    for a, b in merged:
        chunk = audio[a:b]
        _, _, probs = m.detect_language(audio=chunk)
        lang, prob = max(((l, p) for l, p in probs if l in SPOKEN), key=lambda x: x[1])
        segs, _ = m.transcribe(chunk, language=lang, beam_size=1, vad_filter=False, condition_on_previous_text=False, without_timestamps=True)
        txt = " ".join(s.text.strip() for s in segs).strip()
        if txt:
            texts.append(txt)
            out.append({"lang": lang, "prob": round(prob, 3), "start": round(a / SR, 2), "end": round(b / SR, 2)})
    langs = list(dict.fromkeys(s["lang"] for s in out))
    main = max(out, key=lambda s: s["end"] - s["start"]) if out else None   # the language spoken longest = the clip's "lang" (older callers read only that)
    return {"text": " ".join(texts), "segments": out, "langs": langs, "lang": main and main["lang"], "prob": main and main["prob"]}

reply({"ready": True})
for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid = req.get("id")
    try:
        t = time.time()
        m = load(req["model"])
        if req.get("mode") == "segments":   # Smart finish: a dictation that mixes languages, read piece by piece
            r = segments(m, req["path"])
            r.update(id=rid, ms=int((time.time() - t) * 1000)); reply(r); continue
        lang = req.get("lang") or None   # None = detect (Hebrew, English, German all come out right on their own)
        temp = {} if req.get("temperature") is None else {"temperature": float(req["temperature"])}   # rolling correction: 0, no sampling fallbacks
        segs, info = m.transcribe(req["path"], language=lang, beam_size=1, vad_filter=True,
                                  condition_on_previous_text=False, without_timestamps=True, **temp)
        text = " ".join(s.text.strip() for s in segs).strip()
        prob = round(info.language_probability, 3) if not lang else None   # how sure the detection was (Smart finish only trusts >= 0.6); kept from the first pass
        first = info.language   # what the first pass heard (DIAG: a Hebrew clip read as e.g. Arabic shows up here, not in lang)
        if not lang and info.language not in ("he", "en", "de"):   # auto, but the owner speaks only these: a short or mixed clip read as e.g. Arabic is redone as Hebrew
            segs, info = m.transcribe(req["path"], language="he", beam_size=1, vad_filter=True,
                                      condition_on_previous_text=False, without_timestamps=True)
            text = " ".join(s.text.strip() for s in segs).strip()
            prob = None   # a forced Hebrew re-read: the first pass's confidence says nothing about it
        reply({"id": rid, "text": text, "lang": info.language, "prob": prob, "first": first, "ms": int((time.time() - t) * 1000)})
    except Exception as e:   # a bad file or a failed load: the caller gets the reason, the worker lives on
        reply({"id": rid, "error": type(e).__name__ + ": " + str(e)[:300]})
