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
	const editor = {
		getEditorText: () => text,
		setEditorText: (next: string) => { text = next; },
		setStatus: (_key: string, _value: string | undefined) => { visibleText = text; },
		notify: (message: string) => { notices.push(message); },
	};
	return { learning, session, editor, notices, getVisibleText: () => visibleText };
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
	session.finish("fire", "", editor);
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

test.each([false, true])("auto-submit confirms once and only clears an untouched draft (edited: %j)", async edited => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.finish("fire", "", editor);
	session.stageSubmission("fire", true);
	if (edited) session.takeEditorControl();
	expect(session.confirmSubmission("fire", never, editor)).toBe(!edited);
	expect(session.confirmSubmission("fire", never, editor)).toBe(false);
	expect(learning.getState().pendingCount).toBe(1);
	await tick();
});

test("applies broad static replacements synchronously, inserts once, and ignores legacy instructions", async () => {
	const { learning, session, editor, getVisibleText } = setup();
	await install(learning, { ...rules, instructions: ["Remove filler words"] });
	const writes: string[] = [];
	const tracked = { ...editor, setEditorText(text: string) { writes.push(text); editor.setEditorText(text); } };
	session.begin("");
	session.rememberTranscript("fire");
	session.rememberTranscript("fire and fire cache");
	expect(writes).toEqual([]);
	// No Completion argument, Promise, network request, or deferred editor write.
	expect(session.finish("fire and fire cache", "", tracked)).toBe("feuer and feuer cache");
	expect(writes).toEqual(["feuer and feuer cache"]);
	expect(getVisibleText()).toBe("feuer and feuer cache");
	expect(session.finish("fire", "", tracked)).toBe(null);
	editor.setEditorText("my manual correction");
	await tick();
	expect(editor.getEditorText()).toBe("my manual correction");
	expect(writes).toHaveLength(1);
});

test("preserves prefix whitespace and manual corrections between appended recordings", async () => {
	const { learning, session, editor } = setup();
	await install(learning);
	editor.setEditorText("Please ");
	session.begin("Please ");
	expect(session.finish("fire", "Please ", editor)).toBe("Please  feuer");
	editor.setEditorText("FoyerCache");
	session.begin(editor.getEditorText());
	expect(session.finish("fails", "FoyerCache", editor)).toBe("FoyerCache fails");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "Please  fire fails", suggested: "Please  feuer fails", submitted: "FoyerCache fails" });
	await tick();
});

test("typing during transcription prevents insertion and is not correction evidence", () => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.rememberTranscript("raw speech");
	expect(editor.getEditorText()).toBe("");
	editor.setEditorText("typed while transcribing");
	expect(session.finish("raw speech final", "", editor)).toBe(null);
	expect(editor.getEditorText()).toBe("typed while transcribing");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples).toEqual([]);
	expect(session.restoreOriginal(editor)).toBe(true);
	expect(editor.getEditorText()).toBe("raw speech final");
});

test("clearing the editor abandons pending evidence", () => {
	const { learning, session, editor } = setup();
	session.begin("");
	session.finish("fix staging", "", editor);
	session.observeEditor("");
	session.stageSubmission("fix production");
	session.confirmSubmission("fix production", never, editor);
	expect(learning.getState().examples).toEqual([]);
});

test.each(["", "existing draft"])("unchanged input events do not cancel insertion into %j", async prefix => {
	const { session, editor } = setup();
	editor.setEditorText(prefix);
	session.begin(prefix);
	session.observeInput(editor);
	if (!prefix) session.observeInput(editor, true);
	await tick();
	expect(session.finish("speech", prefix, editor)).toBe(prefix ? `${prefix} speech` : "speech");
});

test.each(["typing", "typing then undo", "navigation"])("actual %s prevents late transcription insertion", async action => {
	const { session, editor } = setup();
	const prefix = action === "navigation" ? "existing draft" : "";
	editor.setEditorText(prefix);
	session.begin(prefix);
	session.observeInput(editor, action === "navigation");
	if (action !== "navigation") editor.setEditorText("my typing");
	await tick();
	if (action === "typing then undo") {
		session.observeInput(editor);
		editor.setEditorText("");
		await tick();
	}
	const expected = editor.getEditorText();
	expect(session.finish("fire", prefix, editor)).toBe(null);
	expect(editor.getEditorText()).toBe(expected);
});

test("input observation from an older recording cannot cancel a new recording", async () => {
	const { session, editor } = setup();
	session.begin("");
	session.observeInput(editor);
	editor.setEditorText("new prefix");
	session.begin("new prefix");
	await tick();
	expect(session.finish("speech", "new prefix", editor)).toBe("new prefix speech");
});

test("only another recording permits automatic insertion after the user takes control", () => {
	const { session, editor } = setup();
	session.begin("");
	session.takeEditorControl();
	expect(session.finish("late transcript", "", editor)).toBe(null);
	session.begin("");
	expect(session.finish("new recording", "", editor)).toBe("new recording");
});

test("Pi editor receives a redraw after voice insertion without keyboard input", () => {
	const { session } = setup();
	let rendered = "";
	const tui = { terminal: { rows: 24 }, requestRender() { rendered = component.render(80).join("\n"); } };
	const component = new TuiEditor(tui as any, { borderColor: (text: string) => text } as any);
	const editor = {
		getEditorText: () => component.getText(),
		setEditorText: (text: string) => component.setText(text),
		setStatus: (_key: string, _text: string | undefined) => tui.requestRender(),
		notify: () => {},
	};
	session.begin("");
	expect(session.finish("visible without a cursor key", "", editor)).toBe("visible without a cursor key");
	expect(rendered).toContain("visible without a cursor key");
});

test("invalid learning data falls back to raw text without blocking dictation", () => {
	const { learning, session, editor, notices } = setup();
	learning.setEnabled(true);
	fs.writeFileSync(path.join(directories.at(-1)!, "learning.json"), "invalid JSON");
	session.begin("");
	expect(session.finish("raw speech", "", editor)).toBe("raw speech");
	expect(editor.getEditorText()).toBe("raw speech");
	expect(notices.join(" ")).toContain("Voice replacements skipped");
});

test("raw recovery redraws and remains reversal evidence", async () => {
	const { learning, session, editor, getVisibleText } = setup();
	await install(learning);
	session.begin("");
	session.finish("fire", "", editor);
	expect(session.restoreOriginal(editor)).toBe(true);
	expect(getVisibleText()).toBe("fire");
	session.stageSubmission(editor.getEditorText());
	session.confirmSubmission(editor.getEditorText(), never, editor);
	expect(learning.getState().examples.at(-1)).toEqual({ original: "fire", suggested: "feuer", submitted: "fire" });
	await tick();
});

test("model is called only for every ten submissions; learning never edits a visible draft", async () => {
	const { learning, session, editor } = setup();
	const pending = deferred();
	let calls = 0;
	const complete: Completion = async (...args) => { calls++; return pending.complete(...args); };
	for (let i = 0; i < 10; i++) {
		editor.setEditorText("");
		session.begin("");
		expect(session.finish("fire", "", editor)).toBe("fire");
		expect(calls).toBe(0);
		session.stageSubmission("feuer");
		session.confirmSubmission("feuer", complete, editor);
		await tick();
		expect(calls).toBe(i === 9 ? 1 : 0);
	}
	editor.setEditorText("typing while learning");
	pending.resolve(JSON.stringify(rules));
	await tick();
	await tick();
	expect(editor.getEditorText()).toBe("typing while learning");
	expect(learning.getState().pendingCount).toBe(0);
	editor.setEditorText("");
	session.begin("");
	expect(session.finish("fire", "", editor)).toBe("feuer");
	expect(calls).toBe(1);
});

test("another ten submissions during analysis trigger another batch", async () => {
	const { learning, session, editor } = setup();
	const pending = deferred();
	let calls = 0;
	const complete: Completion = async (...args) => ++calls === 1 ? pending.complete(...args) : JSON.stringify(rules);
	for (let i = 0; i < 20; i++) {
		session.begin(""); session.preview(`fire ${i}`); session.stageSubmission(`feuer ${i}`);
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
			return { result: async () => ({ stopReason, content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "rules" }] }) };
		},
	} } as any);
	const signal = new AbortController().signal;
	expect(await complete("learn rules", { examples: [] }, signal)).toBe("rules");
	expect(call[0]).toBe(model);
	expect(call[1].systemPrompt).toBe("learn rules");
	expect(call[1].messages).toHaveLength(1);
	expect(call[1].messages[0].content).toBe('{"examples":[]}');
	expect(call[1].tools).toBeUndefined();
	expect(call[2].signal).toBe(signal);
	stopReason = "length";
	await expect(complete("learn rules", {}, signal)).rejects.toThrow("length");
});
