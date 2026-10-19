import { VoiceLearning, type Completion, type LearningExample } from "./learning";

interface Editor {
	getEditorText(): string;
	setEditorText(text: string): void;
	notify(message: string, level: "info" | "warning"): void;
}
const append = (prefix: string, text: string) => (prefix ? prefix + " " : "") + text;

/** Associate dictation with accepted messages, without letting late rewrites overwrite edits. */
export class VoiceLearningSession {
	private generation = 0;
	private rewriteController?: AbortController;
	private learnController?: AbortController;
	private pending?: { original: string; suggested: string };
	private submissions: { example: LearningExample; automatic: boolean }[] = [];
	private originalPrefix = "";
	private suggestedPrefix = "";
	private lastOriginal?: string;
	private userEditing = false;

	constructor(readonly learning: VoiceLearning) {}

	begin(prefix: string): number {
		this.rewriteController?.abort();
		// Keep corrections made between recordings visible in the eventual evidence triple.
		this.originalPrefix = prefix && this.pending ? this.pending.original : prefix;
		this.suggestedPrefix = prefix && this.pending ? this.pending.suggested : prefix;
		this.pending = undefined;
		this.userEditing = false;
		return ++this.generation;
	}

	isCurrent(generation: number): boolean { return generation === this.generation; }

	preview(text: string): void {
		this.pending = { original: append(this.originalPrefix, text), suggested: append(this.suggestedPrefix, text) };
		this.lastOriginal = this.pending.original;
	}

	/** Give the user control until they explicitly start another recording. */
	takeEditorControl(): void {
		this.userEditing = true;
		this.rewriteController?.abort();
	}

	rememberTranscript(text: string): void {
		this.lastOriginal = append(this.originalPrefix, text);
	}

	observeEditor(text: string): void {
		if (!text.trim()) {
			this.pending = undefined;
			this.rewriteController?.abort();
			++this.generation;
		}
	}

	async finish(text: string, prefix: string, complete: Completion, editor: Editor): Promise<string | null> {
		// Keep all STT/model output off-editor until it is ready to insert once.
		this.rememberTranscript(text);
		if (this.userEditing || editor.getEditorText() !== prefix) return null;
		const pending = this.pending;
		const expected = prefix;
		const generation = this.generation;
		const controller = new AbortController();
		this.rewriteController = controller;
		let rewritten = text;
		try {
			rewritten = await this.learning.rewrite(text, complete, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
		} catch (error) {
			if (!controller.signal.aborted) editor.notify(`Voice rewrite skipped: ${error instanceof Error ? error.message : error}`, "warning");
		}
		if (this.userEditing || !this.isCurrent(generation) || controller.signal.aborted || this.pending !== pending) return null;
		if (editor.getEditorText() !== expected) return null;
		const result = append(prefix, rewritten);
		if (!result.trim()) return null;
		this.preview(text);
		this.pending!.suggested = append(this.suggestedPrefix, rewritten);
		if (result !== expected) editor.setEditorText(result);
		return result;
	}

	stageSubmission(text: string, automatic = false): void {
		const pending = this.pending;
		this.pending = undefined;
		this.rewriteController?.abort();
		++this.generation;
		if (!pending || !text.trim()) return;
		this.submissions.push({ example: { ...pending, submitted: text }, automatic });
		this.submissions = this.submissions.slice(-20);
	}

	confirmSubmission(text: string, complete: Completion, editor: Editor): boolean {
		const index = this.submissions.findIndex(item => item.example.submitted === text);
		if (index < 0) return false;
		const [{ example, automatic }] = this.submissions.splice(index, 1);
		try {
			this.learning.record(example);
			this.analyze(complete, editor);
		} catch (error) {
			editor.notify(`Voice learning skipped: ${error instanceof Error ? error.message : error}`, "warning");
		}
		return automatic && !this.userEditing;
	}

	private analyze(complete: Completion, editor: Editor): void {
		if (this.learnController) return;
		const controller = new AbortController();
		this.learnController = controller;
		let changed = false;
		void this.learning.learn(complete, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]))
			.then(result => {
				changed = result;
				if (changed && !controller.signal.aborted) editor.notify("Voice replacements, preferences, and hotwords updated. /voice-learn status or undo", "info");
			})
			.catch(error => {
				if (!controller.signal.aborted) editor.notify(`Voice learning will retry after the next dictation: ${error instanceof Error ? error.message : error}`, "warning");
			})
			.finally(() => {
				if (this.learnController !== controller) return;
				this.learnController = undefined;
				// Submissions may have accumulated while the model was working. No immediate retries on failure.
				if (changed && !controller.signal.aborted) this.analyze(complete, editor);
			});
	}

	restoreOriginal(editor: Editor): boolean {
		if (this.lastOriginal === undefined) return false;
		this.takeEditorControl();
		editor.setEditorText(this.lastOriginal);
		return true;
	}

	clear(): void {
		++this.generation;
		this.rewriteController?.abort();
		this.learnController?.abort();
		this.learnController = undefined;
		this.pending = undefined;
		this.submissions = [];
		this.lastOriginal = undefined;
		this.originalPrefix = "";
		this.suggestedPrefix = "";
	}
}
