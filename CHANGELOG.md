# Changelog

## [1.1.0](https://github.com/tibzejoker/brAIn-perception/compare/v1.0.0...v1.1.0) (2026-07-08)


### Features

* **demo:** record the real dashboard — expanded node cards in the live graph ([fe69458](https://github.com/tibzejoker/brAIn-perception/commit/fe69458d0ec8d59e8c7f66b5521906864d7f6c7f))
* **media-source:** audible mode — hear the replay through the speakers ([76490c8](https://github.com/tibzejoker/brAIn-perception/commit/76490c8e89de355ff0485cbec6fad8d39e193537))
* **media-source:** file picker backed by a media.browse port ([c812efe](https://github.com/tibzejoker/brAIn-perception/commit/c812efe33ca499c1d6df4fcfe3bf938e3cab0ca4))
* **media-source:** virtual camera + mic node — one UI to play a video into the whole pipeline ([4f2f426](https://github.com/tibzejoker/brAIn-perception/commit/4f2f426bfd1c49fef2a293b94a177245b91a86ef))
* **perception:** media-source appears as a virtual device in gaze + voice UIs ([77330f7](https://github.com/tibzejoker/brAIn-perception/commit/77330f7f26e35440028f3427040efe3cd3a19dba))
* **tts:** speak_replies opt-in — auto-speech is a config choice, not a subscription side effect ([b9c6068](https://github.com/tibzejoker/brAIn-perception/commit/b9c6068531ac87d6ff4ad3edb79f23abe39ed2ed))
* **ui:** collapsible side panels on gaze / voice / intent / media-source ([f14bf0f](https://github.com/tibzejoker/brAIn-perception/commit/f14bf0f4c041fd338ea3f654f5104f788e2f27e1))


### Bug Fixes

* **gaze:** replaying a file after EOF actually restarts the capture ([96dc9b7](https://github.com/tibzejoker/brAIn-perception/commit/96dc9b7c6124e29e7d0c477dec8d3d3e81a12a23))
* **perception:** provisional segments reach the bus and the correlator ([953ed55](https://github.com/tibzejoker/brAIn-perception/commit/953ed55ff80eeadbc75c82d244a5a855444bca7f))
* **seed:** subscribe the brain to brain.input, not brain.* ([ddd2e29](https://github.com/tibzejoker/brAIn-perception/commit/ddd2e29f609a5c8bb59234633bafb8803fd0f682))
* **setup-py:** preflight Python dev headers on Linux/macOS ([6883278](https://github.com/tibzejoker/brAIn-perception/commit/6883278259767716e0daf335ed4a594532ff3686))
* **setup:** completion marker — a half-installed venv no longer wedges the node ([ed89751](https://github.com/tibzejoker/brAIn-perception/commit/ed897519eb6a3df3755547f6fb170dfceb42dee9))
* **voice:** audible mirror survives audio-device changes + status diagnostics ([bc5b3f4](https://github.com/tibzejoker/brAIn-perception/commit/bc5b3f431d2ed051bcd2dc24f4b479c834b7f528))
* **voice:** restart capture without dropping the loaded engine ([37ba211](https://github.com/tibzejoker/brAIn-perception/commit/37ba2112daa2b7f1369f27b4ee1565fba306d29f))


### Performance Improvements

* **gaze:** load Moondream lazily, on first describe use only ([78ad908](https://github.com/tibzejoker/brAIn-perception/commit/78ad908e0484626f6db4d9db0df44ba04e60d5cf))

## 1.0.0 (2026-07-03)


### Features

* initial extraction from brAIn monorepo ([c67f18d](https://github.com/tibzejoker/brAIn-perception/commit/c67f18dd6e54412192d759748064e5d724fa2648))
* **skills:** bundle ambient-presence + operate-tts skills ([#15](https://github.com/tibzejoker/brAIn-perception/issues/15)) ([cf8a37d](https://github.com/tibzejoker/brAIn-perception/commit/cf8a37d1634c6792b08690136b8be6b732ed7c46))
* **tts:** cross-platform text-to-speech node with UI ([b0fba41](https://github.com/tibzejoker/brAIn-perception/commit/b0fba411474f62a974e0e25407e4f60310eb1d6d))
* video-file demo mode, intent.addressed conversation delta, Kokoro TTS ([8fc0b18](https://github.com/tibzejoker/brAIn-perception/commit/8fc0b188368cd05e7c52b8f8918718d97421f734))
* **voice,gaze:** auto-run setup-py.mjs on first spawn if the venv is missing ([1720cdd](https://github.com/tibzejoker/brAIn-perception/commit/1720cdd802ae946204024bd41c652734504bfeb4))
* **voice,gaze:** lazy-load + unload ML weights around capture sessions ([ac847cf](https://github.com/tibzejoker/brAIn-perception/commit/ac847cfe4a7a83f6413cc395feef25c6abf3c7ef))
* **voice:** per-segment timing summary line ([47f6b6c](https://github.com/tibzejoker/brAIn-perception/commit/47f6b6c7c42bb952d363c63f552031cec5b82f86))
* **voice:** pluggable STT backend (auto-pick mlx on Apple Silicon) ([76b2731](https://github.com/tibzejoker/brAIn-perception/commit/76b273111d5446f96b4895dac47fa91d75fcdd09))
* **voice:** runtime language selector + UI dropdown ([8841378](https://github.com/tibzejoker/brAIn-perception/commit/8841378f92d069ea77fc1fae9ac5732d290a9008))


### Bug Fixes

* add description to default_subscriptions on voice, gaze, intent ([836c3aa](https://github.com/tibzejoker/brAIn-perception/commit/836c3aa58268f8398a89a2206490574075e5e459))
* **gaze:** reorder setup_models so the cheap face_landmarker download runs first ([0a26fff](https://github.com/tibzejoker/brAIn-perception/commit/0a26fff464f456e4f9e476a961012fd89fb17f11))
* **intent:** resolve intent.db from the framework data root ([#11](https://github.com/tibzejoker/brAIn-perception/issues/11)) ([237c8cd](https://github.com/tibzejoker/brAIn-perception/commit/237c8cd3dc3ce1eaef6d774654aef4d7c919af92))
* migrate tts UI to /node/:id/:topic ([#12](https://github.com/tibzejoker/brAIn-perception/issues/12)) ([3599fd8](https://github.com/tibzejoker/brAIn-perception/commit/3599fd8635495ecd07c44e8ffc133d7aa1ee6af1))
* **tts:** only speak when the message is targeted at this instance ([#13](https://github.com/tibzejoker/brAIn-perception/issues/13)) ([19e440a](https://github.com/tibzejoker/brAIn-perception/commit/19e440abbf9d82c99765cd952b9533932fa60ab9))
* **voice-ui:** auto-open events WS when capture is already running ([1807894](https://github.com/tibzejoker/brAIn-perception/commit/180789492808ac5ee22206062200113fe7ab9b2e))
* **voice,gaze:** add @types/node devDep so packages build standalone ([de743b7](https://github.com/tibzejoker/brAIn-perception/commit/de743b745003ecc55eb8d42e14fc1ab5ab186d07))
* **voice,gaze:** bump startup timeouts so cold ML loads don't get killed ([2a98dc8](https://github.com/tibzejoker/brAIn-perception/commit/2a98dc8dd681802a89d8c0216471eb9d816f026a))
* **voice:** anti-hallucination thresholds + parallel STT default 2 ([093bacb](https://github.com/tibzejoker/brAIn-perception/commit/093bacbf242fe87889c4bec62dedac9608dfd7a9))
* **voice:** eager MLX warmup at engine init ([5c4ec7c](https://github.com/tibzejoker/brAIn-perception/commit/5c4ec7c62ee74172bc4a2b4bc687c134237559e8))
* **voice:** force task='transcribe' so language swap doesn't translate ([d120db3](https://github.com/tibzejoker/brAIn-perception/commit/d120db37d8d06653108b1635bcc53e91621fb3df))
