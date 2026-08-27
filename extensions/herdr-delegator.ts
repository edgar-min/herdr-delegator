import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOmpBridge } from "./lib/bridge";

export default function (pi: ExtensionAPI) {
  registerOmpBridge(pi);
}
