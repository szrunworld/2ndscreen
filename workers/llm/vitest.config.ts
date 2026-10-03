import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// A stand-in key: tests never reach DashScope, they stub fetch.
			miniflare: { bindings: { QWEN_API_KEY: "test-provider-key" } },
		}),
	],
});
