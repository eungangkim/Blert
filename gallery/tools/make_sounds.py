"""갤러리 소리 테마를 합성한다 (D-84: 직접 만든 소리, CC0-1.0).

외부 음원이나 난수를 쓰지 않고 수식만으로 만들어서, 같은 스크립트는 항상 같은 파일(같은 해시)을 만든다.
  python gallery/tools/make_sounds.py
만든 뒤 `npm run gallery:build`로 index.json을 갱신한다.

형식: 모노, 22,050Hz, 16비트 PCM WAV (blert 소리 검사 기준 안: 3초 이하, 512KB 이하).
"""
import hashlib
import json
import math
import struct
import wave
from pathlib import Path

RATE = 22050
ROOT = Path(__file__).resolve().parent.parent / "sounds"


def note(freq, dur, kind, amp, decay):
    """한 음. kind: bell(사인+배음, 지수 감쇠) / square(사각파, 짧은 페이드)"""
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        if kind == "bell":
            env = math.exp(-decay * t)
            v = math.sin(2 * math.pi * freq * t) + 0.35 * math.sin(2 * math.pi * freq * 2.01 * t) + 0.12 * math.sin(2 * math.pi * freq * 3.02 * t)
            v = v / 1.47 * env
        else:
            env = 1.0
            v = 1.0 if math.sin(2 * math.pi * freq * t) >= 0 else -1.0
        # 딸깍 소리를 막는 짧은 시작·끝 페이드 (3ms / 8ms)
        a, r = int(RATE * 0.003), int(RATE * 0.008)
        fade = min(1.0, i / a if a else 1.0, (n - 1 - i) / r if r else 1.0)
        out.append(v * env * fade * amp)
    return out


def mix(parts, total):
    """(시작 초, 샘플 목록) 여러 개를 하나로 합친다"""
    buf = [0.0] * int(RATE * total)
    for start, samples in parts:
        o = int(RATE * start)
        for i, s in enumerate(samples):
            if o + i < len(buf):
                buf[o + i] += s
    return buf


def write_wav(path, samples):
    peak = max(abs(s) for s in samples)
    assert peak <= 0.9, f"{path.name}: 소리가 너무 큽니다 ({peak:.2f})"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))


NOTES = {"E5": 659.25, "G5": 783.99, "A4": 440.0, "A5": 880.0, "B5": 987.77, "C5": 523.25, "C6": 1046.5, "D5": 587.33, "E6": 1318.51, "G4": 392.0, "E4": 329.63}


def normalize(samples, peak=0.8):
    """가장 큰 값을 peak로 맞춘다. 부드러운 종소리가 번들 소리보다 너무 작게 들리지 않도록 한다"""
    m = max(abs(x) for x in samples)
    return [x * peak / m for x in samples]


def soft_chime():
    b = lambda f, d=0.5: note(NOTES[f] if isinstance(f, str) else f, d, "bell", 0.5, 7.0)
    sounds = {
        # 올라가는 두 음
        "up": mix([(0.0, b("E5", 0.45)), (0.14, b("B5", 0.5))], 0.65),
        # 내려가는 두 음 (조금 낮고 부드럽게)
        "down": mix([(0.0, b("B5", 0.45)), (0.14, b("E5", 0.5))], 0.65),
        # 맑은 한 번의 종소리와 위의 한 음
        "account": mix([(0.0, b("C6", 0.7)), (0.0, [s * 0.5 for s in b("E6", 0.7)])], 0.7),
        # 같은 음을 세 번 (낮고 길게, 주의를 끌도록 감쇠를 느리게)
        "warn": mix([(i * 0.3, note(NOTES["A5"], 0.34, "bell", 0.55, 4.0)) for i in range(3)] + [(i * 0.3, note(NOTES["A4"], 0.34, "bell", 0.35, 4.0)) for i in range(3)], 1.0),
    }
    return {k: normalize(v) for k, v in sounds.items()}


def retro_beep():
    sq = lambda f, d=0.07: note(NOTES[f], d, "square", 0.28, 0)
    arp = lambda names, step=0.075: mix([(i * step, sq(n)) for i, n in enumerate(names)], step * len(names) + 0.02)
    return {
        "up": arp(["C5", "E5", "G5"]),
        "down": arp(["G5", "E5", "C5"]),
        # 동전 소리처럼 높은 두 음
        "account": mix([(0.0, sq("B5", 0.07)), (0.08, sq("E6", 0.2))], 0.3),
        # 두 음을 번갈아 세 번 (빠르고 거칠게)
        "warn": mix([(i * 0.17 + j * 0.08, sq(f, 0.075)) for i in range(3) for j, f in enumerate(["A5", "E5"])], 0.6),
    }


THEMES = {
    "soft-chime": ("Soft chime", soft_chime),
    "retro-beep": ("Retro beep", retro_beep),
}


def main():
    for slug, (name, build) in THEMES.items():
        d = ROOT / slug
        d.mkdir(parents=True, exist_ok=True)
        sounds = {}
        for kind, samples in build().items():
            p = d / f"{kind}.wav"
            write_wav(p, samples)
            sounds[kind] = {"url": f"{kind}.wav", "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        theme = {"schemaVersion": 1, "name": name, "version": "1", "license": "CC0-1.0", "sounds": sounds}
        (d / "theme.json").write_text(json.dumps(theme, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(slug, {k: (d / f"{k}.wav").stat().st_size for k in sounds})


if __name__ == "__main__":
    main()
