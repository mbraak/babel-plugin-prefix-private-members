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

| Option                | Default                    | Description                                                                                              |
| --------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `prefix`              | `"_"`                      | Prefix to add.                                                                                           |
| `accessibility`       | `["private", "protected"]` | Which modifiers to rename.                                                                               |
| `memberAccess`        | `"this"`                   | `"this"` rewrites `this.x` and `super.x` only. `"all"` rewrites every `<expr>.x` in the file, see below. |
| `aliases`             | `{}`                       | Import prefix to directory, for non-relative imports that are project files: `{ "app/": "./src/" }`.     |
| `root`                | `process.cwd()`            | What `aliases` are resolved against.                                                                     |
| `prefixPublicMethods` | `false`                    | Also rename the public methods of every class not in `excludeClasses`, see below.                        |
| `excludeClasses`      | `[]`                       | Classes whose public methods keep their names.                                                           |

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

## Prefixing public methods

Inside a library, most classes are internal, and their public methods are
public only to the other files of the library. `prefixPublicMethods: true`
renames those too, and `excludeClasses` lists the classes whose public methods
are the actual API.

```json
{
    "plugins": [
        [
            "prefix-private-members",
            { "prefixPublicMethods": true, "excludeClasses": ["Tree"] }
        ]
    ]
}
```

```ts
export class Tree {
    public open() {} //  ->  open (Tree is excluded)
    private render() {} //  ->  _render
}

class Node {
    public element: HTMLElement; //  ->  element (a property)
    public setParent(parent: Node) {} //  ->  _setParent
}
```

Only methods are renamed, with or without a `public` modifier. Properties,
getters and setters keep their names. A subclass follows its base classes: a
method that is renamed in the base class is renamed in the subclass too, and a
public method that an excluded base class keeps stays in the subclass as well,
so overrides keep working.

References are rewritten as for private members, so a renamed public method
must be reached through `this.` / `super.`, or through `memberAccess: "all"`
or the file comment described below. A public method that another file calls
by name belongs to a class in `excludeClasses`.

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

### Releasing

Add an entry to `CHANGELOG.md`, then bump the version and push the tag:

```sh
pnpm version minor    # or patch / major; commits and tags v<version>
git push --follow-tags
```

The `Publish` workflow runs on `v*` tags. It verifies that the tag matches
`package.json`, runs `pnpm check`, and publishes to npm using
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), so no npm
token is stored in the repository.

## License

Apache-2.0
