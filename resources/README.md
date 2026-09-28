# resources — 내려받아야 하는 파일

모델과 실행 파일은 용량이 커서(합계 약 1.5GB, GitHub는 파일당 100MB 제한) 저장소에 넣지 않았습니다.
아래 명령 한 줄이면 모두 제자리에 내려받습니다.

```bash
npm run fetch-resources
```

받은 파일은 SHA-256으로 검증하며, 이미 있는 파일은 건너뜁니다. whisper 압축 파일을 새로 받으면
`npm run patch-whisper`로 한글 경로용 UTF-8 매니페스트를 다시 적용하세요(위 명령이 자동으로 실행합니다).

직접 받으려면 각 폴더의 `PROVENANCE.txt`에 주소와 해시가 있습니다.

| 폴더 | 내용 | 출처·라이선스 |
| --- | --- | --- |
| `speech/bin` | whisper-cli.exe, ggml/CUDA DLL, VC++ 런타임 | whisper.cpp b5130 (MIT), NVIDIA CUDA 재배포 파일, Microsoft VC++ 재배포 파일 |
| `speech/models` | large-v3-turbo(q5_0), base, Silero VAD | Whisper (MIT), Silero VAD (MIT) |
| `face` | YuNet, SFace ONNX | OpenCV Zoo — YuNet (MIT), SFace (Apache-2.0) |
| `separation` | UVR-MDX-NET-Voc_FT | Ultimate Vocal Remover (Anjok07 & aufr33), MIT |
| `vcruntime` | 앱 폴더에 함께 설치되는 VC++ 런타임 | Microsoft 재배포 파일 |

`vcruntime` 폴더의 DLL은 `speech/bin`에 받은 같은 이름 파일을 복사해 채웁니다(스크립트가 처리).

내려받은 파일은 각자의 라이선스를 따릅니다. 배포할 때는 저장소 최상위 README의 "라이선스·출처"를 확인하세요.
