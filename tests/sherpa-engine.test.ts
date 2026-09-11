import { describe, expect, test } from "bun:test";
import {
	initSherpa,
	isSherpaAvailable,
	getSherpaError,
	clearRecognizerCache,
	transcribeBuffer,
} from "../extensions/voice/sherpa-engine";

// ─── Module loading ──────────────────────────────────────────────────────────

describe("sherpa-onnx-node Bun compatibility", () => {
	test("sherpa-onnx-node module loads via require()", () => {
		const sherpa = require("sherpa-onnx-node");
		expect(sherpa).toBeDefined();
		expect(typeof sherpa.version).toBe("string");
		expect(sherpa.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("sherpa-onnx-node exports OfflineRecognizer constructor", () => {
		const sherpa = require("sherpa-onnx-node");
		expect(typeof sherpa.OfflineRecognizer).toBe("function");
	});

	test("sherpa-onnx-node exports OnlineRecognizer constructor", () => {
		const sherpa = require("sherpa-onnx-node");
		expect(typeof sherpa.OnlineRecognizer).toBe("function");
	});

	test("sherpa-onnx-node loads via ESM dynamic import()", async () => {
		const sherpa = await import("sherpa-onnx-node");
		expect(sherpa).toBeDefined();
		expect(typeof sherpa.OfflineRecognizer).toBe("function");
	});
});

// ─── initSherpa ──────────────────────────────────────────────────────────────

describe("initSherpa", () => {
	test("initializes successfully", async () => {
		const result = await initSherpa();
		expect(result).toBe(true);
	});

	test("isSherpaAvailable returns true after init", async () => {
		await initSherpa();
		expect(isSherpaAvailable()).toBe(true);
	});

	test("getSherpaError returns null on success", async () => {
		await initSherpa();
		expect(getSherpaError()).toBeNull();
	});

	test("initSherpa is idempotent", async () => {
		const first = await initSherpa();
		const second = await initSherpa();
		expect(first).toBe(true);
		expect(second).toBe(true);
	});
});

// ─── Recognizer creation (no model files — error handling) ───────────────────

describe("recognizer error handling", () => {
	test("OfflineRecognizer rejects invalid config gracefully", async () => {
		await initSherpa();
		const sherpa = require("sherpa-onnx-node");

		expect(() => {
			new sherpa.OfflineRecognizer({
				featConfig: { sampleRate: 16000, featureDim: 80 },
				modelConfig: {
					whisper: {
						encoder: "/tmp/nonexistent-encoder.onnx",
						decoder: "/tmp/nonexistent-decoder.onnx",
					},
					tokens: "/tmp/nonexistent-tokens.txt",
					debug: 0,
				},
			});
		}).toThrow();
	});
});

// ─── Cache management ────────────────────────────────────────────────────────

describe("clearRecognizerCache", () => {
	test("clears without error when no recognizer cached", () => {
		expect(() => clearRecognizerCache()).not.toThrow();
	});
});

describe("transcribeBuffer", () => {
	test("passes configured hotwords to the stream", async () => {
		await initSherpa();
		let streamHotwords: string | undefined;
		const recognizer = {
			createStream(hotwords?: string) {
				streamHotwords = hotwords;
				return { acceptWaveform() {} };
			},
			async decodeAsync() {},
			getResult() { return { text: "Tantivy" }; },
		};

		await transcribeBuffer(Buffer.from([0, 0]), recognizer, ["Tantivy", "Quickwit"]);
		expect(streamHotwords).toBe("Tantivy/Quickwit");
	});

	test("accepts PCM buffers with an odd byteOffset", async () => {
		await initSherpa();

		const accepted: { sampleRate: number; samples: Float32Array }[] = [];
		const recognizer = {
			createStream() {
				return {
					acceptWaveform(payload: { sampleRate: number; samples: Float32Array }) {
						accepted.push(payload);
					},
				};
			},
			async decodeAsync() {},
			getResult() {
				return { text: "ok" };
			},
		};

		const pcm = Buffer.from([0, 0, 255, 127, 0, 128, 0, 0]).subarray(1, 7);

		await expect(transcribeBuffer(pcm, recognizer)).resolves.toBe("ok");
		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.sampleRate).toBe(16000);
		expect(Array.from(accepted[0]?.samples || [])).toEqual([
			-256 / 32768,
			127 / 32768,
			128 / 32768,
		]);
	});
});
