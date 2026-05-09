import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoalExtension } from "../../../src/index.ts";

function localPiGoalExtension(pi: ExtensionAPI): void {
	createGoalExtension({ commandName: "local-goal", toolNamePrefix: "local_" }).register(pi);
}

export * from "../../../src/index.ts";
export default localPiGoalExtension;
