import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type CustomEntry,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const repoRoot = process.cwd();
let agentDir: string;

interface PersistedGoalState {
	objective: string;
	status: string;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	continuationCount?: number;
	continuationScheduled?: boolean;
}

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-goal-e2e-"));
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

test("Pi SDK discovers the project-local pi-goal extension", async () => {
	const loader = new DefaultResourceLoader({
		cwd: repoRoot,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const extensions = loader.getExtensions();
	assert.deepEqual(extensions.errors, []);
	assert.ok(
		extensions.extensions.some((extension) => extension.resolvedPath.endsWith(".pi/extensions/pi-goal/index.ts")),
		"expected DefaultResourceLoader to discover .pi/extensions/pi-goal/index.ts",
	);
});

test("Pi SDK executes /local-goal commands through the live project extension runtime", async () => {
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
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(repoRoot),
		noTools: "all",
	});

	try {
		await session.bindExtensions({});
		await session.prompt("/local-goal Implement SDK e2e --budget 123");
		let goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.objective, "Implement SDK e2e");
		assert.equal(goal.status, "active");
		assert.equal(goal.tokenBudget, 123);
		assert.equal(goal.tokensUsed, 0);
		assert.equal(goal.timeUsedSeconds, 0);

		await session.prompt("/local-goal pause");
		goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.status, "paused");

		await session.prompt("/local-goal resume");
		goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.status, "active");

		await session.prompt("/local-goal clear");
		goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.status, "cleared");
	} finally {
		session.dispose();
	}
});

test("Pi SDK /local-goal resume re-pressurizes an active incomplete goal", async () => {
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
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(repoRoot),
		noTools: "all",
	});

	try {
		await session.bindExtensions({});
		await session.prompt("/local-goal Resume pressure e2e --budget 123");
		await session.prompt("/local-goal resume");
		await delay(500);

		const goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.objective, "Resume pressure e2e");
		assert.equal(goal.status, "active");
		assert.ok((goal.continuationCount ?? 0) >= 1, "expected /local-goal resume to send continuation pressure");
		assert.equal(goal.continuationScheduled, false);
	} finally {
		session.dispose();
	}
});

test("Pi SDK automatically re-pressurizes active goals after assistant error messages", async () => {
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
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(repoRoot),
		noTools: "all",
	});

	try {
		await session.bindExtensions({});
		await session.prompt("/local-goal Automatic error pressure e2e --budget 123");
		await session.extensionRunner.emitMessageEnd({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				api: "responses",
				provider: "openai-codex",
				model: "gpt-5.5",
				usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "error",
				errorMessage: 'Codex error: {"code":"context_length_exceeded"}',
				timestamp: Date.now(),
			},
		});
		await delay(500);

		const goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.objective, "Automatic error pressure e2e");
		assert.equal(goal.status, "active");
		assert.ok((goal.continuationCount ?? 0) >= 1, "expected assistant error to send continuation pressure automatically");
		assert.equal(goal.continuationScheduled, false);
	} finally {
		session.dispose();
	}
});

test("Pi SDK exposes pi-goal commands and model tools through live runtime contracts", async () => {
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
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(repoRoot),
		noTools: "all",
	});

	try {
		await session.bindExtensions({});
		assert.ok(session.extensionRunner.getCommand("local-goal"), "expected /local-goal command to be registered");
		const toolNames = session.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name);
		assert.ok(toolNames.includes("local_get_goal"), "expected local_get_goal tool to be registered");
		assert.ok(toolNames.includes("local_create_goal"), "expected local_create_goal tool to be registered");
		assert.ok(toolNames.includes("local_update_goal"), "expected local_update_goal tool to be registered");

		const updateGoal = session.extensionRunner.getToolDefinition("local_update_goal");
		assert.ok(updateGoal, "expected local_update_goal definition to be retrievable");
		const result = await updateGoal.execute(
			"call-no-goal",
			{ status: "complete" },
			undefined,
			undefined,
			session.createReplacedSessionContext() as ExtensionContext,
		);
		assert.match(JSON.stringify(result.details), /does not have an active or paused goal/);
	} finally {
		session.dispose();
	}
});

test("Pi SDK restores persisted goal state after reopening a file-backed session", async () => {
	const loader = new DefaultResourceLoader({
		cwd: repoRoot,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-goal-session-"));
	let sessionFile: string;

	try {
		const firstManager = SessionManager.create(repoRoot, sessionDir);
		const first = await createAgentSession({
			cwd: repoRoot,
			agentDir,
			resourceLoader: loader,
			sessionManager: firstManager,
			noTools: "all",
		});

		try {
			await first.session.bindExtensions({});
			await first.session.prompt("/local-goal Persist across reopen --budget 77");
			sessionFile = first.session.exportToJsonl(join(sessionDir, "persisted-goal-session.jsonl"));
			const created = latestGoal(first.session.sessionManager.getEntries());
			assert.equal(created.status, "active");
			assert.equal(created.tokenBudget, 77);
		} finally {
			first.session.dispose();
		}

		const reopenedLoader = new DefaultResourceLoader({
			cwd: repoRoot,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await reopenedLoader.reload();
		const reopenedManager = SessionManager.open(sessionFile, sessionDir, repoRoot);
		const reopened = await createAgentSession({
			cwd: repoRoot,
			agentDir,
			resourceLoader: reopenedLoader,
			sessionManager: reopenedManager,
			noTools: "all",
		});

		try {
			await reopened.session.bindExtensions({});
			await reopened.session.prompt("/local-goal pause");
			const restoredAndPaused = latestGoal(reopened.session.sessionManager.getEntries());
			assert.equal(restoredAndPaused.objective, "Persist across reopen");
			assert.equal(restoredAndPaused.status, "paused");
			assert.equal(restoredAndPaused.tokenBudget, 77);
		} finally {
			reopened.session.dispose();
		}
	} finally {
		await rm(sessionDir, { recursive: true, force: true });
	}
});
