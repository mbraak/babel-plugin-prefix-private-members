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

    it("prefixes members inherited from a base class in the same file", () => {
        const code = transform(`
            class Base {
                protected container: HTMLElement;
            }

            class Sub extends Base {
                public clear(): void {
                    this.container.remove();
                }
            }
        `);

        expect(code).toContain("_container;");
        expect(code).toContain("this._container.remove()");
    });

    it("prefixes public members with prefixPublicMembers", () => {
        const code = transform(
            `
                class Tree {
                    public element: HTMLElement;
                    count = 0;

                    constructor(public options: object) {
                        this.options = options;
                    }

                    public open(): void {
                        this.render();
                        this.element.focus();
                        this.count += 1;
                    }

                    close(): void {
                        this.open();
                    }

                    public static create(): Tree {
                        return new Tree({});
                    }

                    public get size(): number {
                        return this.count;
                    }

                    private render(): void {}
                }
            `,
            { prefixPublicMembers: true },
        );

        expect(code).toContain("_open()");
        expect(code).toContain("_close()");
        expect(code).toContain("this._open()");
        expect(code).toContain("this._render()");
        expect(code).toContain("static _create()");
        expect(code).toContain("constructor(");
        expect(code).not.toContain("_constructor");
        expect(code).toContain("_element;");
        expect(code).toContain("this._element.focus()");
        expect(code).toContain("_count = 0");
        expect(code).toContain("this._count += 1");
        expect(code).toContain("constructor(_options)");
        expect(code).toContain("this._options = _options");
        expect(code).toContain("get _size()");
        expect(code).toContain("return this._count");
    });

    it("leaves the public members of excluded classes alone", () => {
        const code = transform(
            `
                class Tree {
                    public open(): void {
                        this.render();
                    }

                    private render(): void {}
                }

                class Node {
                    public open(): void {}
                }
            `,
            { excludeClasses: ["Tree"], prefixPublicMembers: true },
        );

        expect(code).toMatch(/class Tree \{\s*open\(\)/);
        expect(code).toContain("this._render()");
        expect(code).toContain("_render()");
        expect(code).toMatch(/class Node \{\s*_open\(\)/);
    });

    it("leaves public members alone without prefixPublicMembers", () => {
        const code = transform(
            `
                class Tree {
                    public open(): void {}
                }
            `,
            { excludeClasses: ["Other"] },
        );

        expect(code).toContain("open()");
        expect(code).not.toContain("_open");
    });

    it("renames inherited public members of a base class in another file", () => {
        const code = transformProject(
            {
                "base.ts": `
                    export class Base {
                        public open(): void {}
                        public element: HTMLElement;
                    }
                `,
                "sub.ts": `
                    import { Base } from "./base";

                    export class Sub extends Base {
                        public run(): void {
                            this.open();
                            this.element.focus();
                        }
                    }
                `,
            },
            "sub.ts",
            { prefixPublicMembers: true },
        );

        expect(code).toContain("_run()");
        expect(code).toContain("this._open()");
        expect(code).toContain("this._element.focus()");
    });

    it("renames an override of a renamed base method in an excluded class", () => {
        const code = transformProject(
            {
                "base.ts": `
                    export class Base {
                        public open(): void {}
                    }
                `,
                "sub.ts": `
                    import { Base } from "./base";

                    export class Sub extends Base {
                        public open(): void {
                            super.open();
                        }

                        public run(): void {
                            this.open();
                        }
                    }
                `,
            },
            "sub.ts",
            { excludeClasses: ["Sub"], prefixPublicMembers: true },
        );

        expect(code).toContain("_open()");
        expect(code).toContain("super._open()");
        expect(code).toContain("this._open()");
        expect(code).toContain("run()");
        expect(code).not.toContain("_run");
    });

    it("keeps an override of a kept method of an excluded base class", () => {
        const code = transformProject(
            {
                "base.ts": `
                    export class Base {
                        public open(): void {}
                    }
                `,
                "sub.ts": `
                    import { Base } from "./base";

                    export class Sub extends Base {
                        public open(): void {
                            super.open();
                        }

                        public run(): void {
                            this.open();
                        }
                    }
                `,
            },
            "sub.ts",
            { excludeClasses: ["Base"], prefixPublicMembers: true },
        );

        expect(code).toContain("open()");
        expect(code).not.toContain("_open");
        expect(code).toContain("super.open()");
        expect(code).toContain("_run()");
    });

    it("renames an inherited public method with the file directive", () => {
        const code = transform(
            `
                // prefix-private-members: all

                class Node {
                    public addChild(node: Node): void {
                        node.setParent(this);
                    }

                    public setParent(parent: Node): void {}
                }
            `,
            { prefixPublicMembers: true },
        );

        expect(code).toContain("node._setParent(this)");
        expect(code).toContain("_addChild(");
    });

    it("prefixes the keys of object parameters with prefixParameterKeys", () => {
        const code = transform(
            `
                class Tree {
                    public open(node: Node): void {
                        this.render({ node, level: 1 });
                        this.render?.({ node });
                    }

                    private render({ node, level = 0 }: Params): void {}
                }
            `,
            { prefixParameterKeys: true },
        );

        expect(code).toMatch(
            /_render\(\{\s*_node: node,\s*_level: level = 0\s*\}\)/,
        );
        expect(code).toMatch(
            /this\._render\(\{\s*_node: node,\s*_level: 1\s*\}\)/,
        );
        expect(code).toMatch(/this\._render\?\.\(\{\s*_node: node\s*\}\)/);
    });

    it("leaves the keys of object parameters alone by default", () => {
        const code = transform(`
            class Tree {
                public open(node: Node): void {
                    this.render({ node });
                }

                private render({ node }: Params): void {}
            }
        `);

        expect(code).toMatch(/_render\(\{\s*node\s*\}\)/);
        expect(code).toMatch(/this\._render\(\{\s*node\s*\}\)/);
        expect(code).not.toContain("_node");
    });

    it("leaves the keys of a kept public method alone", () => {
        const code = transform(
            `
                class Tree {
                    public open({ node }: Params): void {
                        this.open({ node });
                    }
                }
            `,
            { prefixParameterKeys: true },
        );

        expect(code).not.toContain("_node");
    });

    it("prefixes constructor keys, at new and super, for a non-excluded class", () => {
        const code = transform(
            `
                class Handler {
                    constructor({ element, onClick }: Params) {}
                }

                class Sub extends Handler {
                    constructor() {
                        super({ element: null, onClick() {} });
                    }
                }

                class Tree {
                    private handler = new Handler({
                        element: this.element,
                        onClick: () => {},
                    });
                }
            `,
            {
                excludeClasses: ["Tree"],
                prefixParameterKeys: true,
                prefixPublicMembers: true,
            },
        );

        expect(code).toMatch(
            /constructor\(\{\s*_element: element,\s*_onClick: onClick\s*\}\)/,
        );
        expect(code).toMatch(
            /super\(\{\s*_element: null,\s*_onClick\(\) \{\}\s*\}\)/,
        );
        expect(code).toMatch(
            /new Handler\(\{\s*_element: this\.element,\s*_onClick:/,
        );
    });

    it("leaves constructor keys alone for an excluded class or public constructor", () => {
        const code = transform(
            `
                class Tree {
                    constructor({ element }: Params) {}
                }

                class Handler {
                    constructor({ element }: Params) {}
                }

                const tree = new Tree({ element: null });
                const handler = new Handler({ element: null });
            `,
            { excludeClasses: ["Tree"], prefixParameterKeys: true },
        );

        // Without prefixPublicMembers a constructor is public API everywhere.
        expect(code).not.toContain("_element");
    });

    it("prefixes the keys of a private constructor", () => {
        const code = transform(
            `
                class Tree {
                    private constructor({ element }: Params) {}

                    public static create(): Tree {
                        return new Tree({ element: null });
                    }
                }
            `,
            { prefixParameterKeys: true },
        );

        expect(code).toMatch(/constructor\(\{\s*_element: element\s*\}\)/);
        expect(code).toMatch(/new Tree\(\{\s*_element: null\s*\}\)/);
    });

    it("prefixes constructor keys of a class in another file", () => {
        const code = transformProject(
            {
                "handler.ts": `
                    export default class Handler {
                        constructor({ element, onClick }: Params) {}
                    }
                `,
                "index.ts": `
                    import Handler from "./handler";

                    export class Tree {
                        private handler = new Handler({
                            element: document.body,
                            onClick: () => {},
                        });
                    }
                `,
            },
            "index.ts",
            {
                excludeClasses: ["Tree"],
                prefixParameterKeys: true,
                prefixPublicMembers: true,
            },
        );

        expect(code).toMatch(
            /new Handler\(\{\s*_element: document\.body,\s*_onClick:/,
        );
    });

    it("prefixes the keys of an inherited method's parameters", () => {
        const code = transformProject(
            {
                "base.ts": `
                    export class Base {
                        protected render({ node }: Params): void {}
                    }
                `,
                "sub.ts": `
                    import { Base } from "./base";

                    export class Sub extends Base {
                        public open(node: Node): void {
                            this.render({ node });
                            super.render({ node });
                        }
                    }
                `,
            },
            "sub.ts",
            { prefixParameterKeys: true },
        );

        expect(code).toMatch(/this\._render\(\{\s*_node: node\s*\}\)/);
        expect(code).toMatch(/super\._render\(\{\s*_node: node\s*\}\)/);
    });

    it("prefixes the keys passed to another instance with memberAccess all", () => {
        const code = transform(
            `
                class Node {
                    public addChild(node: Node): void {
                        node.setParent({ parent: this });
                    }

                    private setParent({ parent }: Params): void {}
                }
            `,
            { memberAccess: "all", prefixParameterKeys: true },
        );

        expect(code).toMatch(/node\._setParent\(\{\s*_parent: this\s*\}\)/);
    });

    it("is idempotent for keys that are already prefixed", () => {
        const code = transform(
            `
                class Tree {
                    public open(node: Node): void {
                        this.render({ _node: node });
                    }

                    private render({ _node: node }: Params): void {}
                }
            `,
            { prefixParameterKeys: true },
        );

        expect(code).not.toContain("__node");
    });

    it("rejects an unknown memberAccess option", () => {
        expect(() =>
            transform("class Tree {}", { memberAccess: "nope" }),
        ).toThrow(/memberAccess/);
    });
});

describe("parameter keys of functions", () => {
    it("prefixes the keys of a function's object parameter and of its calls", () => {
        const code = transform(
            `
                function add({ left, right }: Params): number {
                    return left + right;
                }

                const scale = ({ value, factor = 1 }: ScaleParams) => value * factor;

                add({ left: 1, right: 2 });
                scale({ value: 3 });
            `,
            { prefixParameterKeys: true },
        );

        expect(code).toMatch(
            /function add\(\{\s*_left: left,\s*_right: right\s*\}\)/,
        );
        expect(code).toMatch(/add\(\{\s*_left: 1,\s*_right: 2\s*\}\)/);
        expect(code).toMatch(
            /\(\{\s*_value: value,\s*_factor: factor = 1\s*\}\) =>/,
        );
        expect(code).toMatch(/scale\(\{\s*_value: 3\s*\}\)/);
    });

    it("leaves the keys of a function that is passed as a value alone", () => {
        const code = transform(
            `
                function onClick({ target }: MouseEvent): void {}

                document.addEventListener("click", onClick);
                onClick({ target: null });
            `,
            { prefixParameterKeys: true },
        );

        expect(code).not.toContain("_target");
    });

    it("leaves the keys of the functions in excludeFunctions alone", () => {
        const code = transform(
            `
                export function render({ node }: Params): void {}

                render({ node: null });
            `,
            { excludeFunctions: ["render"], prefixParameterKeys: true },
        );

        expect(code).not.toContain("_node");
    });

    it("leaves the keys of functions alone without prefixParameterKeys", () => {
        const code = transform(`
            function render({ node }: Params): void {}

            render({ node: null });
        `);

        expect(code).not.toContain("_node");
    });

    it("prefixes the keys of a call to a function in another file", () => {
        const code = transformProject(
            {
                "iterate.ts": `
                    interface Options {
                        handleNode: () => void;
                        handleFolder: () => void;
                    }

                    const iterate = (tree: Node, { handleNode, handleFolder }: Options) => {};

                    export default iterate;
                `,
                "render.ts": `
                    type Params = { node: Node; level: number };

                    export function render({ node, level }: Params): void {}
                `,
                "index.ts": `
                    import iterate from "./iterate";
                    import { render } from "./render";

                    const handleNode = () => {};

                    iterate(tree, { handleNode, handleFolder: () => {} });
                    render({ node, level: 1 });
                `,
            },
            "index.ts",
            { prefixParameterKeys: true },
        );

        expect(code).toMatch(
            /iterate\(tree, \{\s*_handleNode: handleNode,\s*_handleFolder:/,
        );
        expect(code).toMatch(/render\(\{\s*_node: node,\s*_level: 1\s*\}\)/);
    });

    it("keeps the keys of an exported function whose parameter type is exported", () => {
        const code = transformProject(
            {
                "classNames.ts": `
                    export interface ClassNamesOptions {
                        classPrefix: string;
                    }

                    const createClassNames = ({ classPrefix }: ClassNamesOptions) => ({
                        border: classPrefix + "-border",
                    });

                    export default createClassNames;
                `,
                "index.ts": `
                    import createClassNames from "./classNames";

                    export class Tree {
                        private classNames = createClassNames(this.options);
                        private options: ClassNamesOptions;
                    }
                `,
            },
            "classNames.ts",
            { prefixParameterKeys: true },
        );

        // The options of an exported type can come from anywhere, so the
        // keys stay.
        expect(code).not.toContain("_classPrefix");
    });

    it("keeps the keys of a function called with an object built elsewhere", () => {
        const code = transform(
            `
                function render({ node }: { node: Node }): void {}

                const params = { node: null };
                render(params);
                render({ node: null });
            `,
            { prefixParameterKeys: true },
        );

        expect(code).not.toContain("_node");
    });

    it("rejects a non-literal passed from another file to a prefixed parameter", () => {
        expect(() =>
            transformProject(
                {
                    "iterate.ts": `
                        interface Options {
                            handleNode: () => void;
                        }

                        export const iterate = ({ handleNode }: Options) => {};
                    `,
                    "index.ts": `
                        import { iterate } from "./iterate";

                        const options = { handleNode: () => {} };
                        iterate(options);
                    `,
                },
                "index.ts",
                { prefixParameterKeys: true },
            ),
        ).toThrow(
            /iterate\(\.\.\.\) at .*index\.ts:5 passes an object that is not a literal/,
        );
    });

    it("rejects a non-literal passed to a method with prefixed keys", () => {
        expect(() =>
            transform(
                `
                    class Tree {
                        public open(params: Params): void {
                            this.render(params);
                        }

                        private render({ node }: Params): void {}
                    }
                `,
                { prefixParameterKeys: true },
            ),
        ).toThrow(
            /\.render\(\.\.\.\) at .* passes an object that is not a literal/,
        );
    });

    it("keeps the keys of a call to a function another file passes around", () => {
        const code = transformProject(
            {
                "handler.ts": `
                    export function onClick({ target }: MouseEvent): void {}

                    document.addEventListener("click", onClick);
                `,
                "index.ts": `
                    import { onClick } from "./handler";

                    onClick({ target: null });
                `,
            },
            "index.ts",
            { prefixParameterKeys: true },
        );

        expect(code).not.toContain("_target");
    });
});

describe("following types", () => {
    const publicOptions: Options = {
        excludeClasses: ["Tree"],
        prefixPublicMembers: true,
    };

    it("rewrites a call through a member typed with a class in another file", () => {
        const code = transformProject(
            {
                "handler.ts": `
                    export default class Handler {
                        public getState(): string { return ""; }
                    }
                `,
                "tree.ts": `
                    import Handler from "./handler";

                    export class Tree {
                        private handler: Handler;

                        public getState(): string {
                            return this.handler.getState();
                        }
                    }
                `,
            },
            "tree.ts",
            publicOptions,
        );

        expect(code).toContain("this._handler._getState()");
        expect(code).toMatch(/\n\s+getState\(\) \{/);
    });

    it("rewrites a call through a typed parameter of a plain function", () => {
        const code = transform(`
            class Node {
                private setParent(parent: Node): void {}
            }

            function attach(node: Node, parent: Node): void {
                node.setParent(parent);
            }
        `);

        expect(code).toContain("node._setParent(parent)");
    });

    it("rewrites a call through a variable initialised with new", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                const handler = new Handler();
                handler.run();
            `,
            publicOptions,
        );

        expect(code).toContain("handler._run()");
    });

    it("rewrites a call through a variable holding the result of a renamed method", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                class Tree {
                    public start(): void {
                        const handler = this.createHandler();
                        handler.run();
                        this.createHandler().run();
                    }

                    private createHandler(): Handler {
                        return new Handler();
                    }
                }
            `,
            publicOptions,
        );

        expect(code).toContain("const handler = this._createHandler()");
        expect(code).toContain("handler._run()");
        expect(code).toContain("this._createHandler()._run()");
    });

    it("infers the return type of a method from what it returns", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                class Tree {
                    public start(): void {
                        this.createHandler().run();
                    }

                    private createHandler() {
                        return new Handler();
                    }
                }
            `,
            publicOptions,
        );

        expect(code).toContain("this._createHandler()._run()");
    });

    it("rewrites calls on the elements of a typed array", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                class Tree {
                    private handlers: Handler[] = [];

                    public start(): void {
                        for (const handler of this.handlers) {
                            handler.run();
                        }

                        this.handlers[0].run();
                    }
                }
            `,
            publicOptions,
        );

        expect(code).toContain("handler._run()");
        expect(code).toContain("this._handlers[0]._run()");
    });

    it("rewrites a static call through the class name", () => {
        const code = transform(
            `
                class Handler {
                    public static create(): Handler {
                        return new Handler();
                    }
                }

                Handler.create();
            `,
            publicOptions,
        );

        expect(code).toContain("Handler._create()");
    });

    it("rewrites a call through a cast", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                function start(x: unknown): void {
                    (x as Handler).run();
                }
            `,
            publicOptions,
        );

        expect(code).toContain("._run()");
    });

    it("rewrites a call through a destructured parameter typed by a local interface", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                interface Params {
                    handler: Handler;
                }

                function start({ handler }: Params): void {
                    handler.run();
                }
            `,
            publicOptions,
        );

        expect(code).toContain("handler._run()");
    });

    it("rewrites a call through a member typed with an imported function type", () => {
        const code = transformProject(
            {
                "handler.ts": `
                    export default class Handler {
                        public run(): void {}
                    }
                `,
                "types.ts": `
                    import type Handler from "./handler";

                    export type GetHandler = () => Handler;
                `,
                "tree.ts": `
                    import type { GetHandler } from "./types";

                    export class Tree {
                        private getHandler: GetHandler;

                        public start(): void {
                            this.getHandler().run();
                        }
                    }
                `,
            },
            "tree.ts",
            publicOptions,
        );

        expect(code).toContain("this._getHandler()._run()");
    });

    it("leaves an object of unknown type alone", () => {
        const code = transform(
            `
                class Handler {
                    public run(): void {}
                }

                function start(x): void {
                    x.run();
                }
            `,
            publicOptions,
        );

        expect(code).toContain("x.run()");
    });

    it("does not resolve this inside a nested regular function", () => {
        const code = transform(`
            class Tree {
                public start(): void {
                    setTimeout(function () {
                        this.render();
                    });
                }

                private render(): void {}
            }
        `);

        expect(code).toContain("this.render()");
        expect(code).toContain("_render()");
    });

    it("keeps a method that implements an interface", () => {
        const code = transform(
            `
                interface Hint {
                    remove(): void;
                }

                class GhostHint implements Hint {
                    public remove(): void {}

                    public other(): void {}
                }

                class Tree {
                    private hint: Hint;

                    public clear(): void {
                        this.hint.remove();
                    }
                }
            `,
            publicOptions,
        );

        expect(code).toMatch(/\n\s+remove\(\) \{/);
        expect(code).toContain("_other()");
        expect(code).toContain("this._hint.remove()");
        expect(code).not.toContain("_remove");
    });

    it("keeps the methods of the built-in protocols", () => {
        const code = transform(
            `
                class Url {
                    public toString(): string {
                        return "";
                    }

                    public toJSON(): string {
                        return this.toString();
                    }
                }
            `,
            publicOptions,
        );

        expect(code).not.toContain("_toString");
        expect(code).not.toContain("_toJSON");
    });

    it("keeps the members in excludeMembers", () => {
        const code = transform(
            `
                class Tree {
                    private render(): void {}

                    private draw(): void {
                        this.render();
                    }
                }
            `,
            { excludeMembers: ["render"] },
        );

        expect(code).toContain("this.render()");
        expect(code).not.toContain("_render");
        expect(code).toContain("_draw()");
    });
});
