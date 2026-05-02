import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTINUATION_MESSAGE_TYPE,
	createGoal,
	createGoalExtension,
	extractTokenUsage,
	goalResponse,
	parseGoalArgs,
	readLatestGoalFromBranch,
	renderContinuationPrompt,
	shouldScheduleContinuation,
	transitionGoal,
	type ContextMessage,
	type ExtensionApi,
	type ExtensionCommandContext,
	type ExtensionTool,
	type GoalState,
	type SessionEntry,
} from "../.pi/extensions/pi-goal/index.ts";

type CommandHandler = {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type Handler = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;

interface FakePi {
	pi: ExtensionApi;
	ctx: ExtensionCommandContext;
	commands: Map<string, CommandHandler>;
	tools: Map<string, ExtensionTool<Record<string, unknown>, unknown>>;
	handlers: Map<string, Handler[]>;
	entries: SessionEntry[];
	branchEntries: SessionEntry[];
	sentMessages: Array<{
		message: { customType: string; content: string; display: boolean; details?: { goalId: string } };
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
	}>;
	notifications: Array<{ message: string; level: "info" | "warning" | "error" }>;
	emit(event: string, payload: Record<string, unknown>): Promise<unknown[]>;
}

function createFakePi(): FakePi {
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, ExtensionTool<Record<string, unknown>, unknown>>();
	const handlers = new Map<string, Handler[]>();
	const entries: SessionEntry[] = [];
	const sentMessages: FakePi["sentMessages"] = [];
	const notifications: FakePi["notifications"] = [];
	const branchEntries: SessionEntry[] = [];

	const pi = {
		appendEntry(customType, data) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			branchEntries.push(entry);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage(message, options) {
			const sentMessage: FakePi["sentMessages"][number]["message"] = {
				customType: message.customType,
				content: message.content,
				display: message.display,
			};
			if (message.details) {
				sentMessage.details = message.details as unknown as { goalId: string };
			}
			const sent: FakePi["sentMessages"][number] = { message: sentMessage };
			if (options) {
				sent.options = options;
			}
			sentMessages.push(sent);
		},
	} as ExtensionApi;

	const ctx: ExtensionCommandContext = {
		sessionManager: {
			getBranch() {
				return branchEntries;
			},
		},
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};

	return {
		pi,
		ctx,
		commands,
		tools,
		handlers,
		entries,
		branchEntries,
		sentMessages,
		notifications,
		async emit(event, payload) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler({ type: event, ...payload }, ctx));
			}
			return results;
		},
	};
}

function latestGoal(fake: FakePi): GoalState {
	const data = fake.entries.at(-1)?.data;
	assert.ok(data);
	return data as GoalState;
}

function resultText(result: { content: Array<{ type: "text"; text: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	return first.text;
}

function firstSentMessage(fake: FakePi): FakePi["sentMessages"][number] {
	const sent = fake.sentMessages[0];
	assert.ok(sent);
	return sent;
}

function firstContextMessage(result: { messages: ContextMessage[] }): ContextMessage {
	const message = result.messages[0];
	assert.ok(message);
	return message;
}

test("goal creation normalizes objective and budget", () => {
	const goal = createGoal("  Ship the thing  ", "1000");
	assert.equal(goal.objective, "Ship the thing");
	assert.equal(goal.status, "active");
	assert.equal(goal.tokenBudget, 1000);
	assert.equal(goal.tokensUsed, 0);
	assert.equal(goal.lastContinuationHadToolCall, true);
});

test("goal parser handles commands and budgets", () => {
	assert.deepEqual(parseGoalArgs("status"), { action: "status" });
	assert.deepEqual(parseGoalArgs("pause"), { action: "pause" });
	assert.deepEqual(parseGoalArgs("Do work --budget=42"), {
		action: "create",
		objective: "Do work",
		tokenBudget: 42,
		rest: ["work", "--budget=42"],
	});
	assert.deepEqual(parseGoalArgs("Do work --budget 42"), {
		action: "create",
		objective: "Do work",
		tokenBudget: 42,
		rest: ["work", "--budget", "42"],
	});
});

test("model tools enforce create and complete restrictions", async () => {
	const fake = createFakePi();
	createGoalExtension().register(fake.pi);

	const createTool = fake.tools.get("create_goal");
	const updateTool = fake.tools.get("update_goal");
	const getTool = fake.tools.get("get_goal");
	assert.ok(createTool);
	assert.ok(updateTool);
	assert.ok(getTool);

	const created = await createTool.execute("call-1", { objective: "Research Pi goals", token_budget: 50 });
	assert.match(resultText(created), /Research Pi goals/);

	const duplicate = await createTool.execute("call-2", { objective: "Replace it" });
	assert.match(resultText(duplicate), /already has a goal/);

	const rejected = await updateTool.execute("call-3", { status: "paused" });
	assert.match(resultText(rejected), /only mark the existing goal complete/);

	const completed = await updateTool.execute("call-4", { status: "complete" });
	assert.match(resultText(completed), /completionBudgetReport/);

	const read = await getTool.execute("call-5", {});
	assert.match(resultText(read), /"status": "complete"/);
});

test("user command persists create, pause, resume, clear transitions", async () => {
	const fake = createFakePi();
	createGoalExtension().register(fake.pi);
	const goalCommand = fake.commands.get("goal");
	assert.ok(goalCommand);

	await goalCommand.handler("Implement loop --budget 100", fake.ctx);
	assert.equal(latestGoal(fake).status, "active");
	assert.equal(latestGoal(fake).tokenBudget, 100);

	await goalCommand.handler("pause", fake.ctx);
	assert.equal(latestGoal(fake).status, "paused");

	await goalCommand.handler("resume", fake.ctx);
	assert.equal(latestGoal(fake).status, "active");

	await goalCommand.handler("status", fake.ctx);
	assert.match(fake.notifications.at(-1)?.message ?? "", /Tokens remaining/);

	await goalCommand.handler("clear", fake.ctx);
	assert.equal(latestGoal(fake).status, "cleared");
});

test("continuation prompt escapes objective and requires audit", () => {
	const prompt = renderContinuationPrompt({
		...createGoal("<do>&verify"),
		tokenBudget: 100,
		tokensUsed: 25,
		timeUsedSeconds: 7,
	});
	assert.match(prompt, /&lt;do&gt;&amp;verify/);
	assert.match(prompt, /completion audit/);
	assert.match(prompt, /Tokens remaining: 75/);
	assert.match(prompt, /call update_goal with status "complete"/);
});

test("continuation scheduling sends hidden trigger-turn message after deferral", () => {
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn) });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Keep going", 1000));

	const scheduledNow = extension.scheduleContinuation(fake.pi);
	assert.equal(scheduledNow, true);
	assert.equal(fake.sentMessages.length, 0);
	assert.equal(latestGoal(fake).continuationScheduled, true);

	const runScheduled = scheduled.shift();
	assert.ok(runScheduled);
	runScheduled();
	assert.equal(fake.sentMessages.length, 1);
	assert.equal(firstSentMessage(fake).message.customType, CONTINUATION_MESSAGE_TYPE);
	assert.equal(firstSentMessage(fake).message.display, false);
	assert.deepEqual(firstSentMessage(fake).options, { triggerTurn: true });
});

test("turn accounting tracks tools, tokens, elapsed time, and budget limit", async () => {
	let currentTime = 1_000;
	const fake = createFakePi();
	const extension = createGoalExtension({ clock: () => currentTime });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Budgeted", 10));

	await fake.emit("turn_start", { turnIndex: 1, timestamp: 1_000 });
	currentTime = 4_000;
	await fake.emit("tool_execution_end", { toolCallId: "t1", toolName: "read", result: {}, isError: false });
	await fake.emit("turn_end", {
		turnIndex: 1,
		message: { role: "assistant", content: [], usage: { input: 3, output: 4, reasoning: 5 } },
		toolResults: [],
	});

	const latest = latestGoal(fake);
	assert.equal(latest.tokensUsed, 12);
	assert.equal(latest.timeUsedSeconds, 3);
	assert.equal(latest.status, "budget_limited");
});

test("no-tool continuation suppresses future automatic continuation", async () => {
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn), clock: () => 1_000 });
	extension.register(fake.pi);
	const goal = createGoal("Avoid loops", 1000);
	extension.setGoalForTest(goal);

	extension.scheduleContinuation(fake.pi);
	const runScheduled = scheduled.shift();
	assert.ok(runScheduled);
	runScheduled();
	await fake.emit("turn_start", { turnIndex: 1, timestamp: 1_000 });
	await fake.emit("turn_end", {
		turnIndex: 1,
		message: { role: "assistant", content: [], usage: { total: 1 } },
		toolResults: [],
	});

	assert.equal(latestGoal(fake).continuationSuppressed, true);
	assert.equal(shouldScheduleContinuation(latestGoal(fake)), false);
});

test("context hook prunes stale continuation messages", async () => {
	const fake = createFakePi();
	const extension = createGoalExtension();
	extension.register(fake.pi);
	const active = createGoal("Active");
	extension.setGoalForTest(active);

	let result: { messages: ContextMessage[] } | undefined;
	for (const handler of fake.handlers.get("context") ?? []) {
		result = (await handler(
			{
				type: "context",
				messages: [
					{ role: "custom", customType: CONTINUATION_MESSAGE_TYPE, details: { goalId: active.goalId } },
					{ role: "custom", customType: CONTINUATION_MESSAGE_TYPE, details: { goalId: "old" } },
					{ role: "user", content: [{ type: "text", text: "hello" }] },
				],
			},
			fake.ctx,
		)) as { messages: ContextMessage[] };
	}

	assert.ok(result);
	assert.equal(result.messages.length, 2);
	assert.equal(firstContextMessage(result).details?.goalId, active.goalId);
});

test("restores latest goal from custom branch entries", () => {
	const first = createGoal("First");
	const second = transitionGoal(createGoal("Second"), "paused");
	const restored = readLatestGoalFromBranch([
		{ type: "custom", customType: "other", data: first },
		{ type: "custom", customType: "pi-goal-state", data: first },
		{ type: "custom", customType: "pi-goal-state", data: second },
	]);
	assert.equal(restored?.objective, "Second");
	assert.equal(restored?.status, "paused");
});

test("usage extraction supports common provider shapes", () => {
	assert.equal(extractTokenUsage({ usage: { total: 9 } }), 9);
	assert.equal(extractTokenUsage({ usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 4 } }), 9);
	assert.equal(extractTokenUsage({ tokens: { input: 2, output: 3 } }), 5);
	assert.equal(extractTokenUsage({}), 0);
});

test("goal response includes final budget report only on completion", () => {
	const active = createGoal("Report", 10);
	assert.equal(goalResponse(active).completionBudgetReport, undefined);
	const complete = transitionGoal({ ...active, tokensUsed: 7, timeUsedSeconds: 2 }, "complete");
	assert.match(goalResponse(complete).completionBudgetReport ?? "", /tokens used: 7 of 10; time used: 2 seconds/);
});
