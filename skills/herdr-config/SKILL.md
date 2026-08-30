---
name: herdr-config
description: 현재 프로젝트의 herdr-delegator config를 관찰·이해·수정하는 도구. 이 cwd가 바라보는 config 레이어가 어디이고 유효값이 어느 파일에서 오는지 조회하고, 각 필드가 어떤 문서에 언제 반영되는지 설명하고, 검증·미리보기를 거쳐 안전하게 고친다. 사용자가 "delegator 설정 확인", "라우팅 추가", "프로필 지침 수정", "왜 이렇게 동작하지"를 물을 때 사용.
---

# herdr-config (v0)

이 스킬은 지금 이 프로젝트의 config만 다룬다. 설치는 README, 트랙 운용은 herdr-delegation, 설계 원론은 ARCHITECTURE의 영토다.

## 어디에 — 레이어 관찰 (첫 동작은 문서 읽기가 아니라 조회다)

1. 이 cwd에서 실제로 해석되는 레이어를 읽는다: `$PI_CODING_AGENT_DIR`가 설정되면 그 아래 `herdr-delegator.json`, 아니면 user `~/.omp/agent/herdr-delegator.json` ← project `<repo>/.omp/herdr-delegator.json` ← 선택적인 run `<run>/herdr-delegator.json`.
2. 유효 config를 합성하고 출처를 merge 좌표에 맞춰 표시한다: `orchestrator`는 필드별 출처, `worker_profiles`는 프로필 이름 안의 필드별 출처, `skill_routing`과 `storage`는 객체 전체의 출처를 표시한다.
3. merge 의미는 좌표마다 다르다: `orchestrator`는 필드 단위로 합쳐지고, `worker_profiles`는 프로필 이름 단위로 대응한 뒤 같은 이름 안에서는 필드 단위로 합쳐져 뒤 레이어가 선언하지 않은 필드는 살아남으며 다른 이름 프로필도 살아남고, `skill_routing`과 `storage`는 뒤 레이어가 선언하면 객체 전체가 교체된다.
4. 따라서 project 레이어가 `skill_routing`을 선언하면 그 cwd에서는 user 레이어의 라우팅 전체를 교체한다. 누락된 user 규칙이 자동으로 보존된다고 가정하지 않는다.
5. 파일이 없는 레이어는 없다고 보고한다. 읽기·JSON 파싱·스키마 검증이 실패한 레이어는 에러를 그대로 보고하고 합성·미리보기·쓰기를 중단한다.

## 무엇을 — 필드와 반영

config는 자문 문서의 원본이고, 문서는 config의 투영이다. 편집 대상은 언제나 config다. 어느 필드를 고치면 무엇이 바뀌는가:

| config 좌표 | 반영되는 곳 | 반영 시점 |
| --- | --- | --- |
| `skill_routing.skills.<name>` (`intent`, `trigger`) | 라우트된 스킬 줄의 설명 텍스트 | 해당 문서가 다음에 렌더될 때 |
| `skill_routing.rules` (`agent` × `moment`) | orch 규칙 → run의 `guidance.md` / 프로필 규칙 → `guidance-<profile>.md` | orch본은 open·revive 시 / 프로필본은 설계상 dispatch 시이며 전달은 sibling run의 `tools.ts` 변경이 land하기 전까지 pending |
| `worker_profiles.<p>.intent` | `guidance.md`의 프로필 선택표 (ORCH만 읽음) | open·revive 시 |
| `worker_profiles.<p>.directive` | `guidance-<p>.md`의 지시 문단 (그 프로필 워커만 읽음) | 설계상 dispatch 시이며 전달은 sibling run의 `tools.ts` 변경이 land하기 전까지 pending |
| `orchestrator.role`, `worker_profiles.<p>.role` | 스폰 시 role 해석 | 다음 스폰 시 |
| `storage.root` | run 저장 위치 `<root>/<track>/<run>` | 새 트랙부터 |

전부 자문(advisory)이다: 범위·권한·소유·완료 조건은 바뀌지 않고, 미설치 스킬은 읽기 시점 no-op이며, 문서가 없으면 그냥 없는 것이다.

## 어떻게 — 검증·미리보기·수정

공통 절차 (쓰기 전에 반드시):

1. 수정 대상은 기본적으로 project `<repo>/.omp/herdr-delegator.json`이다. user·run 레이어는 관찰하되 사용자가 그 레이어 수정을 명시하지 않으면 쓰지 않는다.
2. 스키마 검증: repo의 `io.github.edgar-min.herdr-delegator/extensions/lib/config.ts`에서 `loadDelegatorConfig`를 import하고 `loadDelegatorConfig(undefined, cwd)`를 직접 호출해 대상 레이어가 에러 없이 해석되는지 확인한다. 첫 인자 `undefined`는 run 레이어 없이 user·project 레이어만 읽는다는 뜻이다. `assertExactKeys` 계약상 미지 키는 즉시 실패하고, 같은 cwd의 live run들이 이 파일을 읽으므로 깨진 파일을 쓰면 안 된다.
3. 렌더 미리보기: repo의 `io.github.edgar-min.herdr-delegator/extensions/lib/guidance.ts`에서 `renderGuidanceDocument`와 `renderWorkerGuidanceDocument`를 import하고, 반환된 `config`로 `renderGuidanceDocument(config)`와 `Object.keys(config.worker_profiles)` 각 프로필의 `renderWorkerGuidanceDocument(config, profile)`를 직접 호출해 출력이 의도와 일치하는지 확인한다.
4. 이상 없으면 project 파일을 쓴 뒤 `loadDelegatorConfig(undefined, cwd)`를 다시 직접 호출한다. 이미 열린 run에는 다음 open·revive(orch본)·dispatch(프로필본)에서 반영되지만, 프로필본의 dispatch 전달은 해당 `tools.ts` 변경이 land한 뒤부터 동작한다.

시나리오 A — 스킬 라우트 추가:

1. 리트머스 먼저: 이 스킬이 그 agent의 그 moment에서 어떤 특성 리스크를 보정하는가? 한 문장으로 답하지 못하면 추가하지 않는다(빈 슬롯은 설계다).
2. project 레이어에 `skill_routing`이 이미 있는지 확인한다. 새로 선언하면 user 라우팅 전체를 교체하므로, 의도한 유효 규칙 세트를 객체 안에 완전하게 적는다.
3. `skill_routing.skills.<name>`에 `intent`(왜 이 시점에 꺼내는가)와 `trigger`(언제)를 저작한다. 설치 여부는 조사하지 않는다.
4. `skill_routing.rules`에 `{ agent, moment, skills }`를 배선한다. moment: orch=`plan|authoring|settlement|reset`, worker=`intake|report`.
5. 공통 절차로 검증·미리보기 후 쓴다.

시나리오 B — 프로필 intent/directive 교정:

intent에는 선택의 don't("주지 말 것: …")를, directive에는 실행의 don't와 대표 실패 모드 명명을 유지한다. 문장을 다듬어도 이 두 구조는 지키고, 공통 절차로 검증 후 쓴다.

## v0 범위 밖 (필요해질 때 추가)

run 레이어 오버라이드 절차, 라우트 제거·감사 절차, storage 이관.
