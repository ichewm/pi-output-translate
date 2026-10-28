/** Type surface for the plain-JS markdown module (kept dependency-free for the browser). */
export declare function esc(s: unknown): string;
export declare function highlight(code: string, lang?: string): string;
export declare function inline(s: string): string;
export declare function extractInlineMath(src: string, stash: (body: string) => string): string;
export declare function extractDisplayMath(src: string, stash: (body: string) => string): string;
export declare function renderMd(text: string): string;
