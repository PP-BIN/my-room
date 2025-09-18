작은 한 화면에서 미니어처 방을 만들고 가구를 배치하는 웹 앱입니다.
react-three-fiber + drei + three.js로 구현했고, 카메라 회전/휠줌 없이 “팬(이동)만” 지원합니다.

주요 기능

아이템 배치

가구: bed, desk, dresser, chair, tv, rug, lamp, plant, trash

벽걸이: window, frame, mirror → 항상 보이는 앞면(앞벽/왼벽)에 스냅

조작 방식

드래그로 배치, 화면 하단 버튼 패드로 미세 이동/회전/스케일

그리드 스냅(Fine/Med/Coarse) 및 라벨 토글, 도움말 토글

상단 UI로만 줌 값 조절(휠 줌 비활성)

스택(올려놓기)

tv / plant / lamp / trash는 desk / dresser 상판에 자동 스냅(지지대가 회전/스케일되어도 정확)

방 형태

바닥·왼벽·뒤벽만 보이는 3인칭 고정 시점

방 크기는 기본 6m × 6m × 3m, 작업 구역 밖은 렌더/드래그 불가

겹침 허용

아이템 충돌 체크 없음 → 자유롭게 겹쳐 배치 가능

테마

바닥/벽 색상 테마(palette) 선택 가능

기술 스택

Next.js (App Router, Client Components)

React 18 + TypeScript

three.js

@react-three/fiber, @react-three/drei

빠른 시작
# 의존성 설치
npm i
# 개발 서버
npm run dev
# 브라우저에서 http://localhost:3000


권장 환경: Node.js 18+.

사용법 (핵심)

오른쪽 ITEMS에서 아이템을 추가

아이템 클릭 → 선택/드래그

하단 패드:

화살표 = 이동, 회전 = ⟳/⟲, 스케일 = ＋/－

벽걸이는 Wall: Back/Left로 전환 가능(Inspector)

작은 오브젝트는 책상/서랍 상판에 올려놓기 자동 스냅

화면 이동(팬): 마우스 드래그(회전/휠줌은 비활성)

커스터마이징 포인트

방 크기: ROOM.halfX/halfZ/height

테마: THEMES 배열

스택 규칙: SUPPORT_TYPES, STACKABLE_TYPES, supportTopSpec()

아이템 추가: ItemType 확장 + ItemMesh 스위치에 메쉬 컴포넌트 추가

벽 스냅 위치: FRONT.*, snapToWall()

그리드/스텝: stepPreset별 값

디렉터리/구성

app/page.tsx

렌더/상태/조작/메쉬가 한 파일에 정리된 단일 페이지 샘플

주요 섹션: SceneCamera(팬 전용), SceneRoom(방), DragCatchers(드래그 평면), ItemNode(애니메이션), ItemMesh(메쉬 라이브러리), Inspector/Shelf(UI)

알려진 제한

새로고침 시 배치가 저장되지 않음(로컬 스토리지/URL 공유는 추후 확장 지점)

충돌/물리 없음(의도적으로 겹침 허용)

텍스처/머티리얼은 데모용 단색(필요 시 PBR로 확장 권장)
