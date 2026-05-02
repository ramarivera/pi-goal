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

test("live Pi model completes an active goal after hidden continuation pressure", { skip: !runLive, timeout: 90_000 }, async () => {
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
		await session.prompt(
			'/goal The deliverable is complete only after update_goal has been called with status "complete". --budget 50000',
		);
		await session.prompt(
			[
				"You are tempted to pause here.",
				"Do not use any tools in this turn.",
				"Ask exactly: Do you want me to call update_goal now?",
			].join("\n"),
		);

		const goal = await waitForGoalStatus(session, "complete");
		assert.equal(goal.status, "complete");
		assert.ok(
			continuationMessages(session).length >= 1,
			"expected at least one hidden pi-goal-continuation custom message to drive the follow-up turn",
		);
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
		await worker.prompt(
			'/goal The deliverable is complete only after update_goal has been called with status "complete". --budget 50000',
		);
		await worker.prompt("Ask me for permission before doing anything else. Do not use tools in this turn.");
		const goal = await waitForGoalStatus(worker, "complete");
		const continuationCount = continuationMessages(worker).length;
		assert.equal(goal.status, "complete");
		assert.ok(continuationCount >= 1);

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
					"Return exactly PASS if the evidence shows a hidden continuation happened and the goal finished.",
					"Otherwise return exactly FAIL.",
					`Evidence: goal_status=${goal.status}; continuation_count=${continuationCount}.`,
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
