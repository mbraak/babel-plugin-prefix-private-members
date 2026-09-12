# babel-plugin-prefix-private-members

Babel plugin that prefixes TypeScript `private` and `protected` class members
with `_`, and rewrites the `this.` / `super.` references to them.

Pair it with a minifier that mangles properties matching the prefix, and every
private member is renamed to a short name in the production bundle. The prefix
becomes a build step instead of a naming rule you have to follow by hand.

```ts
class Tree {
    private container: HTMLElement; //  ->  _container

    public open() {
        //  ->  open (untouched)
        this.render(); //  ->  this._render()
    }

    private render() {} //  ->  _render
}
```

## Install

```sh
pnpm add -D babel-plugin-prefix-private-members
```

Requires `@babel/core` 8 and Node 20 or newer. The package is ESM only.

## Usage

`babel.config.json`:

```json
{
    "presets": ["@babel/preset-typescript"],
    "plugins": ["prefix-private-members"]
}
```

Then let the minifier mangle the prefixed names. With terser, in
`rollup.config.mjs` or the terser options of your bundler:

```js
terser({
    mangle: {
        properties: { regex: /^_/ },
    },
});
```

The plugin must run while the TypeScript accessibility modifiers are still in
the AST, so put it in the same Babel pass as `@babel/preset-typescript` (plugins
run before presets, so the order above is right).

## What gets renamed

- `private` and `protected` properties, methods, getters, setters, static
  members, abstract declarations and `accessor` fields.
- Parameter properties: `constructor(private element: HTMLElement)` renames the
  member and the parameter binding in the constructor body.
- `this.x` and `super.x` references inside the class body, including inside
  arrow functions. Nested non-arrow functions and nested classes are skipped,
  because their `this` is a different object.
- Members inherited from a base class: when a class extends a class imported
  over a relative path or a configured alias, that file is parsed and its
  private/protected member names are renamed in the subclass too, recursively
  up the whole chain. `extends HTMLElement` and classes from packages are left
  alone.

Not renamed: public members, members without a modifier, constructors, computed
keys, and anything already starting with the prefix. The plugin is idempotent,
so it is safe to run over source that is already prefixed by hand.

## Options

| Option          | Default                    | Description                                                                                              |
| --------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `prefix`        | `"_"`                      | Prefix to add.                                                                                           |
| `accessibility` | `["private", "protected"]` | Which modifiers to rename.                                                                               |
| `memberAccess`  | `"this"`                   | `"this"` rewrites `this.x` and `super.x` only. `"all"` rewrites every `<expr>.x` in the file, see below. |
| `aliases`       | `{}`                       | Import prefix to directory, for non-relative imports that are project files: `{ "app/": "./src/" }`.     |
| `root`          | `process.cwd()`            | What `aliases` are resolved against.                                                                     |

```json
{
    "plugins": [
        [
            "prefix-private-members",
            { "prefix": "$", "aliases": { "app/": "./src/" } }
        ]
    ]
}
```

## Accessing private members of another instance

`memberAccess: "this"` only rewrites `this.x` and `super.x`, because deciding
whether `node.x` is _this_ class's `x` needs type information Babel does not
have. A class that reaches into the private members of other instances of
itself needs more, and can ask for it per file with a comment anywhere in the
file:

```ts
// prefix-private-members: all

class Node {
    public addChild(node: Node): void {
        node.setParent(this); //  ->  node._setParent(this)
    }

    private setParent(parent: Node): void {}
}
```

That renames every `<expr>.x` in the file whose name is private or protected in
that same file. It is per file rather than the default because private member
names are not unique: `document.createElement()` in a file that declares a
`private createElement()` would be renamed too, and break.

Setting the `memberAccess: "all"` option turns this on for every file.

## Development

```sh
pnpm install
pnpm check     # lint, prettier, tsc, test, build
```

## License

Apache-2.0
