declare module "node:assert/strict" {
	interface Assertion {
		equal(actual: unknown, expected: unknown, message?: string): void;
		deepEqual(actual: unknown, expected: unknown, message?: string): void;
		match(actual: string, expected: RegExp, message?: string): void;
		ok(value: unknown, message?: string): asserts value;
	}

	const assert: Assertion;
	export default assert;
}

declare module "node:test" {
	export function test(name: string, fn: () => void | Promise<void>): void;
}
