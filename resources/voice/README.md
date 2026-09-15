# Offline speech recognition

HelloDog uses the CPU-only whisper.cpp v1.9.2 Windows x64 runtime and multilingual Whisper base model. Neither requires an OpenAI account, key, or network request. Only reviewed transcript text enters the existing authenticated translation and character-billing flow.

Sources:
- https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2
- https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-base.bin

The upstream Windows archive SHA256 is `49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a`.
The model SHA256 is `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`.

Place only the files listed in `manifest.json` into `bin/`. The manifest is embedded in the application bundle, checked before packaging and checked for each local recognition job. Runtime/model binaries are intentionally not stored in Git. The packaged application includes both MIT licenses in `voice-notices/`.

Audio is decoded to canonical 16 kHz mono PCM in the owning renderer. Main accepts no arbitrary URLs or filesystem paths, validates length/header/silence, runs one hidden bounded CPU job, and removes its generated temporary directory afterwards. Recognition output requires review before a translation is requested. Low-quality speech and automatic language detection may still require manual correction.

Direct WhatsApp/Signal compatibility-mode buttons require provable media ownership. An external player whose audio cannot be associated with the current message is not guessed: save the audio and use **Records and recovery → Quick actions → Translate an audio file**. This file path also covers native Signal Desktop without weakening its isolated bridge.
