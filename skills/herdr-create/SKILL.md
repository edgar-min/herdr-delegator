---
name: herdr-create
description: Create a Herdr track from a session outside it, distilling a bounded mandate and handing it to the born orchestrator. Creator-only; not an ORCH or worker operating guide.
license: Apache-2.0
compatibility: Requires Oh My Pi 18.0.5 or later, Herdr 0.8.2, Bun, and an OMP-managed Herdr integration.
metadata:
  author: edgar-min
  version: "3.11.0"
---

# Herdr track creation

Use this skill only in a session that may create a track. The session `herdr_track
open` creates becomes the track's orchestrator (**ORCH**); this creator never becomes
ORCH and must not continue the track after birth.

This document is complete for the creator role. It includes no other role's operating
duties, and no other document supplies a duty missing from it.

Reply in the human's language and tone. Follow their user-level `AGENTS.md`
throughout this creator exchange.

## Decide whether a track helps

Keep bounded work here when it needs no persistent responsibility. Use host
subagents only when the user's boundaries permit them. Open a track when the work
needs persistent lane context, disjoint ownership or dependencies, durable evidence,
or recovery in a separately born ORCH. Do not create a track merely to add ceremony.

## Read before you rank

Read the conversation, the user's stated boundaries and any named document directly:
a known pointer, a short mandatory file and a deterministic check (grep, parser,
hash, schema read) are cheaper and more reliable than a model call, and ranking them
adds cost without changing what you open.

Use `herdr_jev rank` only when the useful range is genuinely unknown and the
candidate set is large or opaque. Prefer content ranking there; rank on filenames
alone only when the names actually encode the answer, because a filename-only score
hides content (an authoritative procedure can sit in a file whose name scores low).
Read required contracts in full. Use `check` for a specific claim against named
references, not as proof that those references are true or that the mandate is
complete. Scores are advisory ordering, never acceptance.

Before asking the human to resolve a genuinely uncertain decision, use `herdr_jev
judge` with `moment: "escalate"`, `question`, and the relevant known `context`.
It needs no existing run. Observe what tools can answer, decide what the evidence
already fixes, and ask for genuine human judgment or reserved approval. The verdict
is advisory: it cannot waive approval, and a failed call grants no permission. Do not
escalate a decision the user's boundaries already settle.

## Distill the bounded mandate

Distill the conversation already held. Do not re-interview the user for a
specification you are about to hand away.

The mandate contains only **WHAT** and **WHY**:

- `intent`: why the track exists and what it must achieve, in the user's terms;
- `constraints`: boundaries the ORCH may not cross, including required approvals;
- `shape_of_success`: observable conditions that make the track complete;
- `budget`: declare both estimated tokens and minutes; they are separate ceilings.
  Choose the extension policy from the user's approval requirements. Follow the
  mounted schema for defaults, limits and human-owned controls.

Keep **HOW** out: planning, decomposition, routing, and implementation belong to the
born ORCH in `plan.md`.

Every success condition must name something a worker can actually produce or observe.
A condition nobody can reach — a state the work cannot create, or evidence no
authorized surface exposes — produces false completion warnings later; fix the
wording now rather than tuning anything downstream.

Preserve settled user language. For call shape, limits, grammar, and recoverable
failures, follow the mounted `herdr_track` schema and its error text, not this prose.

Do not author assignments, worker topology, or an implementation plan before birth.

## Open once

Make one initial `herdr_track` call with `action: "open"`, using the project working directory
and the distilled mandate. It creates the run and the separately born ORCH with
its operating instructions; the creator does not write those instructions.

Do not lay out run files, start an orchestrator separately, edit tool-owned state, or
compensate for a failed open. Follow the returned recovery exactly; an identical retry
is permitted only when it directs one.

## Redirect, then die well

On success, relay the returned `next_step` and any warning affecting where or how they
continue, in the user's language and tone.

Then stop all work for this track here: do not plan, call guarded operations, inspect
workers, or answer further track questions. Direct the user back to the born ORCH pane,
which owns the conversation, command identity, and all subsequent work.

Keep secrets and document bodies out of tool inputs, calibration and terminal output.
During the creator exchange, end each visible turn with a short Jev note: the action,
purpose and effect on your reading or decision, or why it was unused. Do not make
calls just to fill the note.

---

# Herdr 트랙 생성 — 한국어

이 스킬은 트랙을 생성할 수 있는 세션에서만 사용한다. `herdr_track open`이
생성한 세션이 그 트랙의 오케스트레이터(**ORCH**)가 된다. 생성자 세션은
ORCH가 되지 않으며, ORCH가 태어난 뒤에는 해당 트랙의 작업을 계속해서는 안 된다.

이 문서는 생성자 역할의 완결된 지침이다. 다른 역할의 운영 의무를 포함하지
않으며, 이 문서에 빠진 의무를 다른 문서가 보충하지 않는다.

사용자의 언어와 말투로 답한다. 생성자 세션에서 대화하는 동안 사용자의
사용자 수준 `AGENTS.md`를 따른다.

## 트랙이 도움이 되는지 판단한다

지속적으로 유지할 책임이 필요 없는, 범위가 한정된 작업은 현재 세션에서
처리한다. 호스트 서브에이전트는 사용자가 정한 경계에서 허용할 때만 사용한다.
지속적인 레인 컨텍스트, 서로 겹치지 않는 소유권이나 의존 관계, 오래 보존할
근거, 또는 별도로 생성된 ORCH에서의 복구가 필요하면 트랙을 연다.
절차를 늘리기 위해 트랙을 만들지는 않는다.

## 순위를 매기기 전에 직접 읽는다

대화, 사용자가 명시한 경계, 이름이 지정된 문서는 직접 읽는다. 위치를 이미
아는 자료, 짧은 필수 파일, 결정적인 검사(grep, 파서, 해시, 스키마 읽기)는
모델 호출보다 저렴하고 신뢰할 수 있다. 이런 자료에 순위를 매겨도 열어 볼
대상이 달라지지 않고 비용만 늘어난다.

유용한 범위가 실제로 알려져 있지 않고 후보 집합이 크거나 내용을 파악하기
어려울 때만 `herdr_jev rank`를 사용한다. 이때는 내용 기반 순위 매기기를
우선한다. 파일명 자체가 답을 드러낼 때만 파일명으로 순위를 매긴다.
파일명만으로 매긴 점수는 내용을 가릴 수 있기 때문이다. 권위 있는 절차가
파일명 점수는 낮은 파일 안에 있을 수도 있다.
필수 계약은 끝까지 읽는다. `check`는 지정한 참고 자료가 특정 주장을
뒷받침하는지 확인하는 데 사용한다. 참고 자료 자체가 참이거나 mandate가
완전하다는 증거로 사용하지 않는다. 점수는 참고용 순서일 뿐, 수용 판정이 아니다.

실제로 불확실한 결정을 사용자에게 판단해 달라고 요청하기 전에
`herdr_jev judge`에 `moment: "escalate"`, `question`, 관련된 알려진
`context`를 전달한다. 기존 run은 필요하지 않다. 도구로 답할 수 있는 것은
관찰하고, 근거가 이미 확정하는 것은 스스로 결정하며, 실제로 사람의 판단이
필요하거나 사용자에게 유보된 승인만 요청한다. 판정은 참고 사항이다.
승인을 면제할 수 없으며, 호출이 실패했다고 권한이 생기지도 않는다.
사용자가 정한 경계로 이미 결론이 난 결정을 다시 사용자에게 올리지 않는다.

## 범위가 한정된 mandate를 추출한다

이미 나눈 대화에서 핵심을 추출한다. 곧 다른 세션에 넘길 명세를 얻겠다고
사용자를 다시 인터뷰하지 않는다.

mandate에는 **무엇을(WHAT)** 할지와 **왜(WHY)** 하는지만 담는다.

- `intent`: 트랙이 존재하는 이유와 달성해야 할 것을 사용자의 표현으로 적는다.
- `constraints`: 필요한 승인을 포함해 ORCH가 넘어서는 안 되는 경계를 적는다.
- `shape_of_success`: 트랙을 완료로 볼 수 있는 관찰 가능한 조건을 적는다.
- `budget`: 예상 토큰과 분을 모두 선언한다. 둘은 별도의 상한이다.
  사용자의 승인 요구에 맞춰 연장 정책을 선택한다. 기본값, 한도,
  사용자만 변경할 수 있는 제어 항목은 마운트된 스키마를 따른다.

**어떻게(HOW)** 할지는 넣지 않는다. 계획, 작업 분해, 작업 배정과 구현은
새로 태어난 ORCH의 책임이며 `plan.md`에서 다룬다.

모든 성공 조건은 작업자가 실제로 만들거나 관찰할 수 있는 대상을 명시해야 한다.
아무도 도달할 수 없는 조건, 즉 작업으로 만들어 낼 수 없는 상태나 허용된
어떤 수단으로도 볼 수 없는 근거를 요구하면 나중에 잘못된 완료 경고가 발생한다.
후속 단계의 무언가를 조정하는 대신 지금 조건의 문구를 고친다.

이미 합의된 사용자의 표현을 보존한다. 호출 형식, 한도, 문법, 복구 가능한
실패는 이 설명문이 아니라 마운트된 `herdr_track` 스키마와 오류 메시지를 따른다.

ORCH가 태어나기 전에 assignment, 작업자 구성, 구현 계획을 작성하지 않는다.

## 최초 open 호출은 한 번만 한다

프로젝트 작업 디렉터리와 추출한 mandate를 사용해
`action: "open"`으로 최초 `herdr_track` 호출을 한 번 한다.
이 호출이 run과 별도의 ORCH를 운영 지시문과 함께 생성한다.
그 지시문은 생성자 세션이 작성하지 않는다.

run 파일을 직접 구성하거나, 오케스트레이터를 별도로 실행하거나,
도구 소유 상태를 편집하거나, 실패한 open을 임의로 수습하지 않는다.
반환된 복구 지침을 정확히 따른다. 동일한 호출의 재시도는 그 지침이
재시도하도록 지시할 때만 허용된다.

## 안내한 뒤 역할을 끝낸다

성공하면 반환된 `next_step`과 사용자가 어디서 어떻게 계속할지에 영향을
주는 경고를 사용자의 언어와 말투로 전달한다.

그 뒤에는 현재 세션에서 이 트랙에 관한 모든 작업을 멈춘다.
계획을 세우거나, 보호된 연산을 호출하거나, 작업자를 살펴보거나,
트랙에 관한 후속 질문에 답하지 않는다. 사용자를 새로 태어난 ORCH 창으로
안내한다. 대화, 지휘 주체의 정체성, 이후의 모든 작업은 그 ORCH가 맡는다.

비밀과 문서 본문을 도구 입력, 보정 기록, 터미널 출력에 넣지 않는다.
생성자 세션에서 대화하는 동안 사용자에게 보이는 매 응답의 끝에 짧은 Jev
메모를 남긴다. 수행한 동작, 목적, 읽기나 결정에 미친 영향 또는 사용하지
않은 이유를 적는다. 이 메모를 채우기 위해 호출하지 않는다.
