# Changelog

## Unreleased

- `prefixPublicMethods` option: also rename the public methods of every class,
  except the classes listed in `excludeClasses`.
- `prefixParameterKeys` option: also rename the keys of the object pattern
  parameters of renamed methods and constructors, and of the object literals
  passed to them.
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
