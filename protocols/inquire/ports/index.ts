// Ports the driver plugs adapters into. The domain never imports an adapter.
import type {
  AdmissibilityRequest, AdmissibilityVerdict, ClassifyRequest, ClassifyVerdict, ClusterRequest, ClusterVerdict,
  ContextResolutionRequest, ContextResolutionVerdict, PriorityRequest, PriorityVerdict, ScanRequest, ScanVerdict,
} from "../domain/judgments.js";
import type { InquireState } from "../domain/types.js";

/** Who answers the protocol's judgments: Jev, a human, or a fixture. Each method returns a decided verdict. */
export interface JudgmentPort {
  scan(request: ScanRequest): Promise<ScanVerdict>;
  contextResolution(request: ContextResolutionRequest): Promise<ContextResolutionVerdict>;
  classify(request: ClassifyRequest): Promise<ClassifyVerdict>;
  admissibility(request: AdmissibilityRequest): Promise<AdmissibilityVerdict>;
  priority(request: PriorityRequest): Promise<PriorityVerdict>;
  cluster(request: ClusterRequest): Promise<ClusterVerdict>;
}

/** Where Λ lives between turns. */
export interface StatePort {
  load(key: string): Promise<InquireState | undefined>;
  save(key: string, state: InquireState): Promise<void>;
}
