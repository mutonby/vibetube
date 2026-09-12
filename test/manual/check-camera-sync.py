"""Measure the encoded flash/tone alignment produced by camera-sync.cjs."""
import json
import statistics
import struct
import subprocess
import sys

video = sys.argv[1]
frames = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-select_streams', 'v', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', video,
]))['frames']
pixels = subprocess.check_output([
    'ffmpeg', '-v', 'fatal', '-i', video, '-vf', 'scale=1:1',
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
])
flashes = [float(frame['best_effort_timestamp_time'])
           for i, (frame, pixel) in enumerate(zip(frames, pixels))
           if pixel > 150 and (i == 0 or pixels[i - 1] < 150)]
pcm = subprocess.check_output([
    'ffmpeg', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-',
])
samples = struct.unpack('<' + 'f' * (len(pcm) // 4), pcm)
energy = [max(abs(x) for x in samples[i:i + 80]) for i in range(0, len(samples), 80)]
tones = [i * .01 for i, value in enumerate(energy)
         if value > .1 and (i == 0 or energy[i - 1] <= .1)]
assert len(flashes) >= 7 and len(tones) >= 7, 'Missing video flashes or audio tones'
# Exclude partial pulses at the start/end. A 90 ms model delay deliberately
# limits temporal resolution; mean offset detects systematic A/V misalignment.
offsets = [(flash - min(tones, key=lambda tone: abs(tone - flash))) * 1000
           for flash in flashes if .3 < flash < 7.5]
result = {'mean_offset_ms': statistics.mean(offsets), 'offsets_ms': offsets}
print(json.dumps(result))
if '--baseline' not in sys.argv:
    assert abs(result['mean_offset_ms']) < 45, 'Persistent A/V offset'
    assert max(map(abs, offsets)) < 100, 'A/V drift exceeds a processed frame'
