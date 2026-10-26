#!/usr/bin/env python3
# Makes herdr's two chimes and the Mac's alert sound (python3 synth.py, needs ffmpeg). Each
# note is a sum of decaying sine partials shaped like a marimba bar (overtones at 4x and 10x).
#   done.mp3     one warm marimba note, A4: registers, then gets out of the way
#   request.mp3  "Lilac": two quick notes falling a fourth, E6 to B5, a gentle "uh-oh" when
#                an agent needs me. The same sound is the Mac's alert (home/Library/Sounds),
#                so anything asking for me sounds alike.
# The chimes peak at -14 dB, calm next to other sounds; the alert at -12 dB.
import subprocess, sys
MARIMBA = [(1.0, 1.0, 1.0), (4.0, 0.16, 0.30), (10.0, 0.03, 0.08)]          # ratio, amp, decay factor
def render(out, notes, peak_db=-14, codec=("-b:a", "128k")):
    inputs, chains, labels, n = [], [], [], 0
    for (freq, start, decay, timbre, gain) in notes:
        for ratio, amp, dfac in timbre:
            i = n; n += 1; d = decay * dfac
            inputs += ["-f", "lavfi", "-i", f"sine=f={freq*ratio:.2f}:d={d+0.05:.3f}"]
            ms = int(start * 1000)
            chains.append(f"[{i}]volume={amp*gain:.4f},afade=t=in:d=0.012,afade=t=out:st=0:d={d:.3f}:curve=exp,adelay={ms}|{ms}[n{i}]")
            labels.append(f"[n{i}]")
    graph = ";".join(chains) + ";" + "".join(labels) + f"amix=inputs={len(labels)}:normalize=0[out]"
    wav = out + ".wav"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[out]", "-ac", "1", "-ar", "44100", wav], check=True)
    probe = subprocess.run(["ffmpeg", "-i", wav, "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
    peak = float(probe.split("max_volume: ")[1].split(" dB")[0])
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-af", f"volume={peak_db - peak:.2f}dB", "-ac", "1", *codec, out], check=True)
    import os; os.remove(wav)
A4, B5, E6 = 440.0, 987.77, 1318.51
here = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
LILAC = [(E6, 0.0, 0.35, MARIMBA, 0.9), (B5, 0.11, 0.6, MARIMBA, 1.0)]
render(f"{here}/done.mp3", [(A4, 0.0, 0.9, MARIMBA, 1.0)])
render(f"{here}/request.mp3", LILAC)
render(f"{here}/../../../Library/Sounds/Lilac.aiff", LILAC, peak_db=-12, codec=())
