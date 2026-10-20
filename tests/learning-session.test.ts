import { afterEach, expect, test } from "bun:test";
import { Editor as TuiEditor } from "@mariozechner/pi-tui";
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
	let visibleText = "";
	const statuses = new Map<string, string>();
	const editor = {
		getEditorText: () => text,
		setEditorText: (next: string) => { text = next; },
		// Like Pi, setEditorText changes state but setStatus requests a redraw.
		setStatus: (key: string, value: string | undefined) => {
			if (value === undefined) statuses.delete(key); else statuses.set(key, value);
			visibleText = text;
		},
		notify: (message: string) => { notices.push(message); },
	};
	return { learning, session, editor, notices, statuses, getVisibleText: () => visibleText };
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

test("accepted auto-submit cannot clear the editor after the user takes control", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.preview("fire");
	session.stageSubmission("fire", true);
	session.takeEditorControl();
	expect(session.confirmSubmission("fire", never, editor)).toBe(false);
	expect(learning.getState().pendingCount).toBe(1);
	await tick();
});

test("rewrites broad words while preserving prefix whitespace", async () => {
	const { learning, session, editor } = setup();
	await install(learning);
	session.begin("Please ");
	editor.setEditorText("Please ");
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
	await session.finish("fire", "", never, editor);
	editor.setEditorText("FoyerCache");
	session.begin(editor.getEditorText());
	await session.finish("fails", "FoyerCache", never, editor);
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "fire fails", suggested: "feuer fails", submitted: "FoyerCache fails" });
	await tick();
});

test("streaming results never write to the editor and final STT preserves manual typing", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.rememberTranscript("fix staging");
	expect(editor.getEditorText()).toBe("");
	editor.setEditorText("fix production");
	session.rememberTranscript("fix staging now");
	expect(await session.finish("fix staging now", "", never, editor)).toBe(null);
	expect(editor.getEditorText()).toBe("fix production");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples).toEqual([]);
	expect(session.restoreOriginal(editor)).toBe(true);
	expect(editor.getEditorText()).toBe("fix staging now");
});

test("local STT cannot overwrite typing before its first result or claim it as correction evidence", async () => {
	const { learning, session, editor } = setup();
	session.begin("");
	editor.setEditorText("typed while transcribing");
	expect(await session.finish("raw speech", "", never, editor)).toBe(null);
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
		expect(learning.getState().examples).toHaveLength(10); // No new evidence: speech was never inserted.
		await tick();
	}
});

test.each(["cursor movement", "typing then undo", "keypress before editor update"])("%s cancels pending insertion, even with unchanged editor text", async action => {
	const { learning, session, editor } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	session.begin("");
	session.rememberTranscript("fire");
	const pending = deferred();
	let signal!: AbortSignal;
	const task = session.finish("fire", "", (...args) => {
		signal = args[2];
		return pending.complete(...args);
	}, editor);
	session.takeEditorControl();
	if (action === "typing then undo") {
		editor.setEditorText("manual edit");
		editor.setEditorText("");
	}
	expect(signal.aborted).toBe(true);
	pending.resolve('{"text":"late rewrite"}');
	expect(await task).toBe(null);
	expect(editor.getEditorText()).toBe("");
	session.rememberTranscript("later STT result");
	expect(await session.finish("fire", "", never, editor)).toBe(null);
	session.stageSubmission("manual correction");
	session.confirmSubmission("manual correction", never, editor);
	expect(learning.getState().examples).toHaveLength(10);
	await tick();
});

test("only starting another recording permits automatic insertion after user input", async () => {
	const { session, editor } = setup();
	session.begin("");
	session.takeEditorControl();
	expect(await session.finish("late transcript", "", never, editor)).toBe(null);
	expect(editor.getEditorText()).toBe("");
	session.begin("");
	expect(await session.finish("new recording", "", never, editor)).toBe("new recording");
	expect(editor.getEditorText()).toBe("new recording");
});

test("transcription and correction finish off-editor, then insert exactly once", async () => {
	const { learning, session, editor } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	const writes: string[] = [];
	const tracked = { ...editor, setEditorText(text: string) { writes.push(text); editor.setEditorText(text); } };
	session.begin("");
	session.rememberTranscript("raw speech");
	session.rememberTranscript("raw speech final");
	const pending = deferred();
	const task = session.finish("raw speech final", "", pending.complete, tracked);
	expect(writes).toEqual([]);
	expect(editor.getEditorText()).toBe("");
	pending.resolve('{"text":"corrected speech"}');
	expect(await task).toBe("corrected speech");
	expect(writes).toEqual(["corrected speech"]);
	// A duplicate completion must not replace the now-visible draft.
	expect(await session.finish("raw speech final", "", never, tracked)).toBe(null);
	expect(writes).toEqual(["corrected speech"]);
	session.stageSubmission("manual correction");
	session.confirmSubmission("manual correction", never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "raw speech final", suggested: "corrected speech", submitted: "manual correction" });
	await tick();
});

test.each(["", "existing draft"])("unchanged input events do not cancel insertion into %j", async prefix => {
	const { learning, session, editor, statuses, getVisibleText } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	editor.setEditorText(prefix);
	session.begin(prefix);
	const pending = deferred();
	const task = session.finish("fire", prefix, pending.complete, editor);
	expect(statuses.has("voice-draft")).toBe(true);
	session.observeInput(editor); // e.g. a terminal report or a consumed key
	if (!prefix) session.observeInput(editor, true); // cursor movement in an empty editor
	await tick();
	pending.resolve('{"text":"feuer"}');
	const expected = prefix ? `${prefix} feuer` : "feuer";
	expect(await task).toBe(expected);
	expect(getVisibleText()).toBe(expected); // No keypress needed to reveal the result.
	expect(statuses.size).toBe(0);
});

test.each(["typing", "typing then undo", "navigation"])("actual %s still prevents late insertion", async action => {
	const { learning, session, editor, statuses } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	const prefix = action === "navigation" ? "existing draft" : "";
	editor.setEditorText(prefix);
	session.begin(prefix);
	const pending = deferred();
	const task = session.finish("fire", prefix, pending.complete, editor);
	session.observeInput(editor, action === "navigation");
	if (action !== "navigation") editor.setEditorText("my typing");
	await tick();
	if (action === "typing then undo") {
		session.observeInput(editor);
		editor.setEditorText("");
		await tick();
	}
	const expected = editor.getEditorText();
	pending.resolve('{"text":"feuer"}');
	expect(await task).toBe(null);
	expect(editor.getEditorText()).toBe(expected);
	expect(statuses.size).toBe(0);
});

test("input observation from an older recording cannot cancel a new recording", async () => {
	const { session, editor } = setup();
	session.begin("");
	session.observeInput(editor);
	editor.setEditorText("new prefix");
	session.begin("new prefix");
	await tick();
	expect(await session.finish("speech", "new prefix", never, editor)).toBe("new prefix speech");
});

test("Pi editor receives a redraw after asynchronous voice insertion without keyboard input", async () => {
	const { session } = setup();
	let rendered = "";
	let redraws = 0;
	const tui = { terminal: { rows: 24 }, requestRender() { redraws++; rendered = component.render(80).join("\n"); } };
	const component = new TuiEditor(tui as any, { borderColor: (text: string) => text } as any);
	component.setText("not yet painted");
	expect(redraws).toBe(0); // Reproduce Pi's setEditorText behavior.
	component.setText("");
	const editor = {
		getEditorText: () => component.getText(),
		setEditorText: (text: string) => component.setText(text),
		setStatus: (_key: string, _text: string | undefined) => tui.requestRender(),
		notify: () => {},
	};
	session.begin("");
	expect(await session.finish("visible without a cursor key", "", never, editor)).toBe("visible without a cursor key");
	expect(rendered).toContain("visible without a cursor key");
});

test("raw recovery requests a redraw rather than waiting for a keypress", () => {
	const { session, editor, getVisibleText } = setup();
	session.begin("");
	session.rememberTranscript("raw speech");
	expect(session.restoreOriginal(editor)).toBe(true);
	expect(getVisibleText()).toBe("raw speech");
});

test("model failures leave raw text available and warn", async () => {
	const { learning, session, editor, notices } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	session.begin("");
	expect(await session.finish("fire", "", async () => { throw new Error("offline"); }, editor)).toBe("fire");
	expect(notices.join(" ")).toContain("offline");
});

test("raw recovery remains reversal evidence, not an accepted automatic rewrite", async () => {
	const { learning, session, editor } = setup();
	await install(learning);
	session.begin("");
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
