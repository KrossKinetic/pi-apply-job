import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WorkerSelection {
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly thinkingLevel: ExtensionContext["thinkingLevel"];
}

/** Capture once per command, before asynchronous preparation or worker creation. */
export function captureWorkerSelection(ctx: Pick<ExtensionContext, "model" | "thinkingLevel">): WorkerSelection {
  const model = ctx.model;
  if (!model) throw new Error("Select an AI model before running /apply-job.");
  return Object.freeze({ model, thinkingLevel: ctx.thinkingLevel });
}
