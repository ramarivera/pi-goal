import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	type AgentSession,
	type CustomEntry,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const liveModelPattern = process.env.PI_GOAL_LIVE_MODEL;
const judgeModelPattern = process.env.PI_GOAL_JUDGE_MODEL;
const runLive = process.env.PI_GOAL_LIVE === "1" || Boolean(liveModelPattern);
const repoRoot = process.cwd();
let agentDir: string;

interface PersistedGoalState {
	objective: string;
	status: string;
}

interface CustomMessageEntryShape {
	type: string;
	customType?: string;
	content?: string | unknown[];
}

interface MessageEntryShape {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

interface ToolResultEntryShape {
	type: string;
	message?: {
		role?: string;
		toolName?: string;
	};
}

interface TextContentShape {
	type?: string;
	text?: string;
}

interface ToolCallShape {
	type?: string;
	name?: string;
}

interface GoalPressureEvidence {
	goalStatus: string;
	stallAssistantText: string;
	continuationCount: number;
	updateGoalToolCallCount: number;
	orderedCycle: boolean;
}

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-goal-live-"));
});

after(async () => {
	if (agentDir) {
		await rm(agentDir, { recursive: true, force: true });
	}
});

function isGoalEntry(entry: SessionEntry): entry is CustomEntry<PersistedGoalState> {
	return entry.type === "custom" && entry.customType === "pi-goal-state";
}

function latestGoal(entries: SessionEntry[]): PersistedGoalState {
	const entry = entries.filter(isGoalEntry).at(-1);
	assert.ok(entry, "expected a persisted pi-goal-state custom entry");
	assert.ok(entry.data, "expected persisted goal data");
	return entry.data;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGoalStatus(
	session: AgentSession,
	status: PersistedGoalState["status"],
	timeoutMs = 45_000,
): Promise<PersistedGoalState> {
	const deadline = Date.now() + timeoutMs;
	let latest = latestGoal(session.sessionManager.getEntries());
	while (Date.now() < deadline) {
		await delay(250);
		await session.agent.waitForIdle();
		latest = latestGoal(session.sessionManager.getEntries());
		if (latest.status === status) {
			return latest;
		}
	}
	assert.equal(latest.status, status);
	return latest;
}

function parseModelPattern(pattern: string): [string, string] {
	const slash = pattern.indexOf("/");
	assert.ok(slash > 0 && slash < pattern.length - 1, `expected model pattern as provider/model, got ${pattern}`);
	return [pattern.slice(0, slash), pattern.slice(slash + 1)];
}

function resolvePreferredModel(modelRegistry: ModelRegistry, available: Awaited<ReturnType<ModelRegistry["getAvailable"]>>) {
	if (liveModelPattern) {
		return modelRegistry.find(...parseModelPattern(liveModelPattern));
	}
	return (
		modelRegistry.find("openai-codex", "gpt-5.4-mini") ??
		modelRegistry.find("openai-codex", "gpt-5.4-nano") ??
		modelRegistry.find("openai", "gpt-5.4-mini") ??
		modelRegistry.find("openai", "gpt-5.4-nano") ??
		available.find((candidate) => candidate.provider === "openai-codex" && candidate.id === "gpt-5.4-mini") ??
		available[0]
	);
}

async function createLiveSession(options: {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: NonNullable<ReturnType<typeof resolvePreferredModel>>;
	tools: string[];
}) {
	const loader = new DefaultResourceLoader({
		cwd: repoRoot,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: repoRoot,
		agentDir,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		model: options.model,
		thinkingLevel: options.model.reasoning ? "minimal" : "off",
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(repoRoot),
		tools: options.tools,
	});
	await session.bindExtensions({});
	return session;
}

function continuationMessages(session: AgentSession): CustomMessageEntryShape[] {
	return session.sessionManager
		.getEntries()
		.filter((entry): entry is SessionEntry & CustomMessageEntryShape => {
			const candidate = entry as unknown as CustomMessageEntryShape;
			return candidate.type === "custom_message" && candidate.customType === "pi-goal-continuation";
		});
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const candidate = part as TextContentShape;
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("");
}

function assistantTexts(session: AgentSession): string[] {
	return session.sessionManager
		.getEntries()
		.filter((entry): entry is SessionEntry & MessageEntryShape => {
			const candidate = entry as unknown as MessageEntryShape;
			return candidate.type === "message" && candidate.message?.role === "assistant";
		})
		.map((entry) => textFromContent(entry.message?.content));
}

function updateGoalToolCallCount(session: AgentSession): number {
	return session.sessionManager
		.getEntries()
		.filter((entry): entry is SessionEntry & MessageEntryShape => {
			const candidate = entry as unknown as MessageEntryShape;
			return candidate.type === "message" && candidate.message?.role === "assistant";
		})
		.flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
		.filter((part) => {
			const candidate = part as ToolCallShape;
			return candidate.type === "toolCall" && candidate.name === "update_goal";
		}).length;
}

function hasUpdateGoalToolResult(session: AgentSession): boolean {
	return session.sessionManager.getEntries().some((entry) => {
		const candidate = entry as unknown as ToolResultEntryShape;
		return candidate.type === "message" && candidate.message?.role === "toolResult" && candidate.message.toolName === "update_goal";
	});
}

function goalPressureEvidence(session: AgentSession): GoalPressureEvidence {
	const entries = session.sessionManager.getEntries();
	const stallAssistantIndex = entries.findIndex((entry) => {
		const candidate = entry as unknown as MessageEntryShape;
		const text = textFromContent(candidate.message?.content);
		return candidate.type === "message" && candidate.message?.role === "assistant" && text.includes("WORK_MARKER: TASK_PARSED");
	});
	const continuationIndex = entries.findIndex((entry) => {
		const candidate = entry as unknown as CustomMessageEntryShape;
		return candidate.type === "custom_message" && candidate.customType === "pi-goal-continuation";
	});
	const updateGoalIndex = entries.findIndex((entry) => {
		const candidate = entry as unknown as MessageEntryShape;
		if (candidate.type !== "message" || candidate.message?.role !== "assistant") return false;
		const content = Array.isArray(candidate.message.content) ? candidate.message.content : [];
		return content.some((part) => {
			const toolCall = part as ToolCallShape;
			return toolCall.type === "toolCall" && toolCall.name === "update_goal";
		});
	});
	const texts = assistantTexts(session);
	const stallAssistantText = texts.find((text) => text.includes("WORK_MARKER: TASK_PARSED")) ?? "";
	return {
		goalStatus: latestGoal(entries).status,
		stallAssistantText,
		continuationCount: continuationMessages(session).length,
		updateGoalToolCallCount: updateGoalToolCallCount(session),
		orderedCycle: stallAssistantIndex >= 0 && stallAssistantIndex < continuationIndex && continuationIndex < updateGoalIndex,
	};
}

async function runGoalPressureCycle(session: AgentSession): Promise<GoalPressureEvidence> {
	await session.prompt(
		[
			"/goal Complete the tiny classification task end-to-end.",
			"Task: classify the token BRAVO as one of ALPHA, BRAVO, CHARLIE.",
			'The task is complete only after the assistant has recognized the answer is BRAVO and update_goal has been called with status "complete".',
			"--budget 50000",
		].join(" "),
	);
	await session.prompt(
		[
			"Do the first part of the active goal now, but intentionally wait for one more confirmation before completion.",
			"Do not use tools in this turn.",
			"Your response must include exactly this marker line: WORK_MARKER: TASK_PARSED=BRAVO.",
			"Then ask exactly this confirmation question: Should I mark the goal complete now?",
		].join("\n"),
	);
	await waitForGoalStatus(session, "complete");
	const evidence = goalPressureEvidence(session);
	assert.match(evidence.stallAssistantText, /WORK_MARKER: TASK_PARSED=BRAVO/);
	assert.match(evidence.stallAssistantText, /Should I mark the goal complete now\?/);
	assert.equal(evidence.goalStatus, "complete");
	assert.ok(evidence.continuationCount >= 1, "expected hidden continuation after the model waited for confirmation");
	assert.ok(evidence.updateGoalToolCallCount >= 1, "expected update_goal to be called after hidden continuation");
	assert.equal(evidence.orderedCycle, true, "expected stall response before hidden continuation before update_goal");
	assert.equal(hasUpdateGoalToolResult(session), true, "expected an update_goal tool result in the transcript");
	return evidence;
}

test("live Pi model can drive pi-goal model tools directly", { skip: !runLive, timeout: 60_000 }, async () => {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const available = await modelRegistry.getAvailable();
	const model = resolvePreferredModel(modelRegistry, available);

	assert.ok(
		model,
		`expected PI_GOAL_LIVE_MODEL=${liveModelPattern ?? "<auto>"} to resolve to an authenticated Pi model`,
	);

	const session = await createLiveSession({
		authStorage,
		modelRegistry,
		model,
		tools: ["get_goal", "create_goal", "update_goal"],
	});

	try {
		await session.bindExtensions({});
		await session.prompt(
			[
				"Use the available pi-goal tools only.",
				'First call create_goal with objective "Live model smoke goal".',
				"Then call update_goal with status complete.",
				"After the tools finish, respond with exactly: PI_GOAL_LIVE_SMOKE_OK",
			].join("\n"),
		);

		const goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.objective, "Live model smoke goal");
		assert.equal(goal.status, "complete");
		assert.match(session.getLastAssistantText() ?? "", /PI_GOAL_LIVE_SMOKE_OK/);
	} finally {
		session.dispose();
	}
});

test("live Pi model completes a predictable task after confirmation-stall pressure", { skip: !runLive, timeout: 90_000 }, async () => {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const available = await modelRegistry.getAvailable();
	const model = resolvePreferredModel(modelRegistry, available);
	assert.ok(model, `expected PI_GOAL_LIVE_MODEL=${liveModelPattern ?? "<auto>"} to resolve to an authenticated Pi model`);

	const session = await createLiveSession({
		authStorage,
		modelRegistry,
		model,
		tools: ["get_goal", "update_goal"],
	});

	try {
		await runGoalPressureCycle(session);
	} finally {
		session.dispose();
	}
});

test("live Pi judge agrees the hidden continuation completed the goal", { skip: !runLive, timeout: 90_000 }, async () => {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const available = await modelRegistry.getAvailable();
	const workerModel = resolvePreferredModel(modelRegistry, available);
	const judgeModel = judgeModelPattern
		? modelRegistry.find(...parseModelPattern(judgeModelPattern))
		: (modelRegistry.find("openai-codex", "gpt-5.4-mini") ?? workerModel);
	assert.ok(workerModel, "expected an authenticated worker model");
	assert.ok(judgeModel, "expected an authenticated judge model");

	const worker = await createLiveSession({
		authStorage,
		modelRegistry,
		model: workerModel,
		tools: ["get_goal", "update_goal"],
	});

	try {
		const evidence = await runGoalPressureCycle(worker);

		const judge = await createLiveSession({
			authStorage,
			modelRegistry,
			model: judgeModel,
			tools: [],
		});
		try {
			await judge.prompt(
				[
					"You are judging a Pi goal-loop smoke test.",
					"Return exactly PASS only if all of these are true:",
					"1. The worker received a concrete tiny classification task.",
					"2. The worker did some task work by identifying BRAVO.",
					"3. The worker then waited for one more confirmation.",
					"4. A hidden pi-goal-continuation happened after that stall.",
					"5. update_goal was called after the hidden continuation.",
					"6. The goal finished complete.",
					"Otherwise return exactly FAIL.",
					`Evidence: goal_status=${evidence.goalStatus}; continuation_count=${evidence.continuationCount}; update_goal_tool_calls=${evidence.updateGoalToolCallCount}; ordered_cycle=${evidence.orderedCycle}; stall_text=${JSON.stringify(evidence.stallAssistantText)}.`,
				].join("\n"),
			);
			assert.match(judge.getLastAssistantText() ?? "", /\bPASS\b/);
		} finally {
			judge.dispose();
		}
	} finally {
		worker.dispose();
	}
});
