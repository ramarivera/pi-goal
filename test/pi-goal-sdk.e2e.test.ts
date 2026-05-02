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
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const repoRoot = process.cwd();
let agentDir: string;

interface PersistedGoalState {
	objective: string;
	status: string;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
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

test("Pi SDK executes /goal commands through the live extension runtime", async () => {
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
		await session.prompt("/goal Implement SDK e2e --budget 123");
		let goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.objective, "Implement SDK e2e");
		assert.equal(goal.status, "active");
		assert.equal(goal.tokenBudget, 123);
		assert.equal(goal.tokensUsed, 0);
		assert.equal(goal.timeUsedSeconds, 0);

		await session.prompt("/goal pause");
		goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.status, "paused");

		await session.prompt("/goal resume");
		goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.status, "active");

		await session.prompt("/goal clear");
		goal = latestGoal(session.sessionManager.getEntries());
		assert.equal(goal.status, "cleared");
	} finally {
		session.dispose();
	}
});
