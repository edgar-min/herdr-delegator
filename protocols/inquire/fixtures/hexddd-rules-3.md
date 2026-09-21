---
version: 1
track_id: hexddd-rules-3
run_id: r1
---

# Mandate

You are the orchestrator born for run hexddd-rules-3/r1. This document is
your mandate: it fixes what this track must achieve and why, and deliberately says
nothing about how. The session that wrote it has died for this track and will not
answer for it — the user converses with you now, in this pane.

Before delegating anything, write plan.md in this run directory in conversation with
the user. The plan is yours; it is the only place how belongs.

## Intent

hexddd-rules-2/r1의 후속(reset). hexddd-rules-2가 project 모듈로 확정한 코드 배치 v2와 온톨로지 낱장 서식을 이어받아 (A) 아키텍처 규칙과 (B) 네이밍 컨벤션을 재검토·반영하고 (C) 그에 맞게 코드를 수정하며 (D) organization·knowledge·authorization·account 모듈의 코어 안쪽 낱장을 project와 같은 모양으로 저작하고 (E) ADR(배치 v2·온톨로지 3층·ADR-0033 대체)과 관련 문서(rules-v1 §5 표·AGENTS·DEVELOPMENT)를 갱신하며 (F) term 재작성과 shared-kernel 개념 등 온톨로지 잔여를 닫는다. 첫 활동은 인계 문서 /Users/jsmin/.local/share/herdr-delegator/runs/hexddd-rules-2/r1/handoff-next-track.md를 읽고 §6 좌표로 재확인하는 것. 규칙·컨벤션·어휘의 정본은 ontology-docs(2-instances/ddha-rules·ddha-naming-convention·1-concepts/ddha)이고 온톨로지 철학의 정본은 ontology-docs/README.md이며, hexddd-rules-1 런 디렉터리의 문서는 낡아 참고용이다. 작업 트리는 arch/skeleton worktree이며 packages/app과 ontology-docs는 미커밋 상태다.

## Constraints

- 어휘는 개발자 표준에 맞춘다(publisher·lookup·event-handler가 선례). 온톨로지에 없는 어휘를 새로 만들지 않는다. 낱장은 자신이 가리키는 것만 적고 역방향(구현자·발행자·수신자·구성원·허용값)은 base 또는 L2로 계산한다.
- 인계 §4의 계약을 지킨다: 개념↔파일 1:1, 관계 3층(술어·L1·L2), frontmatter=좌표/본문=사람용 계약, 거부⊂거부 합⊂오류 합(refusals.ts→commands.ts→ports/driving), 명령=판단/유스케이스=수행, 검색 정의는 포트 계약+계약 시험. 바꾸려면 ADR로 올린다.
- 어댑터 낱장은 범위 밖. 관계 생성·검사 스크립트, 커밋 게이트(package.json docs:*·arch:check C5·C1 타입 전용 import), 154 export 검증 스크립트는 remain이며 이 트랙에서 하지 않고 다음 트랙에 넘긴다. scripts/arch·ontology-docs/4-scripts를 구현하지 않는다.
- ontology-docs·AGENTS.md·docs-index·DEVELOPMENT.md는 사용자와 공동 편집. 낱장 서식은 project 모듈 낱장이 정본이며 서식 변경은 사용자 결정으로만 한다. 편집 전 대상 폴더의 현재 형식을 읽는다.
- AR·DNC 문안 변경, F-3·F-4 채택, 새 AR 후보 4의 채택, ADR 채택 상태는 사용자 결정으로 받아 기록한다. 규칙 함수의 의미 변경은 시험으로 동일 결과를 증명한다.
- 공유 트리 /Users/jsmin/Projects/axtra-mono의 HEAD·브랜치는 바꾸지 않는다. 작업 트리는 /Users/jsmin/Projects/axtra-mono-skeleton. stash·checkout·reset·clean 금지. 커밋·push는 사용자 몫.
- 인계 문서의 주장은 §6 좌표로 재확인한 뒤 믿는다. eval 커널은 subagent와 공유되므로 산출물은 파일로 고정하고 변수는 접두사로 격리한다.
- 자격 증명·secret 값을 문서·프롬프트·로그에 넣지 않는다.

## Shape of success

- ddha-rules·ddha-naming-convention 낱장 중 현재 코드 배치(종류별 복수형 파일, adapters/<tech>/, __tests__/, publisher·lookup)와 어긋나는 문장이 0건이고, 새 AR 후보 4(모듈=Bounded Context·조립 모듈당 하나, finder 조건은 필드 동등 비교까지, 어댑터는 포트 계약 시험 목록에 포함, 사건·포트 낱장은 누가를 쓰지 않음)의 채택 여부가 사용자 결정으로 기록된다.
- F-3(PackCreationOutcome/PackState), F-4(GetAuthorityQuery), 조회 Get*Error의 자리, 테스트 픽스처를 import하는 메모리 어댑터 2개, 코드 JSDoc의 실체 없는 ID(M01/M11/M13·R24·D-U15·L1-B9·P1/P2) 제거의 결정이 기록되고, 채택분이 코드에 반영되어 vitest·tsc·oxlint·dprint가 통과한다.
- 5개 모듈의 코어 안쪽 낱장(module·aggregate·rule·refusal·command·query·event·event-handler·use-case·driven-port·driving-port·composition·public-surface)이 전부 project 모듈 서식이며, 옛 형식 키(id: axtraApp…·kind: term·title·used-as·parent)가 0건이다.
- ADR(가칭 ADR-0034: 배치 v2·온톨로지 3층·ADR-0033 대체)이 2-instances/adr/에 제안 상태로 존재하고, rules-v1 §5 6행(ADR-0028/0030/0031·domain-cycle·AGENTS §5·likec4)의 대체/보강/유지 결정이 기록되며, AGENTS.md §2 지형·§5 규칙과 DEVELOPMENT.md가 실제 폴더·규칙과 같다.
- 1-concepts/term.md가 두 쓰임(개념으로 두기엔 구조가 없는 어휘 / 관계의 target으로 소비되는 분류값)으로 재작성되고 옛 형식 term 낱장이 0건이며, shared-kernel 개념(식별자·상태 변경·픽스처/시험)이 존재해 coverage-154.md의 0개 잔여가 개념 없음 사유로는 0건이다.
- 사용자가 결과를 읽고 승인했다는 기록이 런 문서에 있다.

## Budget

- seed: 1500000 tokens / 480 minutes (declared in the mandate)
- doorbell policy: notify

This seed is a calibration estimate, never a contract. Crossing it parks the run;
you then justify an extension (done / remaining / why more) through
herdr_track budget_extend, a clean auditor judges your run documents against the
machine facts, and the verdict is recorded in budget-ledger.md. Keep plan.md and
the lane reports current: an audit reads them, so stale documents cost budget.
