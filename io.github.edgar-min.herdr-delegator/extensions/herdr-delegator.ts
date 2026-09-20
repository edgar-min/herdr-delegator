import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOmpBridge } from "./lib/bridge";
import { registerJevHooks } from "./lib/jev-hooks";

export default function (pi: ExtensionAPI) {
  registerOmpBridge(pi);
  registerJevHooks(pi);
}
