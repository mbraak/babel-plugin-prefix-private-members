# babel-plugin-prefix-private-members

Babel plugin that prefixes TypeScript `private` and `protected` class members
with `_`, and rewrites the references to them, using the TypeScript type
checker to find them.

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

Requires `@babel/core` 8, `typescript` 5 or newer and Node 20 or newer. The
package is ESM only.

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

The plugin type checks each file together with the files it imports, with the
compiler options of the nearest `tsconfig.json`. One TypeScript program per
project is kept for the lifetime of the process, so a watch mode pays for the
type checker once.

## What gets renamed

- `private` and `protected` properties, methods, getters, setters, static
  members, abstract declarations and `accessor` fields.
- Parameter properties: `constructor(private element: HTMLElement)` renames the
  member and the parameter binding in the constructor body.
- References to the renamed members: `this.x`, `super.x`, and `node.x`
  wherever the type checker knows what `node` is, see
  [How references are found](#how-references-are-found).
- Members inherited from a base class: when a class extends a class declared
  in another project file, the private/protected member names of that class
  are renamed in the subclass too, recursively up the whole chain. The
  imports are resolved as the project's `tsconfig.json` says, `paths`
  included.

Not renamed: public members, members without a modifier, constructors, computed
keys, the methods of the built-in protocols (`toString`, `valueOf`, `toJSON`,
`then`, the custom element callbacks), the names in `excludeMembers`, members
that a base class from outside the project already has (`HTMLElement.focus`),
and anything already starting with the prefix. The plugin is idempotent, so it
is safe to run over source that is already prefixed by hand.

## Options

| Option                | Default                    | Description                                                                                          |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `prefix`              | `"_"`                      | Prefix to add.                                                                                       |
| `accessibility`       | `["private", "protected"]` | Which modifiers to rename.                                                                           |
| `root`                | `process.cwd()`            | Where the `tsconfig.json` search starts, and what `aliases` are resolved against.                    |
| `tsconfig`            | nearest `tsconfig.json`    | The tsconfig to take the compiler options from, relative to `root`. `false` for built-in defaults.   |
| `aliases`             | `{}`                       | Import prefix to directory, added to the `paths` of the compiler options: `{ "app/": "./src/" }`.    |
| `prefixPublicMembers` | `false`                    | Also rename the public members of every class not in `excludeClasses`, see below.                    |
| `excludeClasses`      | `[]`                       | Classes whose public members keep their names.                                                       |
| `excludeMembers`      | `[]`                       | Member names that are never renamed, in any class.                                                   |
| `excludeFunctions`    | `[]`                       | Functions whose object parameter keys `prefixParameterKeys` leaves alone.                            |
| `prefixParameterKeys` | `false`                    | Also rename the keys of object parameters of renamed methods, constructors and functions, see below. |

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

## Prefixing public members

Inside a library, most classes are internal, and their public members are
public only to the other files of the library. `prefixPublicMembers: true`
renames those too, methods and properties alike, and `excludeClasses` lists
the classes whose public members are the actual API.

```json
{
    "plugins": [
        [
            "prefix-private-members",
            { "prefixPublicMembers": true, "excludeClasses": ["Tree"] }
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
    public element: HTMLElement; //  ->  _element
    public setParent(parent: Node) {} //  ->  _setParent
}
```

Every public member is renamed, with or without a `public` modifier: methods,
properties, getters and setters, statics and parameter properties. A subclass
follows its base classes: a member that is renamed in the base class is renamed
in the subclass too, and a public member that an excluded base class keeps
stays in the subclass as well, so overrides keep working.

A method that implements a member of an interface named in the class's
`implements` clause keeps its name too: an object typed with the interface is
how it is called. Methods called through an object whose type the checker does
not know (see below) need their class in `excludeClasses`, or their name in
`excludeMembers`.

## Prefixing the keys of object parameters

A method that takes its arguments as one object, `render({ node, level })`,
has keys a minifier cannot mangle either. `prefixParameterKeys: true` renames
the keys of the object pattern parameters of every renamed method, and the
keys of the object literals passed to it:

```ts
class Tree {
    public open(node: Node) {
        this.render({ node, level: 1 }); //  ->  this._render({ _node: node, _level: 1 })
    }

    private render({ node, level = 0 }: Params) {} //  ->  _render({ _node: node, _level: level = 0 })
}
```

Constructors follow the public members: the keys of a constructor's object
parameter are renamed when the class is not in `excludeClasses` and
`prefixPublicMembers` is on, or when the constructor is `private` or
`protected`. The literals passed to `super(...)` and to `new X(...)` are
rewritten as well, also when `X` is imported from another project file:

```ts
import MouseHandler from "./mouseHandler";

new MouseHandler({ element, onClick }); //  ->  new MouseHandler({ _element: element, _onClick: onClick })
```

Functions get the same treatment: a function declaration, or a variable
holding an arrow or function expression, has the keys of its object pattern
parameters renamed, along with the literals at its calls, whether the call is
in the same file or reaches it through an import. `excludeFunctions` lists the
functions that are public API.

A function only qualifies when the objects it receives are written at its
calls. In its own file, every use must be a direct call passing an object
literal without spread, so a function passed as a callback or called with a
variable keeps its keys. A function that is exported must also type its object
parameters with a type literal or an interface or alias that is not exported:
an object of an exported type, like the options a library user passes in, can
come from anywhere. A call from another file that still passes something other
than a literal to a prefixed parameter is a build error naming the call, since
the parameter has already been renamed in its own file; the same holds for
methods and constructors called with a variable.

```ts
const iterate = (tree: Node, { handleNode }: Options) => {}; //  ->  { _handleNode: handleNode }

iterate(tree, { handleNode }); //  ->  iterate(tree, { _handleNode: handleNode })
```

Only the literal written at the call is rewritten. An object built elsewhere
and passed as a variable, a spread, a nested object, or a parameter typed as
an object without destructuring (`params: Params` with `params.node`) is not
followed. Which method, constructor or function a call reaches is what the
type checker resolves it to.

## How references are found

The plugin runs the TypeScript type checker over the file and the files it
imports, and asks it what every `object.x` refers to. A reference is rewritten
when it resolves to a member of a class in a project file, whatever the path
there: `this` and `super`, a typed variable or parameter, a union, a generic,
the result of a call, the element of an array, the parameter of a callback, a
destructured value, a cast.

```ts
class Node {
    public addChild(node: Node): void {
        node.setParent(this); //  ->  node._setParent(this)
        this.children.forEach((child) => child.render()); //  ->  child._render()
    }

    private setParent(parent: Node): void {}
    private render(): void {}
}
```

A reference is left alone when the checker does not know its type: an `any`,
an implicit any, an import that does not resolve, or `this` inside a nested
`function` that binds its own `this`. A reference through a union whose members
disagree, a class that renames the member and an interface that keeps it, is a
build error naming the reference: give the object one type, or exclude the
member.

The compiler options come from the nearest `tsconfig.json` above `root`, or
the one named by the `tsconfig` option, so module resolution, `paths` and
`lib` are the project's own. `tsconfig: false` uses built-in defaults: strict,
ESNext, bundler module resolution. Every file is treated as a module, as Babel
does, and `.js` files are included. Project files are the files that are not
in `node_modules` and not lib files; classes from packages are never renamed,
and neither are members inherited from them.

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
