import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Real timers everywhere; queue tests drive flush() manually instead of
		// sleeping, so fast and deterministic.
		testTimeout: 15000,
		hookTimeout: 10000,
		environment: "node",
	},
});
