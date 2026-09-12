import { transformSync } from "@babel/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Options } from "../src/index.js";

import prefixPrivateMembers from "../src/index.js";

const transform = (
    code: string,
    options: Options = {},
    filename = "test.ts",
): string => {
    const result = transformSync(code, {
        babelrc: false,
        configFile: false,
        filename,
        plugins: [[prefixPrivateMembers, options]],
        presets: [
            ["@babel/preset-typescript", { onlyRemoveTypeImports: true }],
        ],
        retainLines: false,
    });

    if (result?.code == null) {
        throw new Error("babel did not generate any code");
    }

    return result.code;
};

/**
 * Compiles one file of a small project on disk, so that the plugin can follow
 * the imports to the base classes.
 */
const transformProject = (
    files: Record<string, string>,
    entry: string,
    options: Options = {},
): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prefix-plugin-"));

    for (const [name, content] of Object.entries(files)) {
        const file = path.join(directory, name);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }

    const entryFile = path.join(directory, entry);
    const code = transform(
        fs.readFileSync(entryFile, "utf8"),
        { root: directory, ...options },
        entryFile,
    );

    fs.rmSync(directory, { recursive: true });

    return code;
};

describe("prefix-private-members", () => {
    it("prefixes private methods and their this-references", () => {
        const code = transform(`
            class Tree {
                public open(): void {
                    this.render();
                }

                private render(): void {}
            }
        `);

        expect(code).toContain("open()");
        expect(code).toContain("this._render()");
        expect(code).toContain("_render()");
        expect(code).not.toContain("this.render()");
    });

    it("prefixes protected members", () => {
        const code = transform(`
            class ScrollParent {
                protected container: HTMLElement;

                protected scroll(): void {
                    this.container.scrollTop = 0;
                }
            }
        `);

        expect(code).toContain("_container");
        expect(code).toContain("this._container.scrollTop");
        expect(code).toContain("_scroll()");
    });

    it("leaves public members alone", () => {
        const code = transform(`
            class Tree {
                public element: HTMLElement;

                public open(): void {
                    this.element.focus();
                }
            }
        `);

        expect(code).not.toContain("_element");
        expect(code).not.toContain("_open");
    });

    it("leaves members without an accessibility modifier alone", () => {
        const code = transform(`
            class Tree {
                element: HTMLElement;

                open(): void {
                    this.element.focus();
                }
            }
        `);

        expect(code).not.toContain("_element");
        expect(code).not.toContain("_open");
    });

    it("is idempotent for names that are already prefixed", () => {
        const code = transform(`
            class Tree {
                private _element: HTMLElement;

                private _open(): void {
                    this._element.focus();
                }
            }
        `);

        expect(code).toContain("_element");
        expect(code).not.toContain("__element");
        expect(code).not.toContain("__open");
    });

    it("prefixes getters, setters and static members", () => {
        const code = transform(`
            class Tree {
                private static count = 0;

                private get size(): number {
                    return Tree.count;
                }

                private set size(value: number) {
                    this.width = value;
                }

                private width = 0;
            }
        `);

        expect(code).toContain("_count");
        expect(code).toContain("_size");
        expect(code).toContain("this._width = value");
    });

    it("keeps the constructor name", () => {
        const code = transform(`
            class Tree {
                private constructor() {}
            }
        `);

        expect(code).toContain("constructor()");
        expect(code).not.toContain("_constructor");
    });

    it("does not touch computed keys", () => {
        const code = transform(`
            const key = "render";

            class Tree {
                private [key](): void {}
            }
        `);

        expect(code).not.toContain("_key");
        expect(code).toContain("[key]");
    });

    it("prefixes an abstract member declaration", () => {
        const code = transform(`
            abstract class ScrollParent {
                protected abstract scroll(): void;

                public start(): void {
                    this.scroll();
                }
            }
        `);

        expect(code).toContain("this._scroll()");
    });

    it("prefixes a parameter property and its references", () => {
        const code = transform(`
            class Tree {
                constructor(private element: HTMLElement) {
                    element.focus();
                }

                public open(): void {
                    this.element.focus();
                }
            }
        `);

        expect(code).toContain("this._element = _element");
        expect(code).toContain("_element.focus()");
        expect(code).toContain("this._element.focus()");
    });

    it("rewrites this-references from arrow functions", () => {
        const code = transform(`
            class Tree {
                public open(): void {
                    const handle = () => this.render();
                    handle();
                }

                private render(): void {}
            }
        `);

        expect(code).toContain("this._render()");
    });

    it("does not rewrite this-references from a nested function", () => {
        const code = transform(`
            class Tree {
                public open(): void {
                    function handle(this: { render: () => void }) {
                        this.render();
                    }

                    handle();
                }

                private render(): void {}
            }
        `);

        expect(code).toContain("this.render()");
        expect(code).toContain("_render()");
    });

    it("keeps nested classes apart", () => {
        const code = transform(`
            class Outer {
                public run(): void {
                    class Inner {
                        public go(): void {
                            this.render();
                        }

                        private render(): void {}
                    }

                    new Inner().go();
                    this.log();
                }

                private log(): void {}
            }
        `);

        expect(code).toContain("this._render()");
        expect(code).toContain("this._log()");
    });

    it("does not rewrite an unrelated object with the same property name", () => {
        const code = transform(`
            class Tree {
                private render(): void {}

                public open(options: { render: () => void }): void {
                    options.render();
                }
            }
        `);

        expect(code).toContain("options.render()");
    });

    it("rewrites access to another instance with memberAccess all", () => {
        const code = transform(
            `
                class Node {
                    public addChild(node: Node): void {
                        node.setParent(this);
                    }

                    private setParent(parent: Node): void {}
                }
            `,
            { memberAccess: "all" },
        );

        expect(code).toContain("node._setParent(this)");
    });

    it("takes a custom prefix", () => {
        const code = transform(
            `
                class Tree {
                    private render(): void {}

                    public open(): void {
                        this.render();
                    }
                }
            `,
            { prefix: "$" },
        );

        expect(code).toContain("this.$render()");
    });

    it("takes a custom accessibility list", () => {
        const code = transform(
            `
                class Tree {
                    private render(): void {}

                    protected draw(): void {}
                }
            `,
            { accessibility: ["private"] },
        );

        expect(code).toContain("_render()");
        expect(code).toContain("draw()");
        expect(code).not.toContain("_draw()");
    });

    it("rewrites access to another instance after the file directive", () => {
        const code = transform(`
            // prefix-private-members: all

            class Node {
                public addChild(node: Node): void {
                    node.setParent(this);
                }

                private setParent(parent: Node): void {}
            }
        `);

        expect(code).toContain("node._setParent(this)");
    });

    it("prefixes members inherited from a base class in another file", () => {
        const code = transformProject(
            {
                "base.ts": `
                    export abstract class Base {
                        protected container: HTMLElement;

                        protected abstract scroll(): void;
                    }
                `,
                "sub.ts": `
                    import { Base } from "./base";

                    export default class Sub extends Base {
                        protected scroll(): void {
                            this.container.scrollTop = 0;
                        }
                    }
                `,
            },
            "sub.ts",
        );

        expect(code).toContain("this._container.scrollTop");
        expect(code).toContain("_scroll()");
    });

    it("follows the whole chain of base classes", () => {
        const code = transformProject(
            {
                "a.ts": `
                    export class A {
                        protected top: number;
                    }
                `,
                "b/index.ts": `
                    import { A } from "../a";

                    export default class B extends A {
                        protected middle: number;
                    }
                `,
                "c.ts": `
                    import B from "./b";

                    export class C extends B {
                        public run(): void {
                            this.top = this.middle;
                        }
                    }
                `,
            },
            "c.ts",
        );

        expect(code).toContain("this._top = this._middle");
    });

    it("follows a base class imported through an alias", () => {
        const code = transformProject(
            {
                "lib/base.ts": `
                    export default class Base {
                        protected container: HTMLElement;
                    }
                `,
                "sub.ts": `
                    import Base from "app/base";

                    export class Sub extends Base {
                        public clear(): void {
                            this.container.remove();
                        }
                    }
                `,
            },
            "sub.ts",
            { aliases: { "app/": "./lib/" } },
        );

        expect(code).toContain("this._container.remove()");
    });

    it("leaves a base class from a package alone", () => {
        const code = transform(`
            import { Widget } from "some-package";

            class Tree extends Widget {
                public open(): void {
                    this.container.focus();
                }
            }
        `);

        expect(code).toContain("this.container.focus()");
    });

    it("rejects an unknown memberAccess option", () => {
        expect(() =>
            transform("class Tree {}", { memberAccess: "nope" }),
        ).toThrow(/memberAccess/);
    });
});
