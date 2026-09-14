# Changelog

## Unreleased

- `prefixPublicMethods` option: also rename the public methods of every class,
  except the classes listed in `excludeClasses`.
- Fix: members inherited from a base class declared in the same file were
  not renamed in the subclass.

## 0.1.0

- Initial release, extracted from the build of
  [tree-element](https://github.com/mbraak/tree-element).
