import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTINUATION_MESSAGE_TYPE,
	createGoal,
	createGoalExtension,
	extractTokenUsage,
	formatGoalStatus,
	goalResponse,
	parseGoalArgs,
	readLatestGoalFromBranch,
	renderContinuationPrompt,
	shouldScheduleContinuation,
	transitionGoal,
	type ContextMessage,
	type ExtensionApi,
	type ExtensionCommandContext,
	type GoalState,
	type GoalLogger,
	type SessionEntry,
	type TextToolResult,
} from "../.pi/extensions/pi-goal/index.ts";

type CommandHandler = {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type Handler = (event: Record<string, unknown>, ctx: ExtensionCommandContext) => unknown | Promise<unknown>;
type FakeTool = {
	name: string;
	execute(toolCallId: string, params: Record<string, unknown>): Promise<TextToolResult<unknown>>;
};
type FakeMessage = {
	customType: string;
	content: string | unknown[];
	display: boolean;
	details?: unknown;
};
type FakeSendOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
type NotifyLevel = "info" | "warning" | "error";
type CapturedLog = { level: "debug" | "info" | "warn" | "error"; message: string; data: Record<string, unknown> };

interface FakePi {
	pi: ExtensionApi;
	ctx: ExtensionCommandContext;
	commands: Map<string, CommandHandler>;
	tools: Map<string, FakeTool>;
	handlers: Map<string, Handler[]>;
	entries: SessionEntry[];
	branchEntries: SessionEntry[];
	sentUserMessages: Array<{ content: string | unknown[]; options?: { deliverAs?: "steer" | "followUp" } }>;
	sentMessages: Array<{
		message: { customType: string; content: string; display: boolean; details?: { goalId: string } };
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
	}>;
	notifications: Array<{ message: string; level: "info" | "warning" | "error" }>;
	operations: string[];
	setIdle(idle: boolean): void;
	emit(event: string, payload: Record<string, unknown>): Promise<unknown[]>;
}

function createFakePi(): FakePi {
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, FakeTool>();
	const handlers = new Map<string, Handler[]>();
	const entries: SessionEntry[] = [];
	const sentUserMessages: FakePi["sentUserMessages"] = [];
	const sentMessages: FakePi["sentMessages"] = [];
	const notifications: FakePi["notifications"] = [];
	const branchEntries: SessionEntry[] = [];
	const operations: string[] = [];
	let idle = true;

	const pi = {
		appendEntry(customType: string, data?: unknown) {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			branchEntries.push(entry);
			operations.push(`append:${customType}`);
		},
		registerCommand(name: string, options: CommandHandler) {
			commands.set(name, options);
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool as unknown as FakeTool);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendMessage(message: FakeMessage, options?: FakeSendOptions) {
			const content = message.content;
			if (typeof content !== "string") {
				throw new TypeError("expected fake continuation message content to be a string");
			}
			const sentMessage: FakePi["sentMessages"][number]["message"] = {
				customType: message.customType,
				content,
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
		sendUserMessage(content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }) {
			const sent: FakePi["sentUserMessages"][number] = { content };
			if (options) {
				sent.options = options;
			}
			sentUserMessages.push(sent);
			operations.push("sendUserMessage");
		},
	} as unknown as ExtensionApi;

	const ctx = {
		sessionManager: {
			getBranch() {
				return branchEntries;
			},
		},
		ui: {
			notify(message: string, level: NotifyLevel = "info") {
				notifications.push({ message, level });
				operations.push("notify");
			},
		},
		isIdle() {
			return idle;
		},
	} as unknown as ExtensionCommandContext;

	return {
		pi,
		ctx,
		commands,
		tools,
		handlers,
		entries,
		branchEntries,
		sentUserMessages,
		sentMessages,
		notifications,
		operations,
		setIdle(nextIdle) {
			idle = nextIdle;
		},
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

function createCapturingLogger(logs: CapturedLog[]): GoalLogger {
	const capture =
		(level: CapturedLog["level"]) =>
		(data: Record<string, unknown>, message?: string): void => {
			logs.push({ level, message: message ?? "", data });
		};
	return {
		debug: capture("debug"),
		info: capture("info"),
		warn: capture("warn"),
		error: capture("error"),
	} as GoalLogger;
}

function messagesFor(logs: CapturedLog[], message: string): CapturedLog[] {
	return logs.filter((log) => log.message === message);
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

test("model tools return controlled errors for invalid mutations", async () => {
	const fake = createFakePi();
	createGoalExtension().register(fake.pi);

	const createTool = fake.tools.get("create_goal");
	const updateTool = fake.tools.get("update_goal");
	assert.ok(createTool);
	assert.ok(updateTool);

	await assert.rejects(() => createTool.execute("call-1", { objective: "   " }), /goal objective is required/);
	await assert.rejects(
		() => createTool.execute("call-2", { objective: "Bad budget", token_budget: 0 }),
		/token budget must be a positive number/,
	);

	const noGoalComplete = await updateTool.execute("call-3", { status: "complete" });
	assert.match(resultText(noGoalComplete), /does not have an active or paused goal/);
	assert.equal(fake.entries.length, 0);
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

test("user command auto-submits the objective after persisting a new goal", async () => {
	const fake = createFakePi();
	createGoalExtension().register(fake.pi);
	const goalCommand = fake.commands.get("goal");
	assert.ok(goalCommand);

	await goalCommand.handler("Implement loop --budget 100", fake.ctx);

	assert.equal(latestGoal(fake).objective, "Implement loop");
	assert.deepEqual(fake.sentUserMessages, [{ content: "Implement loop" }]);
	assert.deepEqual(fake.operations.slice(0, 2), ["append:pi-goal-state", "sendUserMessage"]);
});

test("user command traces persisted goal and objective auto-submit", async () => {
	const logs: CapturedLog[] = [];
	const fake = createFakePi();
	createGoalExtension({ logger: createCapturingLogger(logs) }).register(fake.pi);
	const goalCommand = fake.commands.get("goal");
	assert.ok(goalCommand);

	await goalCommand.handler("Trace this --budget 100", fake.ctx);

	assert.equal(messagesFor(logs, "pi-goal state changed").length, 1);
	assert.equal(messagesFor(logs, "pi-goal auto-submitting created objective").length, 1);
	assert.equal(messagesFor(logs, "pi-goal auto-submitting created objective")[0]?.data.delivery, "immediate");
	assert.equal(messagesFor(logs, "pi-goal auto-submitting created objective")[0]?.data.objectiveLength, "Trace this".length);
});

test("user command queues the auto-submitted objective when the agent is busy", async () => {
	const fake = createFakePi();
	fake.setIdle(false);
	createGoalExtension().register(fake.pi);
	const goalCommand = fake.commands.get("goal");
	assert.ok(goalCommand);

	await goalCommand.handler("Continue after current turn", fake.ctx);

	assert.deepEqual(fake.sentUserMessages, [{ content: "Continue after current turn", options: { deliverAs: "followUp" } }]);
});

test("user command does not auto-submit rejected duplicate goals", async () => {
	const fake = createFakePi();
	createGoalExtension().register(fake.pi);
	const goalCommand = fake.commands.get("goal");
	assert.ok(goalCommand);

	await goalCommand.handler("First goal", fake.ctx);
	await goalCommand.handler("Second goal", fake.ctx);

	assert.equal(latestGoal(fake).objective, "First goal");
	assert.deepEqual(
		fake.sentUserMessages.map((message) => message.content),
		["First goal"],
	);
});

test("clearing a goal removes get_goal state and prevents continuation", async () => {
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn) });
	extension.register(fake.pi);
	const goalCommand = fake.commands.get("goal");
	const getTool = fake.tools.get("get_goal");
	assert.ok(goalCommand);
	assert.ok(getTool);

	await goalCommand.handler("Implement then clear", fake.ctx);
	await goalCommand.handler("clear", fake.ctx);

	const read = await getTool.execute("call-1", {});
	assert.match(resultText(read), /"goal": null/);
	assert.equal(extension.scheduleContinuation(fake.pi), false);
	assert.equal(scheduled.length, 0);
});

test("continuation prompt escapes objective and requires audit", () => {
	const prompt = renderContinuationPrompt({
		...createGoal("<do>&verify"),
		tokenBudget: 100,
		tokensUsed: 25,
		timeUsedSeconds: 7,
	});
	assert.match(prompt, /&lt;do&gt;&amp;verify/);
	assert.match(prompt, /not a new human\/user message/);
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

test("continuation scheduling traces schedule and hidden trigger send", () => {
	const logs: CapturedLog[] = [];
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn), logger: createCapturingLogger(logs) });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Trace continuation", 1000));

	assert.equal(extension.scheduleContinuation(fake.pi), true);
	const runScheduled = scheduled.shift();
	assert.ok(runScheduled);
	runScheduled();

	assert.equal(messagesFor(logs, "pi-goal continuation scheduled").length, 1);
	assert.equal(messagesFor(logs, "pi-goal sending hidden continuation trigger").length, 1);
	assert.equal(messagesFor(logs, "pi-goal sending hidden continuation trigger")[0]?.data.continuationCount, 1);
	assert.equal(firstSentMessage(fake).message.display, false);
	assert.deepEqual(firstSentMessage(fake).options, { triggerTurn: true });
});

test("continuation suppression decision is traced with reason", async () => {
	const logs: CapturedLog[] = [];
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn), logger: createCapturingLogger(logs) });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Trace plan mode", 1000));

	await fake.emit("before_agent_start", { prompt: "[PLAN MODE ACTIVE] inspect only" });

	assert.equal(extension.scheduleContinuation(fake.pi), false);
	assert.equal(messagesFor(logs, "pi-goal continuation not scheduled")[0]?.data.reason, "plan_mode");
	assert.equal(scheduled.length, 0);
});

test("continuation scheduling is idempotent while a continuation is pending", () => {
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn) });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Only schedule once", 1000));

	assert.equal(extension.scheduleContinuation(fake.pi), true);
	assert.equal(extension.scheduleContinuation(fake.pi), false);
	assert.equal(scheduled.length, 1);

	const runScheduled = scheduled.shift();
	assert.ok(runScheduled);
	runScheduled();
	assert.equal(fake.sentMessages.length, 1);
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

test("turn accounting tracks detailed usage, costs, turns, and model breakdowns", async () => {
	let currentTime = 1_000;
	const fake = createFakePi();
	const extension = createGoalExtension({ clock: () => currentTime });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Detailed accounting", 100_000));

	await fake.emit("turn_start", { turnIndex: 1, timestamp: 1_000 });
	currentTime = 124_000;
	await fake.emit("turn_end", {
		turnIndex: 1,
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.4-mini",
			content: [],
			usage: {
				input: 1_000,
				output: 200,
				cacheRead: 700,
				cacheWrite: 50,
				totalTokens: 1_950,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
			},
		},
		toolResults: [],
	});

	const latest = latestGoal(fake);
	assert.equal(latest.tokensUsed, 1_950);
	assert.equal(latest.turnCount, 1);
	assert.equal(latest.timeUsedSeconds, 123);
	assert.deepEqual(latest.usage, {
		input: 1_000,
		output: 200,
		reasoning: 0,
		cacheRead: 700,
		cacheWrite: 50,
		total: 1_950,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
	});
	assert.equal(latest.usageByModel["openai-codex/gpt-5.4-mini"]?.total, 1_950);

	const status = formatGoalStatus(latest);
	assert.match(status, /Time used: 2m 3s \(123 seconds\)/);
	assert.match(status, /Turns: 1/);
	assert.match(status, /Tokens used: 1,950 total/);
	assert.match(status, /input: 1,000/);
	assert.match(status, /cache read: 700/);
	assert.match(status, /Cost: \$0\.037000/);
	assert.match(status, /openai-codex\/gpt-5\.4-mini: 1,950 total/);
});

test("continuation scheduling counts hidden goal reinstructions", () => {
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn) });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Count continuation prompts", 1000));

	assert.equal(extension.scheduleContinuation(fake.pi), true);
	const runScheduled = scheduled.shift();
	assert.ok(runScheduled);
	runScheduled();

	assert.equal(latestGoal(fake).continuationCount, 1);
	assert.match(formatGoalStatus(latestGoal(fake)), /Goal instructions: 1/);
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

test("user input resets no-tool continuation suppression", async () => {
	const fake = createFakePi();
	const extension = createGoalExtension({ clock: () => 1_000 });
	extension.register(fake.pi);
	const suppressedGoal = {
		...createGoal("Reset suppression", 1000),
		continuationSuppressed: true,
		lastContinuationHadToolCall: false,
	};
	extension.setGoalForTest(suppressedGoal);

	await fake.emit("input", { text: "continue", source: "interactive" });

	const current = extension.currentGoal;
	assert.ok(current);
	assert.equal(current.continuationSuppressed, false);
	assert.equal(current.lastContinuationHadToolCall, true);
	assert.equal(shouldScheduleContinuation(current), true);
});

test("plan mode suppresses automatic continuation until a normal prompt arrives", async () => {
	const scheduled: Array<() => void> = [];
	const fake = createFakePi();
	const extension = createGoalExtension({ scheduler: (fn) => scheduled.push(fn) });
	extension.register(fake.pi);
	extension.setGoalForTest(createGoal("Respect plan mode", 1000));

	await fake.emit("before_agent_start", { prompt: "[PLAN MODE ACTIVE] inspect only" });
	assert.equal(extension.scheduleContinuation(fake.pi), false);

	await fake.emit("before_agent_start", { prompt: "implement now" });
	assert.equal(extension.scheduleContinuation(fake.pi), true);
	assert.equal(scheduled.length, 1);
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

test("context hook prunes continuation messages for cleared goals", async () => {
	const fake = createFakePi();
	const extension = createGoalExtension();
	extension.register(fake.pi);
	const cleared = transitionGoal(createGoal("Cleared"), "cleared");
	extension.setGoalForTest(cleared);

	let result: { messages: ContextMessage[] } | undefined;
	for (const handler of fake.handlers.get("context") ?? []) {
		result = (await handler(
			{
				type: "context",
				messages: [
					{ role: "custom", customType: CONTINUATION_MESSAGE_TYPE, details: { goalId: cleared.goalId } },
					{ role: "user", content: [{ type: "text", text: "hello" }] },
				],
			},
			fake.ctx,
		)) as { messages: ContextMessage[] };
	}

	assert.ok(result);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0]?.customType, undefined);
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
	assert.equal(extractTokenUsage({ usage: { totalTokens: 9, cacheRead: 4, cacheWrite: 1 } }), 9);
	assert.equal(extractTokenUsage({}), 0);
});

test("goal response includes final budget report only on completion", () => {
	const active = createGoal("Report", 10);
	assert.equal(goalResponse(active).completionBudgetReport, undefined);
	const complete = transitionGoal({ ...active, tokensUsed: 7, timeUsedSeconds: 2 }, "complete");
	assert.match(goalResponse(complete).completionBudgetReport ?? "", /tokens used: 7 of 10; time used: 2s/);
});
