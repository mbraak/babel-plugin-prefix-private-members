# Changelog

## 0.3.0

- The plugin now asks the TypeScript type checker what every `object.x`
  refers to, instead of reading type annotations itself. References are
  rewritten through unions, generics, inferred types, callback parameters and
  anything else the checker can type. `typescript` is a peer dependency.
- The compiler options come from the project's tsconfig.json (`tsconfig`
  option), so module resolution and `paths` are the project's own. `aliases`
  is still accepted and added to `paths`.
- A member that a base class from outside the project already has
  (`HTMLElement.focus`) is no longer renamed. A method that implements a
  member of an interface from a package keeps its name too.
- A reference through a union whose members disagree about the renaming is a
  build error, naming the reference.
- Removed: the `memberAccess` option and the `prefix-private-members: all`
  file directive. Objects of a known type are followed as a matter of course,
  and a `<expr>.x` whose type is unknown is never renamed by name alone.

## 0.2.0

- `prefixPublicMembers` option: also rename the public members of every class,
  except the classes listed in `excludeClasses`.
- `prefixParameterKeys` option: also rename the keys of the object pattern
  parameters of renamed methods, constructors and functions, and of the
  object literals passed to them. `excludeFunctions` lists the functions to
  leave alone.
- A call that passes something other than an object literal to a prefixed
  parameter is a build error, naming the call.
- References through other objects are rewritten when the object's type is
  known from an annotation: typed members, parameters and variables, `new`,
  method and function return types, casts, arrays, destructured parameters
  typed by an interface, and type aliases, also across project files.
- A method that implements a member of an `implements` interface keeps its
  name, as do the methods of the built-in protocols such as `toString`.
- `excludeMembers` option: member names that are never renamed.
- Fix: members inherited from a base class declared in the same file were
  not renamed in the subclass.

## 0.1.0

- Initial release, extracted from the build of
  [tree-element](https://github.com/mbraak/tree-element).
