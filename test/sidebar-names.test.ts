/**
 * r13a regression: sidebar group naming.
 *
 * disambiguatedNames(byCwd.keys()) used to iterate the one-shot Map
 * iterator in two passes — the second pass saw nothing, returned an empty
 * Map, and every live-sidebar folder fell through to "（未知）" while the
 * grouping itself stayed correct (four correctly-formed unknown-named
 * folders). The fix materializes the iterator into an array first.
 *
 * app.js is a browser module (executes DOM on import), so the test
 * extracts the function source and evaluates it in isolation.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

function extractFn(name: string): (cwds: Iterable<string>) => Map<string, string> {
	const src = readFileSync(join(webDir, "app.js"), "utf8");
	const start = src.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`${name} not found in app.js`);
	let depth = 0;
	let end = -1;
	for (let i = src.indexOf("{", start); i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	if (end === -1) throw new Error(`unbalanced braces in ${name}`);
	// eslint-disable-next-line no-new-func
	return new Function(`"use strict"; return (${src.slice(start, end)});`)() as (
		cwds: Iterable<string>,
	) => Map<string, string>;
}

describe("r13a: sidebar group naming (disambiguatedNames)", () => {
	it("names every group from its cwd — one-shot iterator regression", () => {
		const fn = extractFn("disambiguatedNames");
		const byCwdKeys = new Map([
			["/Users/x/project/aiProject/pi-output-translate", [1, 2]],
			["/Users/x/project/aiProject", [3]],
			["/Users/x/project/c2-project/esp32-c3-adblock", [4]],
			["/Users/x/project/rustProject/sigid", [5]],
		]).keys(); // a REAL one-shot iterator, exactly like renderSidebar passes
		const names = fn(byCwdKeys);
		expect(names.get("/Users/x/project/aiProject/pi-output-translate")).toBe("pi-output-translate");
		expect(names.get("/Users/x/project/aiProject")).toBe("aiProject");
		expect(names.get("/Users/x/project/c2-project/esp32-c3-adblock")).toBe("esp32-c3-adblock");
		expect(names.get("/Users/x/project/rustProject/sigid")).toBe("sigid");
	});

	it("disambiguates same-basename projects with the parent segment", () => {
		const fn = extractFn("disambiguatedNames");
		const names = fn(["/Users/x/alpha/app", "/Users/x/beta/app", "/Users/x/gamma"]);
		expect(names.get("/Users/x/alpha/app")).toBe("alpha/app");
		expect(names.get("/Users/x/beta/app")).toBe("beta/app");
		expect(names.get("/Users/x/gamma")).toBe("gamma"); // unique stays short
	});

	it("empty cwd maps to the unknown label (single group)", () => {
		const fn = extractFn("disambiguatedNames");
		const names = fn([""]);
		expect(names.get("")).toBe("（未知）");
	});
});
