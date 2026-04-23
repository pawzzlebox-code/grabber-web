#!/usr/bin/env python3
"""
Convert WhisperX diarized JSON into a styled SRT where the main speaker
(person with the most talk-time) is wrapped in <b>...</b> and every other
speaker is wrapped in <i>...</i>. Grabber's subtitle renderer honors both
tags: bold for the main speaker, italic for the interviewer.

Usage:
  pip install whisperx   # once

  whisperx video.mp4 \\
    --model large-v3 \\
    --diarize \\
    --hf_token hf_YOUR_TOKEN \\
    --output_format json \\
    --language en \\
    --task translate        # drop for same-language transcripts

  python style_srt.py video.json video.srt
"""
import json
import sys
from collections import defaultdict


def fmt_ts(t: float) -> str:
    h, rem = divmod(int(t), 3600)
    m, s = divmod(rem, 60)
    ms = int((t - int(t)) * 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def main():
    if len(sys.argv) != 3:
        print("usage: style_srt.py <whisperx.json> <out.srt>")
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    segments = data.get("segments", [])
    if not segments:
        print("no segments in input", file=sys.stderr)
        sys.exit(1)

    # Sum talk-time per speaker — who holds the floor the most = main speaker.
    talk_time: dict[str, float] = defaultdict(float)
    for seg in segments:
        spk = seg.get("speaker", "SPEAKER_UNK")
        talk_time[spk] += float(seg["end"]) - float(seg["start"])
    main = max(talk_time, key=talk_time.get)

    with open(sys.argv[2], "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            spk = seg.get("speaker", "SPEAKER_UNK")
            text = seg["text"].strip()
            if not text:
                continue
            styled = f"<b>{text}</b>" if spk == main else f"<i>{text}</i>"
            f.write(f"{i}\n{fmt_ts(seg['start'])} --> {fmt_ts(seg['end'])}\n{styled}\n\n")

    print(f"Main speaker (bold): {main} ({talk_time[main]:.0f}s)")
    for s, t in sorted(talk_time.items(), key=lambda kv: -kv[1]):
        if s != main:
            print(f"  Italic: {s} ({t:.0f}s)")


if __name__ == "__main__":
    main()
