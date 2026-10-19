import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VoiceLearning, type Completion, type LearningRules } from "../extensions/voice/learning";
import { VoiceLearningSession } from "../extensions/voice/learning-session";
import { learningCompletion } from "../extensions/voice/learning-model";

const directories: string[] = [];
const rules: LearningRules = { replacements: [{ from: "fire", to: "feuer" }], instructions: [], hotwords: [] };
const never: Completion = async () => { throw new Error("unexpected model call"); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-session-"));
	directories.push(dir);
	const learning = new VoiceLearning(path.join(dir, "learning.json"));
	const session = new VoiceLearningSession(learning);
	const notices: string[] = [];
	let text = "";
	const editor = {
		getEditorText: () => text,
		setEditorText: (next: string) => { text = next; },
		notify: (message: string) => { notices.push(message); },
	};
	return { learning, session, editor, notices };
}
async function install(learning: VoiceLearning, next = rules) {
	for (let i = 0; i < 10; i++) learning.record({ original: "fire", suggested: "fire", submitted: "feuer" });
	await learning.learn(async () => JSON.stringify(next), new AbortController().signal);
}
function deferred() {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>(done => { resolve = done; });
	return { complete: (() => promise) as Completion, resolve };
}
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("records only matched accepted user messages, not attempted or unrelated sends", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	editor.setEditorText("fire");
	await session.finish("fire", "", never, editor);
	session.stageSubmission("feuer");
	expect(learning.getState().examples).toEqual([]);
	session.confirmSubmission("unrelated extension message", never, editor);
	expect(learning.getState().examples).toEqual([]);
	expect(session.confirmSubmission("feuer", never, editor)).toBe(false);
	expect(learning.getState().examples).toEqual([{ original: "fire", suggested: "fire", submitted: "feuer" }]);
	session.confirmSubmission("feuer", never, editor);
	expect(learning.getState().pendingCount).toBe(1);
	await tick();
});

test("auto-submit confirms once and exposes automatic origin for editor clearing", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.preview("fire");
	session.stageSubmission("fire", true);
	expect(session.confirmSubmission("fire", never, editor)).toBe(true);
	expect(session.confirmSubmission("fire", never, editor)).toBe(false);
	expect(learning.getState().pendingCount).toBe(1);
	await tick();
});

test("rewrites broad words while preserving prefix whitespace", async () => {
	const { learning, session, editor } = setup();
	await install(learning);
	session.begin("Please ");
	editor.setEditorText("Please  fire and fire cache");
	expect(await session.finish("fire and fire cache", "Please ", never, editor)).toBe("Please  feuer and feuer cache");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "Please  fire and fire cache", suggested: "Please  feuer and feuer cache", submitted: "Please  feuer and feuer cache" });
	await tick();
});

test("preserves manual corrections between appended recordings", async () => {
	const { learning, session, editor } = setup();
	await install(learning);
	session.begin("");
	editor.setEditorText("fire");
	await session.finish("fire", "", never, editor);
	editor.setEditorText("FoyerCache");
	session.begin(editor.getEditorText());
	editor.setEditorText("FoyerCache fails");
	await session.finish("fails", "FoyerCache", never, editor);
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "fire fails", suggested: "feuer fails", submitted: "FoyerCache fails" });
	await tick();
});

test("streaming and final STT results preserve edits made before recognition finishes", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	expect(session.showTranscript("fix staging", "", editor)).toBe(true);
	editor.setEditorText("fix production");
	expect(session.showTranscript("fix staging now", "", editor)).toBe(false);
	expect(editor.getEditorText()).toBe("fix production");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "fix staging now", suggested: "fix staging", submitted: "fix production" });
	await tick();
});

test("local STT cannot overwrite typing before its first result or claim it as correction evidence", () => {
	const { learning, session, editor } = setup();
	session.begin("");
	editor.setEditorText("typed while transcribing");
	expect(session.showTranscript("raw speech", "", editor)).toBe(false);
	expect(editor.getEditorText()).toBe("typed while transcribing");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples).toEqual([]);
	expect(session.restoreOriginal(editor)).toBe(true);
	expect(editor.getEditorText()).toBe("raw speech");
});

test("clearing an empty editor also cancels a local recording awaiting its first result", () => {
	const { session } = setup();
	const generation = session.begin("");
	session.observeEditor("");
	expect(session.isCurrent(generation)).toBe(false);
});

test("clearing the editor abandons pending evidence", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.preview("fix staging");
	session.observeEditor("");
	session.stageSubmission("fix production");
	session.confirmSubmission("fix production", never, editor);
	expect(learning.getState().examples).toEqual([]);
});

test.each(["edit", "clear", "submit", "new recording", "shutdown", "raw"])("late rewrite cannot overwrite %s", async action => {
	const { learning, session, editor } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	session.begin("");
	editor.setEditorText("fire");
	const pending = deferred();
	const task = session.finish("fire", "", pending.complete, editor);
	if (action === "edit") editor.setEditorText("manually corrected");
	if (action === "clear") { editor.setEditorText(""); session.observeEditor(""); }
	if (action === "submit") { session.stageSubmission("feuer"); editor.setEditorText(""); }
	if (action === "new recording") { session.begin("new"); editor.setEditorText("new recording"); }
	if (action === "shutdown") { session.clear(); editor.setEditorText("other session"); }
	if (action === "raw") expect(session.restoreOriginal(editor)).toBe(true);
	const before = editor.getEditorText();
	pending.resolve('{"text":"late rewrite"}');
	expect(await task).toBe(null);
	expect(editor.getEditorText()).toBe(before);
	if (action === "submit") {
		session.confirmSubmission("feuer", never, editor);
		expect(learning.getState().examples.at(-1)).toEqual({ original: "fire", suggested: "fire", submitted: "feuer" });
		await tick();
	}
});

test("model failures leave raw text available and warn", async () => {
	const { learning, session, editor, notices } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	session.begin("");
	editor.setEditorText("fire");
	expect(await session.finish("fire", "", async () => { throw new Error("offline"); }, editor)).toBe("fire");
	expect(notices.join(" ")).toContain("offline");
});

test("raw recovery remains reversal evidence, not an accepted automatic rewrite", async () => {
	const { learning, session, editor } = setup();
	await install(learning);
	session.begin("");
	editor.setEditorText("fire");
	await session.finish("fire", "", never, editor);
	expect(session.restoreOriginal(editor)).toBe(true);
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "fire", suggested: "feuer", submitted: "fire" });
	await tick();
});

test("another ten submissions during analysis trigger another batch without waiting for an eleventh", async () => {
	const { learning, session, editor } = setup();
	const pending = deferred();
	let calls = 0;
	const complete: Completion = async (...args) => {
		calls++;
		return calls === 1 ? pending.complete(...args) : JSON.stringify(rules);
	};
	for (let i = 0; i < 20; i++) {
		session.begin("");
		session.preview(`fire ${i}`);
		session.stageSubmission(`feuer ${i}`);
		session.confirmSubmission(`feuer ${i}`, complete, editor);
		await tick();
	}
	expect(calls).toBe(1);
	pending.resolve(JSON.stringify(rules));
	await tick();
	await tick();
	expect(calls).toBe(2);
	expect(learning.getState().pendingCount).toBe(0);
});

test("analysis failure waits for another submission rather than retrying in a loop", async () => {
	const { session, editor, learning } = setup();
	let calls = 0;
	const complete: Completion = async () => { calls++; throw new Error("offline"); };
	for (let i = 0; i < 10; i++) {
		session.begin(""); session.preview("fire"); session.stageSubmission("feuer");
		session.confirmSubmission("feuer", complete, editor);
		await tick();
	}
	await tick();
	expect(calls).toBe(1);
	expect(learning.getState().pendingCount).toBe(10);
});

test("model adapter uses active model registry, sends no history/tools, rejects incomplete responses", async () => {
	let call: any[] = [];
	let stopReason = "stop";
	const model = { id: "selected-model" };
	const complete = learningCompletion({ model, modelRegistry: {
		streamSimple(...args: any[]) {
			call = args;
			return { result: async () => ({ stopReason, content: [{ type: "thinking", thinking: "private" }, { type: "text", text: '{"text":"feuer"}' }] }) };
		},
	} } as any);
	const signal = new AbortController().signal;
	expect(await complete("rewrite only", { draft: "fire" }, signal)).toBe('{"text":"feuer"}');
	expect(call[0]).toBe(model);
	expect(call[1].systemPrompt).toBe("rewrite only");
	expect(call[1].messages).toHaveLength(1);
	expect(call[1].messages[0].content).toBe('{"draft":"fire"}');
	expect(call[1].tools).toBeUndefined();
	expect(call[2].signal).toBe(signal);
	stopReason = "length";
	await expect(complete("rewrite only", {}, signal)).rejects.toThrow("length");
});
