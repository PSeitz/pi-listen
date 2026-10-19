import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Completion } from "./learning";

/** Use the active Pi model and its registered provider/authentication, with no tools or session history. */
export function learningCompletion(ctx: ExtensionContext): Completion {
	const model = ctx.model;
	// Older supported Pi types predate the model-registry completion API.
	const registry = ctx.modelRegistry as unknown as {
		streamSimple?: (selectedModel: NonNullable<ExtensionContext["model"]>, context: {
			systemPrompt: string;
			messages: { role: "user"; content: string; timestamp: number }[];
		}, options: { signal: AbortSignal; maxTokens: number }) => {
			result(): Promise<{ stopReason: string; errorMessage?: string; content: { type: string; text?: string }[] }>;
		};
	};
	return async (system, data, signal) => {
		if (!model || !registry.streamSimple) throw new Error("Voice learning requires a selected model and Pi's model-registry API. Update Pi if needed.");
		signal.throwIfAborted();
		const result = await registry.streamSimple(model, {
			systemPrompt: system,
			messages: [{ role: "user", content: JSON.stringify(data), timestamp: Date.now() }],
		}, { signal, maxTokens: 8192 }).result();
		signal.throwIfAborted();
		if (result.stopReason !== "stop") throw new Error(result.errorMessage || `Voice model response ended with ${result.stopReason}`);
		return result.content.filter(part => part.type === "text").map(part => part.text || "").join("\n");
	};
}
