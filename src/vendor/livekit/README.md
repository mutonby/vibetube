# Camera effects: unmodified LiveKit

VibeTube uses `@livekit/track-processors` **0.8.0**, with its default
MediaPipe Tasks Vision **0.10.14** runtime and binary selfie segmenter.
LiveKit owns the model, shaders, antialiasing, blur and frame scheduling. There
are no application-specific hair/chair classifiers or mask refinements.

`npm run build:camera` bundles the installed package with esbuild and copies its
matching WASM runtime. `assets.json` records versions and SHA-256 hashes. No
upstream source or shader is patched. Keep the package lockfile with the bundle.

The model is Google's versioned default LiveKit model:

https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite

SHA-256: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`.

All assets load locally. Camera frames are not sent to LiveKit or another
service, and no LiveKit room/account/server is needed. The app adapter clones
the input track, preserves audio, and waits out the SDK's first raw warm-up
frame before displaying the processed stream. The floating preview reuses
LiveKit's output canvas. Changes of background and intensity use the SDK API.

This model is not an explicit chair detector. It retained the visible backrest
in the tested seated clips, but neither full-chair retention nor artifact-free
segmentation is guaranteed. Low light, motion and background objects still
require visual validation; FPS is not a segmentation accuracy metric.

Sources and licenses:

- https://github.com/livekit/track-processors-js (Apache-2.0).
- https://github.com/google-ai-edge/mediapipe (Apache-2.0).
- `THIRD-PARTY-NOTICES.txt` contains bundled third-party licenses and notices.
- `LICENSE-APACHE-2.0.txt` contains the Apache license text.

Validation: `npm run test:camera` checks lifecycle/mode switching/crop with a
synthetic video, and `test/manual/camera-replay.cjs` records a local sample through
the production adapter while checking the floating preview and blocking HTTP.
