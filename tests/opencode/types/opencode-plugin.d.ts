declare module "@opencode-ai/plugin" {
  export type Plugin = (context: { client: unknown; directory: string }, options?: Record<string, unknown>) => unknown;
}
