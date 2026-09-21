# 재설정, 인계, 회고

close/reset 시에는 이 run에 기록된 요청 ID들로 `log`의 `summary` 연산을 사용하고, 레인과 자신의 실제 결과를 기대와 비교한다. 기대에 못 미친 레인에만 보고서를 통해 구체적인 원인을 묻는다. 각 레인은 자신의 friction을 직접 기록하며, 불가능할 때만 ORCH가 그 근거를 옮겨 적는다. 스킬이 원인인 friction은 `skill-review: <skill> — <cause-token>` 형식의 요약을 유지하고, 도구명에는 스킬 이름을, 기록에는 해당 track/run을 명시한다. cause-token과 kind의 대응은 wasted-context→excessive-steps, redundant-overlap→papercut, unrouted-but-used→doc-drift, trigger-mismatch→doc-drift, missing-wish→contract-gap이다. 스킬 외 원인은 일반적인 증상·근거 형식으로 보고한다. 연락할 수 없는 레인은 그렇게 기록하고 답변을 만들어 내지 않는다. 검증된 계약, 교훈, 실패 사례를 보존하고 측정값과 가설을 구분한다.

reset/handoff는 별도의 run과 ORCH 탄생을 만든다. 물려받은 주장을 재검증하고 안전하게 닫을 수 없는 원본 레인은 보존한다. 다시 시작할 때는 근거에 기반한 보존·폐기 경계와 첫 종단 간 검증 관문을 명시한다. 컨텍스트가 더 이상 책임 있는 결정을 뒷받침하지 못하면 인계 근거를 보존하고, 다음 탄생 세대를 명시한 사용자 서면 승인을 요청하며, 연속성이 있는 척 지휘하지 말고 멈춘다.
