/*
Babel plugin that prefixes TypeScript `private` and `protected` class members
with `_`, and rewrites the `this.` / `super.` references to them.

Pair it with a minifier that mangles properties matching the prefix (terser:
`mangle.properties.regex: /^_/`), and every private member is renamed to a
short name in the production bundle. The prefix becomes a build step instead
of a naming rule:

    class Tree {
        private container: HTMLElement;        ->  _container

        public open() {                        ->  open (untouched)
            this.render();                     ->  this._render()
        }

        private render() {}                    ->  _render
    }

The plugin is idempotent: a member whose name already starts with the prefix is
left alone, so it is safe to run over source that is already prefixed by hand.

Options
    prefix          string, default "_"
    accessibility   array, default ["private", "protected"]
    memberAccess    "this" (default) rewrites `this.x` and `super.x` only.
                    "all" rewrites every `<expr>.x` in the file whose property
                    name matches a member declared private/protected somewhere
                    in that same file.
    aliases         object, default {}: import prefix -> directory, for the
                    non-relative imports that are project files
                    ({ "app/": "./src/" }). Used to find base classes.
    root            string, default process.cwd(): what `aliases` are relative
                    to.

A class that reaches into the private members of *other* instances of itself
(`node.setParent(this)`) needs more than `this.`, and a comment at the top of
such a file asks for it, in any comment:

    // prefix-private-members: all

That renames every `<expr>.x` in the file whose name is private or protected in
that same file. It is per file and not the default because the name of a
private member is not unique: `document.createElement()` and
`this.options.saveState` may well live in a file that declares a private member
of that name, and renaming those would break them.

A subclass uses the protected members of its base class without redeclaring
them, so the base class is followed as well: when a class extends an imported
class, that file is read and parsed, and its private/protected member names are
renamed in the subclass too (recursively, up the whole chain). Only classes
imported over a relative path or one of the configured `aliases` are followed;
`extends HTMLElement` and classes from packages are left alone.

Known limit: `memberAccess: "this"` misses accesses through anything but
`this`/`super`, because deciding whether `x.foo` is *this* class's `foo` needs
type information Babel does not have.
*/

import type {
    File as BabelFile,
    NodePath,
    PluginAPI,
    PluginObject,
    types as t,
} from "@babel/core";

import { parseSync } from "@babel/core";
import fs from "node:fs";
import path from "node:path";

export interface Options {
    /** Default ["private", "protected"]. */
    accessibility?: string[];
    /** Import prefix -> directory, resolved against `root`. */
    aliases?: Record<string, string>;
    /**
     * "this" (the default) or "all". Typed as a string because it comes out of
     * a JSON config file, and is checked at runtime.
     */
    memberAccess?: string;
    /** Default "_". */
    prefix?: string;
    /** Default process.cwd(). */
    root?: string;
}

// The plugin options as the base class walk needs them: parsed, and with the
// cache key that tells two different accessibility lists apart.
interface BaseClassOptions {
    accessibility: Set<string>;
    aliases: Record<string, string>;
    cacheKey: string;
}

// Everything a class body can hold, of which only the four member types below
// are ours to rename; a static block or an index signature has no name.
type ClassBodyMember = t.ClassBody["body"][number];

type ClassSource = ImportedClass | LocalClass;

// What an export name points at: the class itself, or a re-export to follow.
interface ExportedClass {
    classNode?: null | t.ClassDeclaration;
    redirect?: ImportedClass;
}

// A class named by an `extends` clause: either in this file, or behind an
// import to follow.
interface ImportedClass {
    exportName: string;
    source: string;
}

interface LocalClass {
    classNode: t.ClassDeclaration;
}

type MemberNode =
    | t.ClassAccessorProperty
    | t.ClassMethod
    | t.ClassProperty
    | t.TSDeclareMethod;

type PropertyAccess = t.MemberExpression | t.OptionalMemberExpression;

const isMemberNode = (member: ClassBodyMember): member is MemberNode =>
    member.type === "ClassAccessorProperty" ||
    member.type === "ClassMethod" ||
    member.type === "ClassProperty" ||
    member.type === "TSDeclareMethod";

const getName = (node: t.Node): null | string => {
    if (node.type === "Identifier") {
        return node.name;
    }

    if (node.type === "StringLiteral") {
        return node.value;
    }

    return null;
};

const setName = (node: t.Node, name: string): void => {
    if (node.type === "Identifier") {
        node.name = name;
    } else if (node.type === "StringLiteral") {
        node.value = name;
    }
};

// An import or export name is always an identifier or a string.
const getModuleExportName = (node: t.Identifier | t.StringLiteral): string =>
    node.type === "Identifier" ? node.name : node.value;

// Key of a member declaration that this plugin may rename, or null.
const getMemberKey = (
    member: ClassBodyMember,
    accessibility: Set<string>,
): null | t.Node => {
    if (!isMemberNode(member)) {
        return null;
    }

    if (
        member.computed ||
        ("kind" in member && member.kind === "constructor")
    ) {
        return null;
    }

    if (
        member.accessibility == null ||
        !accessibility.has(member.accessibility)
    ) {
        return null;
    }

    return member.key;
};

const getMemberName = (
    member: ClassBodyMember,
    accessibility: Set<string>,
): null | string => {
    const key = getMemberKey(member, accessibility);

    return key == null ? null : getName(key);
};

// `constructor(private container: HTMLElement)` declares a member *and* a
// binding, so both have to be renamed.
const getParameterProperties = (
    member: ClassBodyMember,
): t.TSParameterProperty[] => {
    if (member.type !== "ClassMethod" || member.kind !== "constructor") {
        return [];
    }

    return member.params.filter(
        (param): param is t.TSParameterProperty =>
            param.type === "TSParameterProperty",
    );
};

const getParameterIdentifier = (
    parameterProperty: t.TSParameterProperty,
): t.Node => {
    const { parameter } = parameterProperty;

    if (parameter.type === "AssignmentPattern") {
        return parameter.left;
    }

    return parameter;
};

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"];

const parsedFiles = new Map<string, { mtimeMs: number; program: t.Program }>();
const baseClassMembers = new Map<string, string[]>();

// Base classes are parsed once and kept, keyed on the file's mtime so that a
// watching build picks up an edited base class.
const parseFile = (file: string): t.Program => {
    const { mtimeMs } = fs.statSync(file);
    const cached = parsedFiles.get(file);

    if (cached?.mtimeMs === mtimeMs) {
        return cached.program;
    }

    const ast = parseSync(fs.readFileSync(file, "utf8"), {
        babelrc: false,
        configFile: false,
        filename: file,
        parserOpts: { plugins: ["typescript"] },
        sourceType: "module",
    });

    if (!ast) {
        throw new Error(`prefix-private-members: could not parse ${file}`);
    }

    parsedFiles.set(file, { mtimeMs, program: ast.program });
    baseClassMembers.clear();

    return ast.program;
};

// Turns an import specifier into a file, for relative imports and for the
// configured aliases. Bare imports ("react") resolve to null: a class from a
// package is not ours to rename.
const resolveModule = (
    specifier: string,
    fromFile: string,
    aliases: Record<string, string>,
): null | string => {
    let target;

    if (specifier.startsWith(".")) {
        target = path.resolve(path.dirname(fromFile), specifier);
    } else {
        const alias = Object.entries(aliases).find(([prefix]) =>
            specifier.startsWith(prefix),
        );

        if (!alias) {
            return null;
        }

        const [prefix, directory] = alias;

        target = path.resolve(directory, specifier.slice(prefix.length) || ".");
    }

    const candidates = [
        ...EXTENSIONS.map((extension) => `${target}${extension}`),
        ...EXTENSIONS.map((extension) =>
            path.join(target, `index${extension}`),
        ),
        target,
    ];

    return (
        candidates.find(
            (candidate) =>
                fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
        ) ?? null
    );
};

const findLocalClass = (
    programNode: t.Program,
    name: string,
): null | t.ClassDeclaration => {
    for (const node of programNode.body) {
        const declaration =
            node.type === "ExportNamedDeclaration" ||
            node.type === "ExportDefaultDeclaration"
                ? node.declaration
                : node;

        if (
            declaration?.type === "ClassDeclaration" &&
            declaration.id?.name === name
        ) {
            return declaration;
        }
    }

    return null;
};

// Where a class name used as `extends` comes from: a class in this file, or an
// import to follow.
const findClassSource = (
    programNode: t.Program,
    name: string,
): ClassSource | null => {
    for (const node of programNode.body) {
        if (node.type !== "ImportDeclaration") {
            continue;
        }

        for (const specifier of node.specifiers) {
            if (specifier.local.name !== name) {
                continue;
            }

            if (specifier.type === "ImportDefaultSpecifier") {
                return { exportName: "default", source: node.source.value };
            }

            if (specifier.type === "ImportSpecifier") {
                return {
                    exportName: getModuleExportName(specifier.imported),
                    source: node.source.value,
                };
            }

            return null;
        }
    }

    const classNode = findLocalClass(programNode, name);

    return classNode ? { classNode } : null;
};

// The class an export name points at, or the re-export to follow.
const findExportedClass = (
    programNode: t.Program,
    exportName: string,
): ExportedClass => {
    for (const node of programNode.body) {
        if (
            node.type === "ExportDefaultDeclaration" &&
            exportName === "default"
        ) {
            const { declaration } = node;

            if (declaration.type === "ClassDeclaration") {
                return { classNode: declaration };
            }

            if (declaration.type === "Identifier") {
                return {
                    classNode: findLocalClass(programNode, declaration.name),
                };
            }
        }

        if (node.type !== "ExportNamedDeclaration") {
            continue;
        }

        if (
            node.declaration?.type === "ClassDeclaration" &&
            node.declaration.id?.name === exportName
        ) {
            return { classNode: node.declaration };
        }

        for (const specifier of node.specifiers) {
            if (
                specifier.type !== "ExportSpecifier" ||
                getModuleExportName(specifier.exported) !== exportName
            ) {
                continue;
            }

            if (node.source) {
                return {
                    redirect: {
                        exportName: getModuleExportName(specifier.local),
                        source: node.source.value,
                    },
                };
            }

            return {
                classNode: findLocalClass(
                    programNode,
                    getModuleExportName(specifier.local),
                ),
            };
        }
    }

    return {};
};

const getOwnMemberNames = (
    classNode: t.Class,
    accessibility: Set<string>,
): string[] =>
    classNode.body.body.flatMap((member) => {
        const names = [];
        const name = getMemberName(member, accessibility);

        if (name != null) {
            names.push(name);
        }

        for (const parameterProperty of getParameterProperties(member)) {
            if (
                parameterProperty.accessibility != null &&
                accessibility.has(parameterProperty.accessibility)
            ) {
                const parameterName = getName(
                    getParameterIdentifier(parameterProperty),
                );

                if (parameterName != null) {
                    names.push(parameterName);
                }
            }
        }

        return names;
    });

// The members of one class plus the ones it inherits.
const getClassMemberNames = (
    classNode: t.Class,
    programNode: t.Program,
    file: string,
    options: BaseClassOptions,
    seen: Set<string>,
): string[] => [
    ...getOwnMemberNames(classNode, options.accessibility),
    ...getBaseClassMemberNames(classNode, programNode, file, options, seen),
];

const getExportedClassMemberNames = (
    file: string,
    exportName: string,
    options: BaseClassOptions,
    seen: Set<string>,
): string[] => {
    const key = `${file}::${exportName}::${options.cacheKey}`;
    const cached = baseClassMembers.get(key);

    if (cached) {
        return cached;
    }

    if (seen.has(key)) {
        // A cycle in the imports; the names are already being collected.
        return [];
    }

    seen.add(key);

    const programNode = parseFile(file);
    const { classNode, redirect } = findExportedClass(programNode, exportName);
    let names: string[] = [];

    if (redirect) {
        const source = resolveModule(redirect.source, file, options.aliases);

        names = source
            ? getExportedClassMemberNames(
                  source,
                  redirect.exportName,
                  options,
                  seen,
              )
            : [];
    } else if (classNode) {
        names = getClassMemberNames(
            classNode,
            programNode,
            file,
            options,
            seen,
        );
    }

    baseClassMembers.set(key, names);

    return names;
};

// Members that `class X extends Y` inherits from Y, wherever Y lives.
const getBaseClassMemberNames = (
    classNode: t.Class,
    programNode: t.Program,
    file: string,
    options: BaseClassOptions,
    seen: Set<string>,
): string[] => {
    const { superClass } = classNode;

    if (superClass?.type !== "Identifier") {
        return [];
    }

    const classSource = findClassSource(programNode, superClass.name);

    if (!classSource) {
        return [];
    }

    if ("classNode" in classSource) {
        return getClassMemberNames(
            classSource.classNode,
            programNode,
            file,
            options,
            seen,
        );
    }

    const source = resolveModule(classSource.source, file, options.aliases);

    return source
        ? getExportedClassMemberNames(
              source,
              classSource.exportName,
              options,
              seen,
          )
        : [];
};

// Property name of `a.b` / `a?.b`, or null when it cannot be renamed.
const getPropertyName = (node: PropertyAccess): null | string => {
    if (node.computed) {
        return null;
    }

    return getName(node.property);
};

// A parameter property declares a member *and* a binding, and Babel does not
// track that binding in its scope info, so the references in the constructor
// body are renamed by hand.
const renameParameter = (
    constructorPath: NodePath<t.ClassMethod>,
    identifier: t.Node,
    name: string,
    newName: string,
): void => {
    setName(identifier, newName);

    constructorPath.get("body").traverse({
        Identifier(path) {
            if (path.node.name !== name) {
                return;
            }

            // A binding with this name means an inner declaration shadows the
            // parameter.
            if (path.scope.getBinding(name)) {
                return;
            }

            const { parentPath } = path;
            const isAssignmentTarget =
                parentPath.isAssignmentExpression() &&
                parentPath.node.left === path.node;

            if (path.isReferencedIdentifier() || isAssignmentTarget) {
                path.node.name = newName;
            }
        },
    });
};

const DIRECTIVE = /prefix-private-members:\s*all/;

const hasAllDirective = (file: BabelFile): boolean =>
    (file.ast.comments ?? []).some((comment) => DIRECTIVE.test(comment.value));

const isInstanceReference = (node: PropertyAccess): boolean => {
    const { object } = node;

    return object.type === "ThisExpression" || object.type === "Super";
};

export default function prefixPrivateMembers(
    _api: PluginAPI,
    options: Options = {},
): PluginObject {
    const prefix = options.prefix ?? "_";
    const accessibility = new Set(
        options.accessibility ?? ["private", "protected"],
    );
    const memberAccess = options.memberAccess ?? "this";

    if (memberAccess !== "this" && memberAccess !== "all") {
        throw new Error(
            `prefix-private-members: memberAccess must be "this" or "all", got "${memberAccess}"`,
        );
    }

    const root = options.root ?? process.cwd();
    const aliases = Object.fromEntries(
        Object.entries(options.aliases ?? {}).map(([alias, target]) => [
            alias,
            path.resolve(root, target),
        ]),
    );
    const baseClassOptions: BaseClassOptions = {
        accessibility,
        aliases,
        cacheKey: [...accessibility].sort().join(","),
    };

    // Members inherited from base classes: declared elsewhere, but referenced
    // here, so they need the same rename.
    const getInheritedRenames = (
        classPath: NodePath<t.Class>,
        programPath: NodePath<t.Program>,
        filename: string | undefined,
    ): Map<string, string> => {
        const renames = new Map<string, string>();

        if (filename == null) {
            return renames;
        }

        const names = getBaseClassMemberNames(
            classPath.node,
            programPath.node,
            filename,
            baseClassOptions,
            new Set(),
        );

        for (const name of names) {
            if (!name.startsWith(prefix)) {
                renames.set(name, `${prefix}${name}`);
            }
        }

        return renames;
    };

    // Renames the declarations of one class and returns them as old -> new.
    const renameDeclarations = (
        classPath: NodePath<t.Class>,
    ): Map<string, string> => {
        const renames = new Map<string, string>();

        for (const memberPath of classPath.get("body").get("body")) {
            const key = getMemberKey(memberPath.node, accessibility);
            const name = key == null ? null : getName(key);

            if (key != null && name != null && !name.startsWith(prefix)) {
                renames.set(name, `${prefix}${name}`);
                setName(key, `${prefix}${name}`);
            }

            if (!memberPath.isClassMethod()) {
                continue;
            }

            for (const parameterProperty of getParameterProperties(
                memberPath.node,
            )) {
                if (
                    parameterProperty.accessibility == null ||
                    !accessibility.has(parameterProperty.accessibility)
                ) {
                    continue;
                }

                const identifier = getParameterIdentifier(parameterProperty);
                const parameterName = getName(identifier);

                if (parameterName == null || parameterName.startsWith(prefix)) {
                    continue;
                }

                renames.set(parameterName, `${prefix}${parameterName}`);
                renameParameter(
                    memberPath,
                    identifier,
                    parameterName,
                    `${prefix}${parameterName}`,
                );
            }
        }

        return renames;
    };

    // Rewrites `this.x` and `super.x` inside one class body. Nested classes
    // and nested non-arrow functions are skipped: their `this` is a different
    // object, and a nested class is visited on its own.
    const rewriteInstanceReferences = (
        classPath: NodePath<t.Class>,
        renames: Map<string, string>,
    ): void => {
        const rewrite = (path: NodePath<PropertyAccess>) => {
            if (!isInstanceReference(path.node)) {
                return;
            }

            const name = getPropertyName(path.node);

            if (name == null) {
                return;
            }

            const newName = renames.get(name);

            if (newName != null) {
                setName(path.node.property, newName);
            }
        };

        classPath.get("body").traverse({
            Class(path) {
                path.skip();
            },
            Function(path) {
                if (path.isArrowFunctionExpression() || path.isClassMethod()) {
                    return;
                }

                path.skip();
            },
            MemberExpression: rewrite,
            OptionalMemberExpression: rewrite,
        });
    };

    // "all": rewrite every access to a name that is private or protected
    // somewhere in this file, whatever the object is.
    const rewriteAllReferences = (
        programPath: NodePath<t.Program>,
        renames: Map<string, string>,
    ): void => {
        const rewrite = (path: NodePath<PropertyAccess>) => {
            const name = getPropertyName(path.node);
            const newName = name == null ? undefined : renames.get(name);

            if (newName != null) {
                setName(path.node.property, newName);
            }
        };

        programPath.traverse({
            MemberExpression: rewrite,
            OptionalMemberExpression: rewrite,
        });
    };

    return {
        name: "prefix-private-members",
        visitor: {
            Program(programPath, state) {
                const allRenames = new Map<string, string>();
                const rewriteAll =
                    memberAccess === "all" || hasAllDirective(state.file);

                programPath.traverse({
                    Class(classPath) {
                        const renames = new Map([
                            ...getInheritedRenames(
                                classPath,
                                programPath,
                                state.filename,
                            ),
                            ...renameDeclarations(classPath),
                        ]);

                        if (renames.size === 0) {
                            return;
                        }

                        if (!rewriteAll) {
                            rewriteInstanceReferences(classPath, renames);
                        }

                        for (const [name, newName] of renames) {
                            allRenames.set(name, newName);
                        }
                    },
                });

                if (rewriteAll && allRenames.size > 0) {
                    rewriteAllReferences(programPath, allRenames);
                }
            },
        },
    };
}
