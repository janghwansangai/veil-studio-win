# Veil Studio — Windows 얼굴·영역 마스킹 편집기

macOS용 Veil Studio 0.7(SwiftUI·AVFoundation·Vision·Core Image·Apple Speech)을 **Windows 10(1903 이상)/11 x64**용으로 옮기고, Windows에 맞게 처리 방식을 최적화한 버전입니다. 제작자: **다있쌤 로디**

영상·이미지·음성은 서버로 보내지 않고 이 PC에서만 처리하며, 원본 대신 새 파일을 내보냅니다. 기능·화면 구성·프로젝트 형식(`.veilproject`)은 macOS 버전과 같습니다.

## 실행

| 방법 | 위치 |
| --- | --- |
| 설치 파일 (권장) | [릴리스 v0.7.0](https://github.com/janghwansangai/veil-studio-win/releases/tag/v0.7.0)에서 `VeilStudio-Setup-0.7.0.exe` 내려받기 — 설치 위치 선택, 시작 메뉴/바탕화면 바로가기, `.veilproject` 연결 |
| 직접 빌드한 설치 파일 | `npm run dist` 실행 후 `dist/VeilStudio-Setup-0.7.0.exe` |
| 설치 없이 실행 | `dist/win-unpacked/VeilStudio.exe` (폴더째 복사해도 동작) |
| 개발 모드 | `npm install` 후 `npm start` |

코드 서명을 하지 않았기 때문에 처음 실행할 때 SmartScreen 경고가 나올 수 있습니다(**추가 정보 → 실행**). Visual C++ 런타임과 CUDA 런타임 DLL을 앱에 포함했으므로 별도 설치가 필요 없습니다.

사용 순서: **미디어 불러오기**(Ctrl+O·드래그 앤 드롭, 여러 파일 한 번에 가능) → **얼굴 분석** → 후보 선택 → **마스킹 적용** → 디자인 조절 → **내보내기**(Ctrl+E).

얼굴 분석·자동 자막·배경음악 제거·내보내기·미리보기 사본은 모두 **백그라운드 작업**으로 실행됩니다. 작업 중에도 재생·편집·자막 수정이 가능하며, 아래 상태 표시줄에서 진행률을 보고 ✕로 취소합니다.

## 처리 방식 (Windows 최적화)

| 기능 | macOS 원본 | Windows 버전 |
| --- | --- | --- |
| 얼굴 검출 | Vision | **YuNet**(ONNX Runtime) — 전체 화면 1회 + 작은 얼굴용 겹치는 타일, 다음 프레임 전처리와 현재 프레임 추론을 겹쳐 실행 |
| 인물 후보 묶기 | Vision 이미지 특징 | **SFace** 얼굴 특징(5점 정렬) + 위치 연속성. 신원 확인용이 아니라 후보 묶기 보조용 |
| 자동 자막 | Apple Speech / whisper base | **whisper.cpp + large-v3-turbo**, NVIDIA GPU(CUDA) 자동 사용, **Silero VAD**로 음악·무음 구간 제외, 남은 구간을 한 번에 인식(20초 조각 분할 제거) |
| 배경음악 제거 | 없음 | **UVR-MDX-NET-Voc_FT**(ONNX Runtime·DirectML GPU)로 목소리만 분리한 뒤 인식. 기본값 "자동"은 GPU가 있을 때만 사용, 켬/끔 선택 가능 |
| 무거운 작업 | 메인 스레드 | 작업마다 별도 Web Worker에서 실행 → 편집 화면이 멈추지 않음 |
| 영상 읽기·쓰기 | AVFoundation | 내장 ffmpeg 6.1. 프레임을 **YUV 4:2:0 그대로** 전달하고, 마스크·자막이 있는 사각형만 RGB로 변환해 그림(나머지 픽셀은 원본 그대로 유지) |
| 인코더 | AVAssetExportSession | H.264: x264(8코어 이상) / GPU(8코어 미만). **HEVC: NVIDIA NVENC → AMD AMF → Intel QSV** 순으로 자동 선택, 실패 시 소프트웨어로 자동 재시도 |
| 마스크 효과 | Core Image | Canvas 2D. 강한 블러는 축소 해상도에서 계산 후 확대(화질 동일, 계산량 감소) |
| 화면 | SwiftUI | Electron 44 + Preact |

### 이 PC(i9-11900H 8코어 · RTX 3060 Laptop)에서 측정한 값

| 항목 | 이전 Windows 버전 | 현재 |
| --- | --- | --- |
| 한국어 자막 (80초, 배경음악) | base: 음악 구간 헛인식, 잡음 시 글자 오류율 10–16% | turbo+GPU: **1.3–2.3초**, 오류율 **0–2%**, 음악 구간 헛인식 없음 |
| 얼굴 분석 1080p | 15 fps (960px, 타일 없음) | 정밀 **16 fps(1920px+타일)** · 표준 25 fps · 빠름 86 fps |
| 작은 얼굴 검출 (실제 얼굴 24개, 24–96px) | — | 사진 **22/24**, 1080p 영상(정밀) **17/24**, 오탐 0 |
| 1080p 내보내기 (작은 얼굴 모자이크 3개+자막) | 약 30 fps | **약 70 fps** |
| 1080p 내보내기 (마스크 없는 구간) | 약 30 fps | **약 77 fps 이상** |
| HEVC 인코딩 | x265 약 52 fps | NVENC 약 260 fps (인코더 단독) |
| 한국어 자막 + **강한 배경음악**(음성보다 2.5배 큰 음악) | turbo 오류율 75% | 배경음악 제거 후 **1.1%** (26초 음성 분리 GPU 6.7초 / CPU 29초) |
| 한국어 자막 + 음악 4배 | 95.5% | **2.3%** (음악이 약할 때는 분리 여부와 관계없이 동일) |
| 분석 중 편집 화면 반응 | 분석이 끝날 때까지 멈춤 | 화면 지연 최대 **1 ms**(측정), 분석 중 분할·재생·자막 편집 가능 |

GPU 사용에 대한 실측 결론: **자막(Whisper)은 GPU가 CPU보다 10–15배 빠릅니다.** 얼굴 검출(YuNet)은 모델이 매우 작아 GPU(DirectML)로 보내는 비용이 더 커서 CPU가 더 빠르므로 기본값은 CPU입니다(설정에서 GPU 선택 가능, 여러 그래픽카드 중 가장 빠른 것을 자동 선택). H.264 인코딩도 8코어 CPU의 x264가 NVENC보다 빨랐고, GPU 디코딩은 이 경로에서 CPU보다 느렸습니다. 미리보기 재생·합성은 Chromium을 통해 GPU를 사용합니다.

### 한국어가 영어로 나오던 문제

원인은 작은 base 모델이 배경음·잡음이 있는 구간에서 무너지며, 한국어로 지정해도 영어 비슷한 글자나 엉뚱한 문장을 만들어낸 것이었습니다(깨끗한 음성은 base도 한국어로 인식). 조치:
- 한국어에 강한 **large-v3-turbo**를 기본 모델로 사용(속도 우선 base도 선택 가능)
- **VAD**로 음성 구간만 인식해 음악·무음에서 생기는 헛인식 제거
- 20초 조각으로 잘라 인식하던 방식을 없애고 남은 구간 전체를 Whisper의 문맥 창으로 인식
- 한국어 설정에서 한글이 없는 영어 결과는 "검토할 구간"에 표시
- 실험 결과 잡음 제거 필터와 한국어 유도 문구는 오히려 정확도를 낮춰 적용하지 않았습니다.

### 배경음악 때문에 자막이 안 나오는 경우

자막 편집 → **배경음악**에서 선택합니다. "자동"은 GPU(DirectML)가 있으면 음악을 걷어낸 목소리로 인식하고, GPU가 없으면 느려지지 않도록 건너뜁니다. 음악이 큰 영상인데 GPU가 없다면 "켬"을 선택하세요(CPU로 음성 1분당 약 1분). 원본 오디오와 내보내기 결과는 바뀌지 않으며, 분리한 목소리는 인식에만 쓰고 삭제합니다.

## 여러 파일 편집 · 파이널 컷 방식 기본 편집

- **미디어** 탭: 프로젝트에 들어간 영상·사진 목록. 여러 파일을 한 번에 불러오거나 창에 끌어다 놓으면 순서대로 이어 붙습니다. 목록의 파일을 타임라인으로 끌어다 놓으면 가까운 컷 사이에 삽입(위 트랙이면 그 위치에 연결)됩니다.
- 해상도·비율이 다른 파일은 첫 파일(★) 화면에 맞춰 **레터박스**로 들어가고, 사진은 5초 컷으로 들어갑니다. 얼굴 분석·자동 자막은 파일마다 따로 처리되어 해당 컷에만 적용됩니다.
- 복사한 컷(다른 파일의 컷 포함)은 재생 위치의 컷 사이에 붙여 넣습니다(Ctrl+C → Ctrl+V).
- **클립 속성**(오른쪽 패널): 볼륨(dB)·컷 음소거·페이드 인/아웃·밝기·대비·채도·컷 사용 안 함. 여러 컷을 Ctrl+클릭으로 골라 한 번에 바꿀 수 있고 내보내기에도 그대로 반영됩니다.
- 타임라인: 확대/축소(Ctrl+휠, Ctrl+=/−, Shift+Z 전체), 스냅(N), 마커(M, 우클릭으로 삭제), 트림 핸들·드래그 시 편집점·마커·재생 위치에 붙음.

| 단축키 | 동작 | 단축키 | 동작 |
| --- | --- | --- | --- |
| Space | 재생/정지 | J / K / L | 뒤로 재생 / 정지 / 앞으로 재생(반복 시 2×·4×) |
| ← / → | 1프레임 이동 | Shift+← / → | 10프레임 이동 |
| ↑ / ↓ | 이전/다음 편집점 | Home / End | 처음 / 끝 |
| Ctrl+B | 재생 위치에서 분할 | M | 마커 추가 |
| E | 선택한 미디어를 끝에 추가 | W | 재생 위치에 삽입 |
| Q | 위 트랙에 연결 | V | 컷 사용/사용 안 함 |
| Delete | 삭제 후 붙이기 | Shift+Delete | 빈 구간 남기고 삭제 |
| Alt+[ / Alt+] | 컷 시작/끝을 재생 위치로 자르기 | I / O | 내보내기 구간 시작/끝 |
| Ctrl+I | 미디어 가져오기(프로젝트에 추가) | Ctrl+N | 새 프로젝트 |

## 안정성

- Windows 사용자 이름·폴더가 **한글**이어도 동작: whisper-cli가 한글 경로를 잘못 읽는 문제를 실행 파일 매니페스트(UTF-8 코드 페이지)와 ASCII 작업 폴더로 해결하고, ffmpeg·ONNX Runtime도 한글 경로에서 검증
- 편집 화면이 비정상 종료되거나 응답이 없을 때 다시 열기/기다리기/강제 종료 선택, 자동 복구 파일 유지
- 화면 그리기 오류가 생겨도 창 전체가 멈추지 않도록 오류 경계와 "다른 이름으로 저장" 제공
- 예기치 않은 오류는 편집을 계속할 수 있게 안내하고 `%APPDATA%\Veil Studio\logs\veil.log`에 기록
- GPU 인식·하드웨어 인코딩 실패 시 CPU·소프트웨어로 자동 재시도, 처리 제한 시간은 영상 길이에 비례
- 취소·오류 시 외부 프로세스가 끝난 뒤 임시 파일 정리(파일 잠금 대기), 출력 파일이 다른 프로그램에서 열려 있으면 안내
- 자동 복구 저장을 비동기로 바꿔 큰 프로젝트에서도 편집이 멈추지 않음
- 창 밖에서 마우스를 놓아도 드래그가 끝나도록 처리, 편집 화면이 멈춰도 창을 닫을 수 있음
- 한국어 ANSI(CP949/EUC-KR) SRT 자막 가져오기
- 백그라운드 작업은 시작 시점의 프로젝트 사본으로 실행하고, 끝났을 때 같은 프로젝트일 때만 결과를 반영합니다. 인식 중에 자막을 고쳤다면 **교체/뒤에 추가/버리기**를 묻습니다. 작업 중 창을 닫거나 다른 파일을 열면 작업 취소 여부를 먼저 묻습니다.
- 작업 프로세스가 취소에 응답하지 않으면 8초 뒤 강제 종료, 작업 오류는 화면에 안내하고 로그에 기록
- 타임라인에 쓰인 모든 파일이 분석 이후 바뀌지 않았는지 확인한 뒤 분석·내보내기, 원본(모든 파일) 덮어쓰기 차단
- 키를 누르고 있어도 V·M·N 같은 전환 명령은 한 번만 실행

## macOS 버전과 다른 점

- Apple 음성 인식은 없고 Whisper(기기 내)만 사용합니다. 음성은 네트워크로 전송하지 않습니다.
- 입력 형식이 넓습니다(내장 ffmpeg: MKV·WebM·AVI 등). 미리보기 재생이 안 되는 코덱(ProRes 등)은 H.264 미리보기 사본을 자동으로 만듭니다.
- 이미지 출력은 PNG/JPEG/TIFF(HEIC 출력 없음). 타일로 나뉜 HEIC 사진은 JPEG/PNG로 변환해 여세요.
- macOS에서 저장한 `.veilproject`는 원본 경로가 달라 **원본 찾기…**로 같은 파일을 지정하면 다시 연결됩니다.
- 얼굴 검출 모델이 다르므로 결과가 Vision과 다릅니다. 실제 아이들 영상에서의 누락률은 측정하지 않았습니다. **출력 전 반드시 검토하고 수동 영역으로 보완하세요.**

## 폴더 구성

```
src/main/main.js           메인 프로세스: 창·메뉴·대화상자·닫기 확인·충돌 복구·로그
src/renderer/lib/model.js  프로젝트 모델·타임라인·SRT·검증 (Models.swift + Timeline.swift)
src/renderer/lib/store.js  편집 상태·실행 취소·미리보기 재생·파일 (EditorStore.swift)
src/renderer/lib/media.js  ffmpeg 읽기·파형·프록시·내보내기·인코더 선택
src/renderer/lib/yuv.js    내보내기용 YUV↔RGB 부분 변환
src/renderer/lib/render.js 마스크·크롭·자막 그리기
src/renderer/lib/faces.js  YuNet/SFace 얼굴 분석·후보 추적
src/renderer/lib/speech.js Whisper 자막 (GPU·VAD·한글 경로 대응, 파일별 인식)
src/renderer/lib/separate.js 배경음악 제거 (UVR MDX, STFT/iSTFT)
src/renderer/lib/fft.js    혼합 기수 FFT (7680점 STFT용)
src/renderer/lib/onnx.js   ONNX Runtime 세션·DirectML 어댑터 선택
src/renderer/lib/jobs.js   백그라운드 작업 관리 (Web Worker, 진행률·취소)
src/renderer/worker.js     작업 실행기 (얼굴·자막·내보내기·파형·미리보기 사본)
src/renderer/ui/           화면 (미디어 목록·타임라인·클립 속성·자막/얼굴 패널)
resources/speech/bin       whisper-cli(UTF-8 매니페스트 적용)·CUDA/CPU 백엔드·VC++ 런타임
resources/speech/models    large-v3-turbo(q5_0)·base·Silero VAD
resources/face             YuNet·SFace ONNX 모델
resources/separation       UVR-MDX-NET-Voc_FT ONNX 모델
resources/vcruntime        앱 폴더에 함께 설치되는 VC++ 런타임
scripts/utf8-manifest.cjs  whisper-cli 매니페스트를 UTF-8 코드 페이지로 바꾸는 스크립트
```

## 빌드·검증

저장소를 막 받았다면 모델·실행 파일부터 내려받아야 합니다(합계 약 1.5GB, 용량이 커서 저장소에는 없습니다).

```bash
npm install
npm run fetch-resources   # 모델·whisper 실행 파일 내려받기 + SHA-256 검증 (자세한 내용은 resources/README.md)
npm test            # 모델·타임라인·FFT 단위 테스트 13개
npm run selftest    # 실제 앱을 띄워 끝까지 검증 (결과: %TEMP%\veil-selftest.log / .json)
npm run dist        # dist\VeilStudio-Setup-0.7.0.exe 생성
```

whisper.cpp를 새로 받으면 `npm run patch-whisper`로 매니페스트를 다시 적용하세요. 성능 측정은 `VEIL_BENCH=1`을 설정하고 selftest를 실행하면 로그에 기록됩니다.

마지막 검증(2026-09-25): 단위 테스트 13/13, selftest **131/131**(개발 모드). 한국어 음성+배경음악 인식(배경음악 제거 포함, 오류율 0%, 음악 구간 자막 없음), GPU 사용 확인, 얼굴 검출→마스크 픽셀, 움직이는 얼굴 추적, 내보내기 픽셀·오디오·크롭·HEVC(NVENC)·다중 트랙·취소 정리, **여러 파일 이어 붙이기·레터박스·사진 컷·삽입/연결/붙여넣기, 백그라운드 분석 중 편집·취소, 마스킹 적용 버튼 위치, J/K/L·프레임·편집점·마커·트림·빈 구간 삭제·페이드·컷 사용 안 함 내보내기**, 실제 UI 조작을 포함합니다. 한국어 음성은 Windows 음성 합성(Heami)으로 만든 테스트 음성이며, 실제 사람 목소리·아이 목소리·겹친 대화의 정확도는 측정하지 않았습니다.

## 라이선스·출처

- ffmpeg 6.1.1 (gyan.dev essentials, **GPL v3** 빌드) — 앱을 외부에 배포하면 GPL 고지·소스 제공 의무를 확인하세요.
- whisper.cpp b5130 (MIT), Whisper large-v3-turbo·base 모델 (MIT), Silero VAD (MIT) — `resources/speech/PROVENANCE.txt`
- YuNet (MIT), SFace (Apache-2.0) — OpenCV Zoo. ONNX Runtime·DirectML (MIT)
- UVR-MDX-NET-Voc_FT — Ultimate Vocal Remover (Anjok07 & aufr33), MIT
- NVIDIA CUDA 런타임·cuBLAS (NVIDIA CUDA EULA의 재배포 허용 파일), Microsoft Visual C++ 런타임 (재배포 가능 파일)
- Electron (MIT), Preact/htm (MIT)

## 프로젝트와 개인정보

원본은 프로젝트 파일에 포함되지 않습니다. 사용한 모든 파일의 경로·크기·수정 시각을 저장하고 원본이 바뀌면 재분석을 요구합니다. 자동 복구 파일(`%APPDATA%\VeilStudio\Recovery.veilproject`)과 프로젝트 파일에는 **원본 경로·얼굴 썸네일·분석 좌표·자막**이 들어 있으므로 작업 후 직접 관리하세요. 출력 파일에는 원본 EXIF/GPS 메타데이터를 복사하지 않습니다.
