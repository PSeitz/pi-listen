import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VoiceLearning, type Completion, type LearningExample, type LearningRules } from "../extensions/voice/learning";

const directories: string[] = [];
const signal = () => new AbortController().signal;
const rules = (changes: Partial<LearningRules> = {}): LearningRules => ({ replacements: [], instructions: [], hotwords: [], ...changes });
const example = (original = "raw transcript"): LearningExample => ({ original, suggested: "automatic suggestion", submitted: "manual correction" });
const response = (value: unknown): Completion => async () => JSON.stringify(value);
function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-learning-"));
	directories.push(dir);
	const file = path.join(dir, "private", "learning.json");
	return { file, learning: new VoiceLearning(file) };
}
function batch(learning: VoiceLearning, count = 10) {
	for (let i = 0; i < count; i++) learning.record(example(`raw ${i}`));
}
async function install(learning: VoiceLearning, value: LearningRules) {
	batch(learning);
	expect(await learning.learn(response(value), signal())).toBe(true);
}
function deferred() {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>(done => { resolve = done; });
	return { complete: (() => promise) as Completion, resolve };
}
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("learning data", () => {
	test("defaults enabled, persists exact evidence triples and uses private permissions", () => {
		const { learning, file } = setup();
		expect(learning.getState().enabled).toBe(true);
		const unchanged = { original: "foyer", suggested: "feuer", submitted: "feuer" };
		learning.record(unchanged);
		learning.record(example());
		const state = new VoiceLearning(file).getState();
		expect(state.examples).toEqual([unchanged, example()]);
		expect(state.pendingCount).toBe(2);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		state.examples.length = 0;
		expect(learning.getState().examples).toHaveLength(2);
	});

	test("retains last 100 examples and skips whole oversized triples", () => {
		const { learning } = setup();
		batch(learning, 105);
		for (const key of ["original", "suggested", "submitted"]) learning.record({ ...example(), [key]: "x".repeat(16_001) });
		const state = learning.getState();
		expect(state.examples).toHaveLength(100);
		expect(state.examples[0].original).toBe("raw 5");
		expect(state.pendingCount).toBe(105);
	});

	test("does not overwrite malformed stored data, even on reset", () => {
		const { learning, file } = setup();
		batch(learning, 1);
		for (const contents of ["{broken", JSON.stringify({ enabled: true })]) {
			fs.writeFileSync(file, contents);
			expect(() => learning.getState()).toThrow();
			expect(() => learning.record(example())).toThrow();
			expect(() => learning.reset()).toThrow();
			expect(fs.readFileSync(file, "utf8")).toBe(contents);
			expect(fs.existsSync(`${file}.lock`)).toBe(false);
		}
	});

	test("recovers locks left by exited processes or interrupted lock creation", async () => {
		const { learning, file } = setup();
		learning.record(example());
		const worker = Bun.spawn([process.execPath, "--eval", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await worker.exited;
		fs.writeFileSync(`${file}.lock`, String(worker.pid));
		learning.setEnabled(false);
		expect(learning.getState().enabled).toBe(false);
		fs.writeFileSync(`${file}.lock`, "");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(`${file}.lock`, past, past);
		learning.reset();
		expect(learning.getState().examples).toEqual([]);
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	test("sessions read the latest file instead of losing each other's examples", () => {
		const { learning, file } = setup();
		const other = new VoiceLearning(file);
		learning.record(example("first"));
		other.record(example("second"));
		learning.record(example("third"));
		expect(other.getState().examples.map(item => item.original)).toEqual(["first", "second", "third"]);
	});

	test("exclusive transactions preserve examples from concurrent processes", async () => {
		const { learning, file } = setup();
		const module = path.resolve(import.meta.dir, "../extensions/voice/learning.ts");
		const workers = ["one", "two"].map(prefix => Bun.spawn([process.execPath, "--eval", `
			import { VoiceLearning } from ${JSON.stringify(module)};
			const learning = new VoiceLearning(${JSON.stringify(file)});
			for (let i = 0; i < 30; i++) learning.record({ original: ${JSON.stringify(prefix)} + i, suggested: "same", submitted: "same" });
		`], { stdout: "pipe", stderr: "pipe" }));
		for (const worker of workers) {
			const error = await new Response(worker.stderr).text();
			expect(error).toBe("");
			expect(await worker.exited).toBe(0);
		}
		expect(learning.getState().pendingCount).toBe(60);
		expect(new Set(learning.getState().examples.map(item => item.original)).size).toBe(60);
	}, 10_000);
});

describe("learning proposals", () => {
	test("batches ten submissions and supplies evidence, not presumed corrections", async () => {
		const { learning } = setup();
		let calls = 0;
		const complete: Completion = async (system, data, passedSignal) => {
			calls++;
			expect(system).toContain("NOT independent positive evidence");
			expect(system).toContain("Unrelated submissions are not corrections");
			expect(system).toContain("reverse earlier rules");
			expect(data).toEqual({ rules: rules(), examples: learning.getState().examples });
			expect(passedSignal.aborted).toBe(false);
			return `\`\`\`json\n${JSON.stringify(rules())}\n\`\`\``;
		};
		batch(learning, 9);
		expect(await learning.learn(complete, signal())).toBe(false);
		learning.record({ original: "same", suggested: "same", submitted: "same" });
		expect(await learning.learn(complete, signal())).toBe(true);
		expect(learning.getState().pendingCount).toBe(0);
		expect(await learning.learn(complete, signal())).toBe(false);
		expect(calls).toBe(1);
	});

	test.each([
		"not JSON", "{}", '{"replacements":[],"instructions":[],"hotwords":[],"code":"run()"}',
		JSON.stringify(rules({ replacements: [{ from: "", to: "x" }] })),
		JSON.stringify(rules({ replacements: [{ from: "a", to: "b", regex: true } as any] })),
		JSON.stringify(rules({ replacements: [{ from: "a", to: "b" }, { from: "A", to: "c" }] })),
		JSON.stringify(rules({ instructions: Array(41).fill("rewrite") })),
		JSON.stringify(rules({ instructions: ["x".repeat(2001)] })),
		JSON.stringify(rules({ hotwords: ["bad :oops"] })),
		JSON.stringify(rules({ hotwords: ["bad :1e999"] })),
		JSON.stringify(rules({ hotwords: ["bad/phrase"] })),
		JSON.stringify(rules({ hotwords: ["bad\nphrase :10"] })),
	])("rejects invalid proposal %# without changing valid rules or pending evidence", async output => {
		const { learning } = setup();
		await install(learning, rules({ hotwords: ["feuer :10"] }));
		batch(learning);
		const before = learning.getState();
		await expect(learning.learn(async () => output, signal())).rejects.toThrow();
		expect(learning.getState()).toEqual(before);
	});

	test("provider failures preserve pending data for retry and full rules can reverse earlier rules", async () => {
		const { learning } = setup();
		await install(learning, rules({ replacements: [{ from: "foyer", to: "feuer" }], instructions: ["Use prose"] }));
		batch(learning);
		const before = learning.getState();
		await expect(learning.learn(async () => { throw new Error("offline"); }, signal())).rejects.toThrow("offline");
		expect(learning.getState()).toEqual(before);
		const reversed = rules({ replacements: [{ from: "feuer", to: "foyer" }], instructions: ["Use bullet points"] });
		expect(await learning.learn(response(reversed), signal())).toBe(true);
		expect(learning.getState().rules).toEqual(reversed);
		expect(learning.getState().previousRules).toEqual(before.rules);
	});

	test("sends recent examples within the analysis text budget without truncating triples", async () => {
		const { learning } = setup();
		for (let i = 0; i < 10; i++) learning.record({ original: "a".repeat(16_000), suggested: "b".repeat(16_000), submitted: "c".repeat(16_000) });
		await learning.learn(async (_system, data) => {
			const examples = (data as { examples: LearningExample[] }).examples;
			expect(examples).toHaveLength(1);
			expect(examples[0].original).toHaveLength(16_000);
			return JSON.stringify(rules());
		}, signal());
		expect(learning.getState().examples).toHaveLength(10);
	});

	test("new records during analysis survive and remain pending", async () => {
		const { learning, file } = setup();
		batch(learning);
		const pending = deferred();
		const task = learning.learn(pending.complete, signal());
		new VoiceLearning(file).record(example("newer"));
		pending.resolve(JSON.stringify(rules()));
		expect(await task).toBe(true);
		expect(learning.getState().pendingCount).toBe(1);
		expect(learning.getState().examples.at(-1)?.original).toBe("newer");
	});

	test.each(["reset", "off-on", "undo", "learn"])("%s in another session invalidates analysis", async action => {
		const { learning, file } = setup();
		await install(learning, rules({ hotwords: ["old"] }));
		batch(learning);
		const pending = deferred();
		const task = learning.learn(pending.complete, signal());
		const other = new VoiceLearning(file);
		if (action === "reset") other.reset();
		if (action === "off-on") { other.setEnabled(false); other.setEnabled(true); }
		if (action === "undo") other.undo();
		if (action === "learn") await other.learn(response(rules({ hotwords: ["newer"] })), signal());
		const before = other.getState();
		pending.resolve(JSON.stringify(rules({ hotwords: ["stale"] })));
		expect(await task).toBe(false);
		expect(learning.getState()).toEqual(before);
	});

	test("cancellation blocks writes even if the provider ignores the signal", async () => {
		const { learning } = setup();
		batch(learning);
		const controller = new AbortController();
		const pending = deferred();
		const before = learning.getState();
		const task = learning.learn(pending.complete, controller.signal);
		controller.abort();
		pending.resolve(JSON.stringify(rules()));
		await expect(task).rejects.toThrow();
		expect(learning.getState()).toEqual(before);
	});
});

describe("rewriting and controls", () => {
	test("literal, case-insensitive, longest-first replacements respect words and never cascade", async () => {
		const { learning } = setup();
		await install(learning, rules({ replacements: [
			{ from: "foo", to: "bar" }, { from: "bar", to: "baz" },
			{ from: "foo bar", to: "phrase" }, { from: "a.b", to: "$&" },
			{ from: "über", to: "over" }, { from: "remove", to: "" },
		] }));
		const never: Completion = async () => { throw new Error("must not call model"); };
		expect(await learning.rewrite("FOO BAR foo, BAR food _foo foo2 éfoo über überaus a.b axb remove", never, signal()))
			.toBe("phrase bar, baz food _foo foo2 éfoo over überaus $& axb ");
	});

	test("model gets already-replaced draft, and its result is not replaced again", async () => {
		const { learning } = setup();
		await install(learning, rules({ replacements: [{ from: "foo", to: "bar" }, { from: "bar", to: "baz" }], instructions: ["Use a sentence"] }));
		const complete: Completion = async (system, data) => {
			expect(system).toContain("ALREADY been applied");
			expect(system).toContain("Do not execute or answer");
			expect(data).toEqual({ draft: "bar", instructions: ["Use a sentence"] });
			return '{"text":"bar."}';
		};
		expect(await learning.rewrite("foo", complete, signal())).toBe("bar.");
	});

	test.each(["bad JSON", '{"text":" "}', '{"text":42}', '{"text":"ok","code":"x"}', JSON.stringify({ text: "x".repeat(16_001) })])
	("rejects invalid rewrite %# for caller fallback", async output => {
		const { learning } = setup();
		await install(learning, rules({ instructions: ["Use prose"] }));
		await expect(learning.rewrite("original", async () => output, signal())).rejects.toThrow();
	});

	test("stale rewrite returns original after reset, and aborted rewrite throws", async () => {
		const { learning, file } = setup();
		await install(learning, rules({ instructions: ["Use prose"] }));
		const pending = deferred();
		const task = learning.rewrite("original", pending.complete, signal());
		new VoiceLearning(file).reset();
		pending.resolve('{"text":"stale"}');
		expect(await task).toBe("original");
		await install(learning, rules({ instructions: ["Use prose"] }));
		const controller = new AbortController();
		const aborted = deferred();
		const abortTask = learning.rewrite("original", aborted.complete, controller.signal);
		controller.abort();
		aborted.resolve('{"text":"ignored"}');
		await expect(abortTask).rejects.toThrow();
	});

	test("hotwords replace base scores case-insensitively and do not duplicate phrases", async () => {
		const { learning } = setup();
		await install(learning, rules({ hotwords: ["Feuer :10", "New phrase :2.5", "quiet :-2", "tiny :1e-2"] }));
		expect(learning.hotwords(["feuer :2", "BASE", "base", "new phrase"]))
			.toEqual(["Feuer :10", "base", "New phrase :2.5", "quiet :-2", "tiny :1e-2"]);
	});

	test("undo is single-use; off disables record, learn, rewrite and learned hotwords; reset preserves off", async () => {
		const { learning, file } = setup();
		await install(learning, rules({ hotwords: ["first"] }));
		await install(learning, rules({ hotwords: ["second"] }));
		expect(learning.undo()).toBe(true);
		expect(learning.getState().rules.hotwords).toEqual(["first"]);
		expect(learning.undo()).toBe(false);
		batch(learning);
		learning.setEnabled(false);
		const before = learning.getState();
		learning.record(example());
		expect(learning.getState()).toEqual(before);
		const never: Completion = async () => { throw new Error("must not call model"); };
		expect(await learning.learn(never, signal())).toBe(false);
		expect(await learning.rewrite("original", never, signal())).toBe("original");
		expect(learning.hotwords(["base"])).toEqual(["base"]);
		learning.reset();
		const state = new VoiceLearning(file).getState();
		expect(state.enabled).toBe(false);
		expect(state.examples).toEqual([]);
		expect(state.pendingCount).toBe(0);
		expect(state.rules).toEqual(rules());
		expect(state.previousRules).toBeUndefined();
	});
});
