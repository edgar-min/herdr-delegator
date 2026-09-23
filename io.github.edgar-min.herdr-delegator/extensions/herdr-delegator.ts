import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOmpBridge } from "./lib/bridge";
import { registerRoutingGate } from "./lib/routing-gate";

export default function (pi: ExtensionAPI) {
  registerOmpBridge(pi);
  registerRoutingGate(pi);
}
