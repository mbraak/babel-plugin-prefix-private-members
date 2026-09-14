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
    prefixPublicMembers
                    boolean, default false: also rename the public members
                    (with or without a `public` modifier: methods, properties,
                    accessors, statics) of every class that is not listed in
                    `excludeClasses`. The public members of an excluded class
                    are the public API.
    excludeClasses  array, default []: names of the classes whose public
                    members keep their names.
    excludeFunctions
                    array, default []: names of the functions whose object
                    parameter keys keep their names under `prefixParameterKeys`.
    excludeMembers  array, default []: member names that are never renamed,
                    in any class. The methods of the built-in protocols
                    (`toString`, `valueOf`, `toJSON`, `then`, the custom
                    element callbacks, ...) are never renamed anyway: they are
                    called by the runtime, not by name in the code.
    prefixParameterKeys
                    boolean, default false: also rename the keys of the object
                    pattern parameters of renamed methods and constructors
                    (`render({ node })` -> `render({ _node: node })`), and
                    the keys of the object literals passed to them through
                    `this.x(...)`, `super.x(...)`, `super(...)` and
                    `new X(...)`, where X is a project class. The constructor
                    follows the public members: its keys are renamed when the
                    class is not excluded and `prefixPublicMembers` is on, or
                    when the constructor is private or protected.
                    Functions get the same treatment: a function declaration
                    or a variable holding an arrow or function expression,
                    called directly by name in its file or through an import,
                    except the names in `excludeFunctions`. A function that
                    is also used as a value (passed as a callback, stored)
                    keeps its keys: its objects then come from elsewhere.

A subclass follows the decisions of its base classes: a method that is renamed
in the base class is renamed in the subclass too, whatever its modifier there,
and a public member that an excluded base class keeps stays in the subclass as
well, so that overrides keep working.

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

References through other objects are followed by their type annotations, as
far as the plugin reads them: `this.handler.x` through the declared type of
the `handler` member, `node.x` through the type of the parameter or variable
`node` (also a `new X()` initializer, a `for...of` over an `X[]`, or a
`{ node }: Params` parameter with a local `interface Params`), `create().x`
through the return type of the method or local function, `(x as Node).y`
through the cast. An object whose type the plugin cannot read is left alone,
unless `memberAccess: "all"` or the file comment says otherwise.
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
    /** Classes whose public members `prefixPublicMembers` leaves alone. */
    excludeClasses?: string[];
    /** Functions whose object parameter keys `prefixParameterKeys` leaves alone. */
    excludeFunctions?: string[];
    /** Member names that are never renamed, in any class. Default []. */
    excludeMembers?: string[];
    /**
     * "this" (the default) or "all". Typed as a string because it comes out of
     * a JSON config file, and is checked at runtime.
     */
    memberAccess?: string;
    /** Default "_". */
    prefix?: string;
    /**
     * Also rename the keys of object pattern parameters of renamed methods
     * and constructors, and of the object literals passed to them. Default
     * false.
     */
    prefixParameterKeys?: boolean;
    /**
     * Also rename the public members of every class not in `excludeClasses`.
     * Default false.
     */
    prefixPublicMembers?: boolean;
    /** Default process.cwd(). */
    root?: string;
}

// The plugin options as the base class walk needs them: parsed, and with the
// cache key that tells two different member selections apart.
interface BaseClassOptions {
    accessibility: Set<string>;
    aliases: Record<string, string>;
    cacheKey: string;
    excludeClasses: Set<string>;
    excludeFunctions: Set<string>;
    excludeMembers: Set<string>;
    prefixPublicMembers: boolean;
}

// Members that the runtime or a library calls by name, whatever the class:
// the conversion protocols, thenables, iterators, and the callbacks of a
// custom element. Never renamed.
const PROTOCOL_MEMBERS = new Set([
    "adoptedCallback",
    "attributeChangedCallback",
    "catch",
    "connectedCallback",
    "disconnectedCallback",
    "finally",
    "formAssociatedCallback",
    "formDisabledCallback",
    "formResetCallback",
    "formStateRestoreCallback",
    "next",
    "observedAttributes",
    "return",
    "then",
    "throw",
    "toJSON",
    "toLocaleString",
    "toString",
    "valueOf",
]);

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

// What a class decides about one member name, its own or an inherited one.
interface MemberDecision {
    /**
     * For a method or constructor: per parameter, the keys of an object
     * pattern parameter (`{ node, level }`), or null for any other parameter.
     * Null when no parameter is an object pattern.
     */
    parameterKeys: (null | string[])[] | null;
    /** Whether the name, and the keys of its object parameters, is prefixed. */
    renamed: boolean;
    /**
     * The class the member's type annotation names: the type of a property,
     * the return type of a method or getter. Null when it is not a project
     * class.
     */
    type: ClassType | null;
}

// A class named by a type annotation or an `extends` clause: declared in a
// file, or an export of one to follow.
type ClassRef =
    | { classNode: t.Class; file: string | undefined }
    | { exportName: string; file: string };

// A type as far as this plugin reads it: a project class, an array of one,
// or a function that returns one of those.
type ClassType = { array: boolean; ref: ClassRef } | { returns: ClassType };

// An instance of a project class: the only type with members to rename.
const getInstanceRef = (type: ClassType | null): ClassRef | null =>
    type && "ref" in type && !type.array ? type.ref : null;

// The element type of an array of a project class.
const getElementType = (type: ClassType | null): ClassType | null =>
    type && "ref" in type && type.array
        ? { array: false, ref: type.ref }
        : null;

// What a call to something of this type returns.
const getReturnType = (type: ClassType | null): ClassType | null =>
    type && "returns" in type ? type.returns : null;

// Type aliases are followed this far, so that a cycle ends.
const MAX_TYPE_DEPTH = 8;

// For every member name a class declares or inherits. A subclass has to
// follow the base class here, or an override would end up under a different
// name. The constructor is in here under CONSTRUCTOR, for the keys of its
// object parameters; its name itself is never renamed.
type MemberDecisions = Map<string, MemberDecision>;

const CONSTRUCTOR = "constructor";

type MemberNode =
    | t.ClassAccessorProperty
    | t.ClassMethod
    | t.ClassProperty
    | t.TSDeclareMethod;

type PropertyAccess = t.MemberExpression | t.OptionalMemberExpression;

// What a name is bound to, as Babel's scope tracking knows it.
type Binding = NonNullable<ReturnType<NodePath["scope"]["getBinding"]>>;

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

// Key of a member declaration that has a name this plugin could rename, or
// null: a constructor, a computed key, a static block or an index signature.
const getMemberKey = (member: ClassBodyMember): null | t.Node => {
    if (!isMemberNode(member)) {
        return null;
    }

    if (member.computed || isConstructor(member)) {
        return null;
    }

    return member.key;
};

const isMethodNode = (
    member: ClassBodyMember,
): member is t.ClassMethod | t.TSDeclareMethod =>
    member.type === "ClassMethod" || member.type === "TSDeclareMethod";

const isConstructor = (member: ClassBodyMember): boolean =>
    isMethodNode(member) && member.kind === "constructor";

// The name a member is decided about: CONSTRUCTOR for the constructor.
const getDecisionName = (member: MemberNode): null | string => {
    if (isConstructor(member)) {
        return CONSTRUCTOR;
    }

    const key = getMemberKey(member);

    return key == null ? null : getName(key);
};

// Whether a class renames its public members: only when asked to, and not
// for the excluded classes. An anonymous class cannot be excluded.
const renamesPublicMembers = (
    classNode: t.Class,
    options: BaseClassOptions,
): boolean =>
    options.prefixPublicMembers &&
    (classNode.id == null || !options.excludeClasses.has(classNode.id.name));

// Whether a member with this name and modifier is one to rename, going by
// those alone. For the constructor this decides about the keys of its object
// parameters; its name always stays.
const isRenamedMember = (
    name: string,
    accessibility: null | string | undefined,
    publicMembers: boolean,
    options: BaseClassOptions,
): boolean => {
    if (PROTOCOL_MEMBERS.has(name) || options.excludeMembers.has(name)) {
        return false;
    }

    if (accessibility != null && options.accessibility.has(accessibility)) {
        return true;
    }

    const isPublic = accessibility == null || accessibility === "public";

    return isPublic && publicMembers;
};

// The object pattern of a parameter: `{ node }` or `{ node } = {}`.
const getObjectPattern = (parameter: t.Node): null | t.ObjectPattern => {
    if (parameter.type === "ObjectPattern") {
        return parameter;
    }

    if (
        parameter.type === "AssignmentPattern" &&
        parameter.left.type === "ObjectPattern"
    ) {
        return parameter.left;
    }

    return null;
};

// The keys of an object pattern or literal that can be renamed: not computed,
// not a spread or rest element.
const getObjectKeys = (
    object: t.ObjectExpression | t.ObjectPattern,
): string[] =>
    object.properties.flatMap((property) => {
        if (
            (property.type !== "ObjectProperty" &&
                property.type !== "ObjectMethod") ||
            property.computed
        ) {
            return [];
        }

        const name = getName(property.key);

        return name == null ? [] : [name];
    });

// Per parameter of a method, the keys of its object pattern; null when there
// is no object pattern among the parameters.
const getParameterKeys = (
    member: t.Function | t.TSDeclareMethod,
): (null | string[])[] | null => {
    const keys = member.params.map((parameter) => {
        const pattern = getObjectPattern(parameter);

        return pattern ? getObjectKeys(pattern) : null;
    });

    return keys.some((parameterKeys) => parameterKeys != null) ? keys : null;
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
const baseClassMembers = new Map<string, MemberDecisions>();

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
    functionDecisions.clear();

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

// A function whose object parameter keys the plugin may rename: a function
// declaration, or an arrow or function expression held by a variable.
type NamedFunction =
    t.ArrowFunctionExpression | t.FunctionDeclaration | t.FunctionExpression;

// What the plugin decides about the parameters of a function.
interface FunctionDecision {
    parameterKeys: (null | string[])[] | null;
    renamed: boolean;
}

const isNamedFunction = (node: t.Node): node is NamedFunction =>
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression";

// The function a variable declarator holds, with its name.
const getDeclaredFunction = (
    node: t.Node,
): null | { fn: NamedFunction; name: string } => {
    if (node.type === "FunctionDeclaration" && node.id) {
        return { fn: node, name: node.id.name };
    }

    if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init &&
        isNamedFunction(node.init)
    ) {
        return { fn: node.init, name: node.id.name };
    }

    return null;
};

// A function declared at the top level of a file, by name.
const findLocalFunction = (
    programNode: t.Program,
    name: string,
): null | { fn: NamedFunction; name: string } => {
    for (const node of programNode.body) {
        const declaration =
            node.type === "ExportNamedDeclaration" ||
            node.type === "ExportDefaultDeclaration"
                ? node.declaration
                : node;

        if (declaration?.type === "VariableDeclaration") {
            for (const declarator of declaration.declarations) {
                const declared = getDeclaredFunction(declarator);

                if (declared?.name === name) {
                    return declared;
                }
            }
        } else if (declaration) {
            const declared = getDeclaredFunction(declaration);

            if (declared?.name === name) {
                return declared;
            }
        }
    }

    return null;
};

// What an export name points at: the function itself, or a re-export to
// follow. Mirrors findExportedClass.
const findExportedFunction = (
    programNode: t.Program,
    exportName: string,
): {
    declared?: null | { fn: NamedFunction; name: null | string };
    redirect?: ImportedClass;
} => {
    for (const node of programNode.body) {
        if (
            node.type === "ExportDefaultDeclaration" &&
            exportName === "default"
        ) {
            const { declaration } = node;

            if (declaration.type === "Identifier") {
                return {
                    declared: findLocalFunction(programNode, declaration.name),
                };
            }

            if (isNamedFunction(declaration)) {
                return {
                    declared: {
                        fn: declaration,
                        name:
                            declaration.type === "FunctionDeclaration"
                                ? (declaration.id?.name ?? null)
                                : null,
                    },
                };
            }
        }

        if (node.type !== "ExportNamedDeclaration") {
            continue;
        }

        if (node.declaration) {
            const declared = findLocalFunction(
                { ...programNode, body: [node] },
                exportName,
            );

            if (declared) {
                return { declared };
            }
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
                declared: findLocalFunction(
                    programNode,
                    getModuleExportName(specifier.local),
                ),
            };
        }
    }

    return {};
};

// The indexes of the parameters that are object patterns.
const getObjectPatternIndexes = (fn: NamedFunction): number[] =>
    fn.params.flatMap((parameter, index) =>
        getObjectPattern(parameter) ? [index] : [],
    );

// A literal whose keys can all be renamed: no spread, whose keys are unknown.
const isPlainObjectLiteral = (node: t.Node | undefined): boolean =>
    node?.type === "ObjectExpression" &&
    node.properties.every((property) => property.type !== "SpreadElement");

// How a file uses a function of its own. The keys of its object parameters
// can only be renamed when every object it receives is a literal written at
// a call: a function that is also passed around as a value, or called with an
// object built elsewhere, gets its objects from somewhere the plugin does not
// see. The check goes by name over the whole file, which is on the safe side
// for a name that is declared twice.
interface FunctionUse {
    /** Whether other files can reach the function. */
    exported: boolean;
    /** Whether every use is a call with a literal for each object parameter. */
    safe: boolean;
}

const analyzeFunctionUse = (
    programNode: t.Program,
    name: string,
    fn: NamedFunction,
): FunctionUse => {
    const patternIndexes = getObjectPatternIndexes(fn);
    const use: FunctionUse = { exported: false, safe: true };

    const visit = (node: t.Node, parent: t.Node | null): void => {
        if (
            (node.type === "ExportNamedDeclaration" ||
                node.type === "ExportDefaultDeclaration") &&
            node.declaration
        ) {
            const declarations =
                node.declaration.type === "VariableDeclaration"
                    ? node.declaration.declarations
                    : [node.declaration];

            if (
                declarations.some(
                    (declaration) =>
                        getDeclaredFunction(declaration)?.fn === fn,
                )
            ) {
                use.exported = true;
            }
        }

        if (node.type === "Identifier" && node.name === name && parent) {
            const isCall =
                (parent.type === "CallExpression" ||
                    parent.type === "OptionalCallExpression") &&
                parent.callee === node;
            const isDeclaration =
                (parent.type === "FunctionDeclaration" && parent.id === node) ||
                (parent.type === "VariableDeclarator" && parent.id === node) ||
                parent.type === "ImportSpecifier" ||
                parent.type === "ImportDefaultSpecifier";
            const isExport =
                parent.type === "ExportSpecifier" ||
                parent.type === "ExportDefaultDeclaration";
            const isPropertyName =
                ((parent.type === "MemberExpression" ||
                    parent.type === "OptionalMemberExpression") &&
                    parent.property === node &&
                    !parent.computed) ||
                ((parent.type === "ObjectProperty" ||
                    parent.type === "ObjectMethod" ||
                    parent.type === "ClassProperty" ||
                    parent.type === "ClassMethod" ||
                    parent.type === "TSPropertySignature" ||
                    parent.type === "TSMethodSignature") &&
                    parent.key === node &&
                    !parent.computed);
            const isType =
                parent.type === "TSTypeReference" ||
                parent.type === "TSTypeQuery" ||
                parent.type === "TSInterfaceDeclaration" ||
                parent.type === "TSTypeAliasDeclaration";

            if (isExport) {
                use.exported = true;
            } else if (isCall) {
                const call = parent as t.CallExpression;

                for (const index of patternIndexes) {
                    const argument = call.arguments[index];

                    if (argument && !isPlainObjectLiteral(argument)) {
                        use.safe = false;
                    }
                }
            } else if (!isDeclaration && !isPropertyName && !isType) {
                use.safe = false;
            }
        }

        forEachChildNode(node, (child) => {
            visit(child, node);
        });
    };

    visit(programNode, null);

    return use;
};

// Whether an interface or type alias is declared in this file without being
// exported: a type that only this file can name.
const isPrivateType = (programNode: t.Program, name: string): boolean =>
    programNode.body.some(
        (node) =>
            (node.type === "TSInterfaceDeclaration" ||
                node.type === "TSTypeAliasDeclaration") &&
            node.id.name === name,
    );

// Whether the object parameters of a function are typed with types private
// to its file. For a function that other files can call, that is the sign
// that the objects are written at the calls: an object of an exported type
// may come from anywhere, like the options a library user passes in.
const hasPrivateParameterTypes = (
    fn: NamedFunction,
    programNode: t.Program,
): boolean =>
    getObjectPatternIndexes(fn).every((index) => {
        const parameter = fn.params[index];
        const pattern = parameter ? getObjectPattern(parameter) : null;
        const annotation = pattern?.typeAnnotation;

        if (annotation?.type !== "TSTypeAnnotation") {
            return false;
        }

        const type = annotation.typeAnnotation;

        return (
            type.type === "TSTypeLiteral" ||
            (type.type === "TSTypeReference" &&
                type.typeName.type === "Identifier" &&
                isPrivateType(programNode, type.typeName.name))
        );
    });

const getFunctionDecision = (
    fn: NamedFunction,
    name: null | string,
    programNode: t.Program,
    options: BaseClassOptions,
): FunctionDecision => {
    const parameterKeys = getParameterKeys(fn);

    if (
        parameterKeys == null ||
        name == null ||
        options.excludeFunctions.has(name)
    ) {
        return { parameterKeys, renamed: false };
    }

    const use = analyzeFunctionUse(programNode, name, fn);

    return {
        parameterKeys,
        renamed:
            use.safe &&
            (!use.exported || hasPrivateParameterTypes(fn, programNode)),
    };
};

const functionDecisions = new Map<string, FunctionDecision>();

// The decision about a function exported by another project file.
const getExportedFunctionDecision = (
    file: string,
    exportName: string,
    options: BaseClassOptions,
    seen: Set<string>,
): FunctionDecision | null => {
    const key = `${file}::${exportName}::${options.cacheKey}`;
    const cached = functionDecisions.get(key);

    if (cached) {
        return cached;
    }

    if (seen.has(key)) {
        return null;
    }

    seen.add(key);

    const programNode = parseFile(file);
    const { declared, redirect } = findExportedFunction(
        programNode,
        exportName,
    );
    let decision: FunctionDecision | null = null;

    if (redirect) {
        const source = resolveModule(redirect.source, file, options.aliases);

        decision = source
            ? getExportedFunctionDecision(
                  source,
                  redirect.exportName,
                  options,
                  seen,
              )
            : null;
    } else if (declared) {
        decision = getFunctionDecision(
            declared.fn,
            declared.name,
            programNode,
            options,
        );
    }

    if (decision) {
        functionDecisions.set(key, decision);
    }

    return decision;
};

// What a class name used in a file refers to: a class in that file, or an
// export of another project file. Null for a class from a package, and for
// anything that is not a class at all.
const resolveClassName = (
    name: string,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): ClassRef | null => {
    const classSource = findClassSource(programNode, name);

    if (!classSource) {
        return null;
    }

    if ("classNode" in classSource) {
        return { classNode: classSource.classNode, file };
    }

    if (file == null) {
        return null;
    }

    const source = resolveModule(classSource.source, file, options.aliases);

    return source ? { exportName: classSource.exportName, file: source } : null;
};

type TypeDeclaration = t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration;

// A type declaration with the file it is in, so that the names in it are
// resolved there.
interface LocatedTypeDeclaration {
    declaration: TypeDeclaration;
    file: string | undefined;
    programNode: t.Program;
}

// An interface or type alias declared in a file, exported or not.
const findTypeDeclaration = (
    programNode: t.Program,
    name: string,
    exportedOnly: boolean,
): null | TypeDeclaration => {
    for (const node of programNode.body) {
        const declaration =
            node.type === "ExportNamedDeclaration"
                ? node.declaration
                : exportedOnly
                  ? null
                  : node;

        if (
            (declaration?.type === "TSInterfaceDeclaration" ||
                declaration?.type === "TSTypeAliasDeclaration") &&
            declaration.id.name === name
        ) {
            return declaration;
        }
    }

    return null;
};

// The interface or type alias a name stands for in a file: declared there,
// or imported from another project file.
const resolveTypeDeclaration = (
    name: string,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): LocatedTypeDeclaration | null => {
    const local = findTypeDeclaration(programNode, name, false);

    if (local) {
        return { declaration: local, file, programNode };
    }

    const classSource = findClassSource(programNode, name);

    if (classSource == null || "classNode" in classSource || file == null) {
        return null;
    }

    const source = resolveModule(classSource.source, file, options.aliases);

    if (source == null) {
        return null;
    }

    const sourceProgram = parseFile(source);
    const declaration = findTypeDeclaration(
        sourceProgram,
        classSource.exportName,
        true,
    );

    return declaration
        ? { declaration, file: source, programNode: sourceProgram }
        : null;
};

// What a type name used in a file stands for: a class in this file or in
// another project file, or a type alias to read further.
const resolveTypeName = (
    name: string,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
    depth: number,
): ClassType | null => {
    const classSource = findClassSource(programNode, name);

    if (classSource && "classNode" in classSource) {
        return {
            array: false,
            ref: { classNode: classSource.classNode, file },
        };
    }

    const located = resolveTypeDeclaration(name, programNode, file, options);

    if (located) {
        return located.declaration.type === "TSTypeAliasDeclaration"
            ? getClassType(
                  located.declaration.typeAnnotation,
                  located.programNode,
                  located.file,
                  options,
                  depth + 1,
              )
            : null;
    }

    if (classSource == null || file == null) {
        return null;
    }

    const source = resolveModule(classSource.source, file, options.aliases);

    if (source == null) {
        return null;
    }

    const { classNode, redirect } = findExportedClass(
        parseFile(source),
        classSource.exportName,
    );

    return classNode || redirect
        ? {
              array: false,
              ref: { exportName: classSource.exportName, file: source },
          }
        : null;
};

// Reads a type as far as this plugin does: `Node`, `Node | null`, `Node[]`,
// `Array<Node>`, `readonly Node[]`, `() => Node`, and type aliases of those.
const getClassType = (
    type: t.TSType,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
    depth = 0,
): ClassType | null => {
    if (depth > MAX_TYPE_DEPTH) {
        return null;
    }

    const read = (inner: t.TSType): ClassType | null =>
        getClassType(inner, programNode, file, options, depth);

    const readElement = (elementType: t.TSType): ClassType | null => {
        const ref = getInstanceRef(read(elementType));

        return ref ? { array: true, ref } : null;
    };

    switch (type.type) {
        case "TSArrayType":
            return readElement(type.elementType);

        case "TSFunctionType": {
            const returns = type.returnType
                ? read(type.returnType.typeAnnotation)
                : null;

            return returns ? { returns } : null;
        }

        case "TSParenthesizedType":
            return read(type.typeAnnotation);

        case "TSTypeOperator":
            return type.operator === "readonly"
                ? read(type.typeAnnotation)
                : null;

        case "TSTypeReference": {
            if (type.typeName.type !== "Identifier") {
                return null;
            }

            const { name } = type.typeName;
            const [typeArgument] = type.typeArguments?.params ?? [];

            if (
                (name === "Array" || name === "ReadonlyArray") &&
                typeArgument
            ) {
                return readElement(typeArgument);
            }

            return resolveTypeName(name, programNode, file, options, depth);
        }

        case "TSUnionType": {
            const types = type.types.filter(
                (member) =>
                    member.type !== "TSNullKeyword" &&
                    member.type !== "TSUndefinedKeyword",
            );
            const [only] = types;

            return types.length === 1 && only ? read(only) : null;
        }

        default:
            return null;
    }
};

// The keys of a node that hold no child nodes.
const NON_CHILD_KEYS = new Set([
    "end",
    "extra",
    "innerComments",
    "leadingComments",
    "loc",
    "range",
    "start",
    "trailingComments",
    "type",
]);

const isNode = (value: unknown): value is t.Node =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string";

const forEachChildNode = (
    node: t.Node,
    visit: (child: t.Node) => void,
): void => {
    for (const [key, value] of Object.entries(node)) {
        if (NON_CHILD_KEYS.has(key)) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item)) {
                    visit(item);
                }
            }
        } else if (isNode(value)) {
            visit(value);
        }
    }
};

// The expressions a function body returns, leaving nested functions and
// classes to themselves.
const collectReturns = (node: t.Node, returns: t.Node[]): void => {
    forEachChildNode(node, (child) => {
        if (child.type === "ReturnStatement") {
            if (child.argument) {
                returns.push(child.argument);
            }
        } else if (
            child.type !== "ArrowFunctionExpression" &&
            child.type !== "ClassDeclaration" &&
            child.type !== "ClassExpression" &&
            child.type !== "FunctionDeclaration" &&
            child.type !== "FunctionExpression" &&
            child.type !== "ObjectMethod"
        ) {
            collectReturns(child, returns);
        }
    });
};

const isSameRef = (a: ClassRef, b: ClassRef): boolean =>
    "classNode" in a
        ? "classNode" in b && a.classNode === b.classNode
        : "exportName" in b &&
          a.file === b.file &&
          a.exportName === b.exportName;

// The return type of a function without an annotation, as far as it can be
// read from what it returns: `return new Handler(...)` in every return.
const inferReturnType = (
    fn: t.Function,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): ClassType | null => {
    const returns: t.Node[] = [];

    if (fn.body.type === "BlockStatement") {
        collectReturns(fn.body, returns);
    } else {
        returns.push(fn.body);
    }

    let result: ClassType | null = null;

    for (const expression of returns) {
        if (
            expression.type !== "NewExpression" ||
            expression.callee.type !== "Identifier"
        ) {
            return null;
        }

        const type = resolveTypeName(
            expression.callee.name,
            programNode,
            file,
            options,
            0,
        );
        const ref = getInstanceRef(type);
        const resultRef = getInstanceRef(result);

        if (ref == null || (resultRef != null && !isSameRef(ref, resultRef))) {
            return null;
        }

        result = type;
    }

    return result;
};

// The type of a function: what it is declared or seen to return.
const getFunctionType = (
    fn: t.Function,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): ClassType | null => {
    const returns =
        getAnnotationClassType(fn.returnType, programNode, file, options) ??
        inferReturnType(fn, programNode, file, options);

    return returns ? { returns } : null;
};

// The class type of an annotation (`: Node`), or null.
const getAnnotationClassType = (
    annotation: null | t.TSTypeAnnotation | t.TypeAnnotation | undefined,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): ClassType | null =>
    annotation?.type === "TSTypeAnnotation"
        ? getClassType(annotation.typeAnnotation, programNode, file, options)
        : null;

// A member of an object type, with the file its type names are resolved in.
interface LocatedTypeElement {
    element: t.TSTypeElement;
    file: string | undefined;
    programNode: t.Program;
}

// The members of an object type: a type literal, or an interface or type
// alias in this or another project file, with the interfaces it extends.
const getObjectTypeMembers = (
    type: t.TSType,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
    depth = 0,
): LocatedTypeElement[] => {
    if (depth > MAX_TYPE_DEPTH) {
        return [];
    }

    if (type.type === "TSTypeLiteral") {
        return type.members.map((element) => ({ element, file, programNode }));
    }

    if (
        type.type !== "TSTypeReference" ||
        type.typeName.type !== "Identifier"
    ) {
        return [];
    }

    const located = resolveTypeDeclaration(
        type.typeName.name,
        programNode,
        file,
        options,
    );

    if (!located) {
        return [];
    }

    const { declaration } = located;

    if (declaration.type === "TSTypeAliasDeclaration") {
        return getObjectTypeMembers(
            declaration.typeAnnotation,
            located.programNode,
            located.file,
            options,
            depth + 1,
        );
    }

    const members = declaration.body.body.map((element) => ({
        element,
        file: located.file,
        programNode: located.programNode,
    }));

    for (const heritage of declaration.extends ?? []) {
        if (heritage.expression.type === "Identifier") {
            members.push(
                ...getObjectTypeMembers(
                    {
                        type: "TSTypeReference",
                        typeName: heritage.expression,
                    },
                    located.programNode,
                    located.file,
                    options,
                    depth + 1,
                ),
            );
        }
    }

    return members;
};

const getTypeElementName = (element: t.TSTypeElement): null | string =>
    (element.type === "TSPropertySignature" ||
        element.type === "TSMethodSignature") &&
    !element.computed
        ? getName(element.key)
        : null;

// The class type of one property of an object type, for a destructured
// parameter: `{ node }: Params` with `interface Params { node: Node }`.
const getObjectTypeMemberClassType = (
    type: t.TSType,
    memberName: string,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): ClassType | null => {
    for (const member of getObjectTypeMembers(
        type,
        programNode,
        file,
        options,
    )) {
        if (
            member.element.type === "TSPropertySignature" &&
            getTypeElementName(member.element) === memberName
        ) {
            return getAnnotationClassType(
                member.element.typeAnnotation,
                member.programNode,
                member.file,
                options,
            );
        }
    }

    return null;
};

// The member names of the interfaces a class implements. A method that
// implements one of them keeps its name: the interface is how it is called.
const getImplementedMemberNames = (
    classNode: t.Class,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): Set<string> => {
    const names = new Set<string>();

    for (const implemented of classNode.implements ?? []) {
        if (
            implemented.type !== "TSClassImplements" ||
            implemented.expression.type !== "Identifier"
        ) {
            continue;
        }

        for (const member of getObjectTypeMembers(
            { type: "TSTypeReference", typeName: implemented.expression },
            programNode,
            file,
            options,
        )) {
            const name = getTypeElementName(member.element);

            if (name != null) {
                names.add(name);
            }
        }
    }

    return names;
};

// The key under which an object pattern binds a name: `{ node: n }` binds
// `n` under `node`.
const getPatternKey = (
    pattern: t.ObjectPattern,
    name: string,
): null | string => {
    for (const property of pattern.properties) {
        if (property.type !== "ObjectProperty" || property.computed) {
            continue;
        }

        const { value } = property;
        const identifier =
            value.type === "AssignmentPattern" ? value.left : value;

        if (identifier.type === "Identifier" && identifier.name === name) {
            return getName(property.key);
        }
    }

    return null;
};

// What a member is: the declared type of a property, a function returning
// the return type for a method, that return type itself for a getter.
const getMemberType = (
    member: MemberNode,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): ClassType | null => {
    if (!isMethodNode(member)) {
        return getAnnotationClassType(
            member.typeAnnotation,
            programNode,
            file,
            options,
        );
    }

    if (member.type === "TSDeclareMethod") {
        const returns =
            member.kind === "method" || member.kind === "get"
                ? getAnnotationClassType(
                      member.returnType,
                      programNode,
                      file,
                      options,
                  )
                : null;

        return returns && member.kind === "method" ? { returns } : returns;
    }

    if (member.kind === "get") {
        return getReturnType(
            getFunctionType(member, programNode, file, options),
        );
    }

    return member.kind === "method"
        ? getFunctionType(member, programNode, file, options)
        : null;
};

// The decisions of one class about the members it declares itself, going by
// their modifiers.
const getOwnMemberDecisions = (
    classNode: t.Class,
    programNode: t.Program,
    file: string | undefined,
    options: BaseClassOptions,
): MemberDecisions => {
    const decisions: MemberDecisions = new Map();
    const publicMembers = renamesPublicMembers(classNode, options);
    const implemented = getImplementedMemberNames(
        classNode,
        programNode,
        file,
        options,
    );

    for (const member of classNode.body.body) {
        if (!isMemberNode(member)) {
            continue;
        }

        const name = getDecisionName(member);

        if (name != null) {
            decisions.set(name, {
                parameterKeys: isMethodNode(member)
                    ? getParameterKeys(member)
                    : null,
                renamed:
                    !implemented.has(name) &&
                    isRenamedMember(
                        name,
                        member.accessibility,
                        publicMembers,
                        options,
                    ),
                type: getMemberType(member, programNode, file, options),
            });
        }

        for (const parameterProperty of getParameterProperties(member)) {
            const identifier = getParameterIdentifier(parameterProperty);
            const parameterName = getName(identifier);

            if (parameterName != null) {
                decisions.set(parameterName, {
                    parameterKeys: null,
                    renamed:
                        !implemented.has(parameterName) &&
                        isRenamedMember(
                            parameterName,
                            parameterProperty.accessibility,
                            publicMembers,
                            options,
                        ),
                    type:
                        identifier.type === "Identifier"
                            ? getAnnotationClassType(
                                  identifier.typeAnnotation,
                                  programNode,
                                  file,
                                  options,
                              )
                            : null,
                });
            }
        }
    }

    return decisions;
};

// The decisions of a class merged with those of its base class. The base
// class decides whether a name is renamed, so that an override ends up under
// the same name; the nearest declaration decides what the parameters look
// like. The constructor is the class's own: it is not an override.
const mergeDecisions = (
    own: MemberDecisions,
    inherited: MemberDecisions,
): MemberDecisions => {
    const decisions: MemberDecisions = new Map();

    for (const name of new Set([...own.keys(), ...inherited.keys()])) {
        const ownDecision = own.get(name);
        const inheritedDecision = inherited.get(name);

        if (name === CONSTRUCTOR) {
            decisions.set(
                name,
                ownDecision ??
                    inheritedDecision ?? {
                        parameterKeys: null,
                        renamed: false,
                        type: null,
                    },
            );
            continue;
        }

        decisions.set(name, {
            parameterKeys:
                ownDecision?.parameterKeys ??
                inheritedDecision?.parameterKeys ??
                null,
            renamed:
                inheritedDecision?.renamed ?? ownDecision?.renamed ?? false,
            type: ownDecision?.type ?? inheritedDecision?.type ?? null,
        });
    }

    return decisions;
};

// The members of one class plus the ones it inherits.
const getClassMemberDecisions = (
    classNode: t.Class,
    programNode: t.Program,
    file: string,
    options: BaseClassOptions,
    seen: Set<string>,
): MemberDecisions =>
    mergeDecisions(
        getOwnMemberDecisions(classNode, programNode, file, options),
        getBaseClassMemberDecisions(
            classNode,
            programNode,
            file,
            options,
            seen,
        ),
    );

const getExportedClassMemberDecisions = (
    file: string,
    exportName: string,
    options: BaseClassOptions,
    seen: Set<string>,
): MemberDecisions => {
    const key = `${file}::${exportName}::${options.cacheKey}`;
    const cached = baseClassMembers.get(key);

    if (cached) {
        return cached;
    }

    if (seen.has(key)) {
        // A cycle in the imports; the names are already being collected.
        return new Map();
    }

    seen.add(key);

    const programNode = parseFile(file);
    const { classNode, redirect } = findExportedClass(programNode, exportName);
    let decisions: MemberDecisions = new Map();

    if (redirect) {
        const source = resolveModule(redirect.source, file, options.aliases);

        if (source) {
            decisions = getExportedClassMemberDecisions(
                source,
                redirect.exportName,
                options,
                seen,
            );
        }
    } else if (classNode) {
        decisions = getClassMemberDecisions(
            classNode,
            programNode,
            file,
            options,
            seen,
        );
    }

    baseClassMembers.set(key, decisions);

    return decisions;
};

// Members that `class X extends Y` inherits from Y, wherever Y lives.
const getBaseClassMemberDecisions = (
    classNode: t.Class,
    programNode: t.Program,
    file: string,
    options: BaseClassOptions,
    seen: Set<string>,
): MemberDecisions => {
    const { superClass } = classNode;

    if (superClass?.type !== "Identifier") {
        return new Map();
    }

    const classSource = findClassSource(programNode, superClass.name);

    if (!classSource) {
        return new Map();
    }

    if ("classNode" in classSource) {
        return getClassMemberDecisions(
            classSource.classNode,
            programNode,
            file,
            options,
            seen,
        );
    }

    const source = resolveModule(classSource.source, file, options.aliases);

    return source
        ? getExportedClassMemberDecisions(
              source,
              classSource.exportName,
              options,
              seen,
          )
        : new Map<string, MemberDecision>();
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

// A file being transformed, as the reference rewriting needs it.
interface FileContext {
    /** In "all" mode: every renamed member of this file, for untyped objects. */
    allDecisions: MemberDecisions | null;
    filename: string | undefined;
    /** The decisions of the classes in this file, merged with their bases. */
    localDecisions: Map<t.Class, MemberDecisions>;
    /** The decisions about the named functions in this file. */
    localFunctions: Map<NamedFunction, FunctionDecision>;
    /** The decisions of the base classes of the classes in this file. */
    localInherited: Map<t.Class, MemberDecisions>;
    programNode: t.Program;
}

// The class whose instance `this` is at this path: the enclosing class,
// unless a non-arrow function in between binds its own `this`.
const getThisClass = (path: NodePath): NodePath<t.Class> | null => {
    const boundary = path.findParent(
        (parent) =>
            parent.isClass() ||
            (parent.isFunction() &&
                !parent.isArrowFunctionExpression() &&
                !parent.isClassMethod()),
    );

    return boundary?.isClass() ? boundary : null;
};

export default function prefixPrivateMembers(
    api: PluginAPI,
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

    const prefixPublicMembers = options.prefixPublicMembers ?? false;
    const prefixParameterKeys = options.prefixParameterKeys ?? false;
    const excludeClasses = new Set(options.excludeClasses ?? []);
    const excludeMembers = new Set(options.excludeMembers ?? []);
    const excludeFunctions = new Set(options.excludeFunctions ?? []);
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
        cacheKey: JSON.stringify([
            [...accessibility].sort(),
            prefixPublicMembers,
            [...excludeClasses].sort(),
            [...excludeMembers].sort(),
            [...excludeFunctions].sort(),
            Object.entries(aliases).sort(),
        ]),
        excludeClasses,
        excludeFunctions,
        excludeMembers,
        prefixPublicMembers,
    };

    // A name that already starts with the prefix is left alone, so that the
    // plugin is idempotent.
    const getNewName = (name: string): null | string =>
        name.startsWith(prefix) ? null : `${prefix}${name}`;

    // The decisions of the base classes: declared elsewhere, but referenced
    // and possibly overridden here.
    const getInheritedDecisions = (
        classPath: NodePath<t.Class>,
        programPath: NodePath<t.Program>,
        filename: string | undefined,
    ): MemberDecisions => {
        if (filename == null) {
            return new Map();
        }

        return getBaseClassMemberDecisions(
            classPath.node,
            programPath.node,
            filename,
            baseClassOptions,
            new Set(),
        );
    };

    // The decisions of the class a reference points at.
    const getClassRefDecisions = (
        ref: ClassRef,
        context: FileContext,
    ): MemberDecisions => {
        if ("exportName" in ref) {
            return getExportedClassMemberDecisions(
                ref.file,
                ref.exportName,
                baseClassOptions,
                new Set(),
            );
        }

        const local = context.localDecisions.get(ref.classNode);

        if (local) {
            return local;
        }

        if (ref.file == null) {
            return new Map();
        }

        return getClassMemberDecisions(
            ref.classNode,
            parseFile(ref.file),
            ref.file,
            baseClassOptions,
            new Set(),
        );
    };

    // Renames the given keys of an object literal or pattern:
    // `{ node, level: 1 }` -> `{ _node: node, _level: 1 }`.
    const renameObjectKeys = (
        object: t.ObjectExpression | t.ObjectPattern,
        keys: string[],
    ): void => {
        for (const property of object.properties) {
            if (
                (property.type !== "ObjectProperty" &&
                    property.type !== "ObjectMethod") ||
                property.computed
            ) {
                continue;
            }

            const name = getName(property.key);
            const newName =
                name != null && keys.includes(name) ? getNewName(name) : null;

            if (newName == null) {
                continue;
            }

            if (property.key.type === "Identifier") {
                // A new node: the key of a shorthand property may be the very
                // same node as its value.
                property.key = api.types.identifier(newName);
            } else {
                setName(property.key, newName);
            }

            if (property.type === "ObjectProperty") {
                property.shorthand = false;
            }
        }
    };

    // Renames the keys of the object literals passed to a method, going by
    // the keys of the object patterns among its parameters.
    // Renames the keys of the object literals passed to a method or function,
    // going by the keys of the object patterns among its parameters. An
    // object that is not a literal cannot follow the parameter, and the call
    // would break: when the callee is known for certain, that is an error to
    // fix in the source or the options.
    const renameArgumentKeys = (
        callArguments: t.Node[],
        decision: FunctionDecision | MemberDecision | null | undefined,
        certain: boolean,
        describe: () => string,
    ): void => {
        if (!prefixParameterKeys || !decision?.renamed) {
            return;
        }

        decision.parameterKeys?.forEach((keys, index) => {
            const argument = callArguments[index];

            if (keys == null || argument == null) {
                return;
            }

            if (isPlainObjectLiteral(argument)) {
                renameObjectKeys(argument as t.ObjectExpression, keys);
            } else if (certain) {
                throw new Error(
                    `prefix-private-members: ${describe()} passes an object that is not a literal to a parameter whose keys are prefixed (${keys.join(", ")}). Pass an object literal, or exclude the class, member or function.`,
                );
            }
        });
    };

    // Renames the keys of the object patterns among the parameters of a
    // method or function.
    const renameParameterKeys = (
        member: t.Function | t.TSDeclareMethod,
    ): void => {
        for (const parameter of member.params) {
            const pattern = getObjectPattern(parameter);

            if (pattern) {
                renameObjectKeys(pattern, getObjectKeys(pattern));
            }
        }
    };

    // Renames the declarations of one class as decided.
    const renameDeclarations = (
        classPath: NodePath<t.Class>,
        decisions: MemberDecisions,
    ): void => {
        for (const memberPath of classPath.get("body").get("body")) {
            const member = memberPath.node;

            if (!isMemberNode(member)) {
                continue;
            }

            const name = getDecisionName(member);

            if (name != null && decisions.get(name)?.renamed) {
                const key = getMemberKey(member);
                const newName = getNewName(name);

                if (key != null && newName != null) {
                    setName(key, newName);
                }

                if (prefixParameterKeys && isMethodNode(member)) {
                    renameParameterKeys(member);
                }
            }

            if (!memberPath.isClassMethod()) {
                continue;
            }

            for (const parameterProperty of getParameterProperties(
                memberPath.node,
            )) {
                const identifier = getParameterIdentifier(parameterProperty);
                const parameterName = getName(identifier);
                const newName =
                    parameterName != null &&
                    decisions.get(parameterName)?.renamed
                        ? getNewName(parameterName)
                        : null;

                if (parameterName != null && newName != null) {
                    renameParameter(
                        memberPath,
                        identifier,
                        parameterName,
                        newName,
                    );
                }
            }
        }
    };

    // Plans the rewriting of the references in a file: `this.x`, `super.x`,
    // and `node.x` for every `node` whose type the plugin can read; the
    // object literals passed to those methods, to `super(...)` and to
    // `new X(...)`. Everything is looked up while the file is still as
    // written, and returned as the changes to make: a name that is renamed
    // on one line is looked up again through a variable on the next.
    const planReferenceRewrites = (
        programPath: NodePath<t.Program>,
        context: FileContext,
    ): (() => void)[] => {
        const rewrites: (() => void)[] = [];
        const { filename, programNode } = context;

        const resolveName = (name: string): ClassRef | null =>
            resolveClassName(name, programNode, filename, baseClassOptions);

        const getAnnotationType = (
            annotation:
                null | t.TSTypeAnnotation | t.TypeAnnotation | undefined,
        ): ClassType | null =>
            getAnnotationClassType(
                annotation,
                programNode,
                filename,
                baseClassOptions,
            );

        // The members of an instance of this type; none for an array.
        const getTypeDecisions = (
            type: ClassType | null,
        ): MemberDecisions | null => {
            const ref = getInstanceRef(type);

            return ref ? getClassRefDecisions(ref, context) : null;
        };

        // The members of the object of `object.x`: `this` and `super` by
        // the enclosing class, anything else by its type. Null when the type
        // is not known.
        const getObjectDecisions = (
            path: NodePath<PropertyAccess>,
            seen: Set<Binding>,
        ): MemberDecisions | null => {
            const object = path.get("object");

            if (object.isSuper()) {
                const classPath = getThisClass(path);

                return classPath
                    ? (context.localInherited.get(classPath.node) ?? null)
                    : null;
            }

            return getTypeDecisions(getExpressionType(object, seen));
        };

        const getMemberDecision = (
            path: NodePath<PropertyAccess>,
            seen: Set<Binding>,
        ): MemberDecision | undefined => {
            const name = getPropertyName(path.node);

            return name == null
                ? undefined
                : getObjectDecisions(path, seen)?.get(name);
        };

        // The type of what a parameter binds: `node: Node`, `node: Node = x`,
        // `{ node }: Params`, or a parameter property.
        const getParameterType = (
            parameterPath: NodePath,
            name: string,
        ): ClassType | null => {
            let parameter = parameterPath.node;

            if (parameter.type === "TSParameterProperty") {
                parameter = parameter.parameter;
            }

            if (parameter.type === "AssignmentPattern") {
                parameter = parameter.left;
            }

            if (parameter.type === "Identifier") {
                return getAnnotationType(parameter.typeAnnotation);
            }

            if (
                parameter.type !== "ObjectPattern" ||
                parameter.typeAnnotation?.type !== "TSTypeAnnotation"
            ) {
                return null;
            }

            const key = getPatternKey(parameter, name);

            return key == null
                ? null
                : getObjectTypeMemberClassType(
                      parameter.typeAnnotation.typeAnnotation,
                      key,
                      programNode,
                      filename,
                      baseClassOptions,
                  );
        };

        // The type of a variable: its annotation, the element type of the
        // `for...of` it iterates, or the type of its initializer, also
        // through a destructuring.
        const getVariableType = (
            declaratorPath: NodePath<t.VariableDeclarator>,
            name: string,
            seen: Set<Binding>,
        ): ClassType | null => {
            const { id } = declaratorPath.node;

            if (id.type === "Identifier") {
                const annotated = getAnnotationType(id.typeAnnotation);

                if (annotated) {
                    return annotated;
                }
            }

            const declaration = declaratorPath.parentPath;
            const statement = declaration.parentPath;
            const init = declaratorPath.get("init");
            let initType: ClassType | null;

            if (
                statement.isForOfStatement() &&
                statement.node.left === declaration.node
            ) {
                initType = getElementType(
                    getExpressionType(statement.get("right"), seen),
                );
            } else {
                initType = init.node ? getExpressionType(init, seen) : null;
            }

            if (id.type === "Identifier") {
                return initType;
            }

            if (id.type !== "ObjectPattern") {
                return null;
            }

            const key = getPatternKey(id, name);

            return key == null
                ? null
                : (getTypeDecisions(initType)?.get(key)?.type ?? null);
        };

        // The type of a name: a class or import used as a value (for static
        // members), a parameter, or a variable.
        const getBindingType = (
            path: NodePath<t.Identifier>,
            seen: Set<Binding>,
        ): ClassType | null => {
            const { name } = path.node;
            const binding = path.scope.getBinding(name);

            if (!binding || seen.has(binding)) {
                return null;
            }

            seen.add(binding);

            const bindingPath = binding.path;

            if (bindingPath.isClassDeclaration() || binding.kind === "module") {
                const ref = resolveName(name);

                return ref ? { array: false, ref } : null;
            }

            if (bindingPath.isFunctionDeclaration()) {
                return getFunctionType(
                    bindingPath.node,
                    programNode,
                    filename,
                    baseClassOptions,
                );
            }

            if (binding.kind === "param") {
                return getParameterType(bindingPath, name);
            }

            if (bindingPath.isVariableDeclarator()) {
                return getVariableType(bindingPath, name, seen);
            }

            return null;
        };

        // The class type of an expression, as far as the plugin can read it.
        const getExpressionType = (
            path: NodePath,
            seen: Set<Binding>,
        ): ClassType | null => {
            const { node } = path;

            switch (node.type) {
                case "ArrowFunctionExpression":
                case "FunctionExpression":
                    return getFunctionType(
                        node,
                        programNode,
                        filename,
                        baseClassOptions,
                    );

                case "CallExpression":
                case "OptionalCallExpression": {
                    const callee = (
                        path as NodePath<
                            t.CallExpression | t.OptionalCallExpression
                        >
                    ).get("callee");

                    return getReturnType(getExpressionType(callee, seen));
                }

                case "Identifier":
                    return getBindingType(path as NodePath<t.Identifier>, seen);

                case "MemberExpression":
                case "OptionalMemberExpression": {
                    const memberPath = path as NodePath<PropertyAccess>;

                    if (node.computed) {
                        return getElementType(
                            getExpressionType(memberPath.get("object"), seen),
                        );
                    }

                    return getMemberDecision(memberPath, seen)?.type ?? null;
                }

                case "NewExpression": {
                    if (node.callee.type !== "Identifier") {
                        return null;
                    }

                    const ref = resolveName(node.callee.name);

                    return ref ? { array: false, ref } : null;
                }

                case "ThisExpression": {
                    const classPath = getThisClass(path);

                    return classPath
                        ? {
                              array: false,
                              ref: {
                                  classNode: classPath.node,
                                  file: filename,
                              },
                          }
                        : null;
                }

                case "TSAsExpression":
                case "TSSatisfiesExpression":
                    return getClassType(
                        node.typeAnnotation,
                        programNode,
                        filename,
                        baseClassOptions,
                    );

                case "TSNonNullExpression":
                    return getExpressionType(
                        (path as NodePath<t.TSNonNullExpression>).get(
                            "expression",
                        ),
                        seen,
                    );

                default:
                    return null;
            }
        };

        // The decision about the function a call by name reaches: declared in
        // this file, or imported from another project file.
        const getFunctionCallDecision = (
            callee: NodePath<t.Identifier>,
        ): FunctionDecision | null => {
            const { name } = callee.node;
            const binding = callee.scope.getBinding(name);

            if (!binding) {
                return null;
            }

            const declared = getDeclaredFunction(binding.path.node);

            if (declared) {
                return context.localFunctions.get(declared.fn) ?? null;
            }

            if (binding.kind !== "module" || filename == null) {
                return null;
            }

            const classSource = findClassSource(programNode, name);

            if (!classSource || "classNode" in classSource) {
                return null;
            }

            const source = resolveModule(
                classSource.source,
                filename,
                baseClassOptions.aliases,
            );

            return source
                ? getExportedFunctionDecision(
                      source,
                      classSource.exportName,
                      baseClassOptions,
                      new Set(),
                  )
                : null;
        };

        // The decision about `object.x`: by the object's type when known,
        // else, in "all" mode, by the name alone.
        const getReferenceDecision = (
            path: NodePath<PropertyAccess>,
        ): { byType: boolean; decision: MemberDecision | undefined } => {
            const name = getPropertyName(path.node);

            if (name == null) {
                return { byType: false, decision: undefined };
            }

            const decisions = getObjectDecisions(path, new Set());

            return decisions
                ? { byType: true, decision: decisions.get(name) }
                : { byType: false, decision: context.allDecisions?.get(name) };
        };

        // Where a call is, for an error message.
        const describeCall = (node: t.Node, callee: string): string =>
            `${callee} at ${filename ?? "<unknown>"}:${node.loc?.start.line ?? "?"}`;

        const rewriteMember = (path: NodePath<PropertyAccess>) => {
            const { decision } = getReferenceDecision(path);
            const name = getPropertyName(path.node);
            const newName =
                decision?.renamed && name != null ? getNewName(name) : null;
            const { property } = path.node;

            if (newName != null) {
                rewrites.push(() => {
                    setName(property, newName);
                });
            }
        };

        const rewriteCall = (
            path: NodePath<t.CallExpression | t.OptionalCallExpression>,
        ) => {
            const callee = path.get("callee");
            let decision: FunctionDecision | MemberDecision | null | undefined;
            let certain = true;
            let calleeName = "a call";

            if (callee.isSuper()) {
                const classPath = getThisClass(path);

                decision = classPath
                    ? context.localInherited
                          .get(classPath.node)
                          ?.get(CONSTRUCTOR)
                    : undefined;
                calleeName = "super(...)";
            } else if (
                callee.isMemberExpression() ||
                callee.isOptionalMemberExpression()
            ) {
                const reference = getReferenceDecision(callee);

                decision = reference.decision;
                certain = reference.byType;
                calleeName = `.${getPropertyName(callee.node) ?? "?"}(...)`;
            } else if (callee.isIdentifier()) {
                decision = getFunctionCallDecision(callee);
                calleeName = `${callee.node.name}(...)`;
            }

            const callNode = path.node;

            rewrites.push(() => {
                renameArgumentKeys(callNode.arguments, decision, certain, () =>
                    describeCall(callNode, calleeName),
                );
            });
        };

        const rewriteNew = (path: NodePath<t.NewExpression>) => {
            const { callee } = path.node;

            if (callee.type !== "Identifier") {
                return;
            }

            const ref = resolveName(callee.name);
            const callNode = path.node;

            if (ref) {
                const decision = getClassRefDecisions(ref, context).get(
                    CONSTRUCTOR,
                );

                rewrites.push(() => {
                    renameArgumentKeys(callNode.arguments, decision, true, () =>
                        describeCall(callNode, `new ${callee.name}(...)`),
                    );
                });
            }
        };

        programPath.traverse({
            CallExpression: rewriteCall,
            MemberExpression: rewriteMember,
            NewExpression: rewriteNew,
            OptionalCallExpression: rewriteCall,
            OptionalMemberExpression: rewriteMember,
        });

        return rewrites;
    };

    return {
        name: "prefix-private-members",
        visitor: {
            Program(programPath, state) {
                const { filename } = state;
                const programNode = programPath.node;
                const rewriteAll =
                    memberAccess === "all" || hasAllDirective(state.file);
                const classPaths: NodePath<t.Class>[] = [];

                programPath.traverse({
                    Class(classPath) {
                        classPaths.push(classPath);
                    },
                });

                // Everything is decided first, on the file as written: a
                // class in this same file is renamed below too, and its
                // members would otherwise already be prefixed by the time
                // they are looked up.
                const localDecisions = new Map<t.Class, MemberDecisions>();
                const localInherited = new Map<t.Class, MemberDecisions>();
                const allDecisions: MemberDecisions = new Map();

                for (const classPath of classPaths) {
                    const inherited = getInheritedDecisions(
                        classPath,
                        programPath,
                        filename,
                    );
                    const decisions = mergeDecisions(
                        getOwnMemberDecisions(
                            classPath.node,
                            programNode,
                            filename,
                            baseClassOptions,
                        ),
                        inherited,
                    );

                    localInherited.set(classPath.node, inherited);
                    localDecisions.set(classPath.node, decisions);

                    for (const [name, decision] of decisions) {
                        if (decision.renamed) {
                            allDecisions.set(name, decision);
                        }
                    }
                }

                // The named functions of the file, for the keys of their
                // object parameters.
                const localFunctions = new Map<
                    NamedFunction,
                    FunctionDecision
                >();

                if (prefixParameterKeys) {
                    programPath.traverse({
                        "FunctionDeclaration|VariableDeclarator"(path) {
                            const declared = getDeclaredFunction(path.node);

                            if (declared) {
                                localFunctions.set(
                                    declared.fn,
                                    getFunctionDecision(
                                        declared.fn,
                                        declared.name,
                                        programNode,
                                        baseClassOptions,
                                    ),
                                );
                            }
                        },
                    });
                }

                const rewrites = planReferenceRewrites(programPath, {
                    allDecisions: rewriteAll ? allDecisions : null,
                    filename,
                    localDecisions,
                    localFunctions,
                    localInherited,
                    programNode,
                });

                for (const classPath of classPaths) {
                    const decisions = localDecisions.get(classPath.node);

                    if (decisions) {
                        renameDeclarations(classPath, decisions);
                    }
                }

                for (const [fn, decision] of localFunctions) {
                    if (decision.renamed) {
                        renameParameterKeys(fn);
                    }
                }

                for (const rewrite of rewrites) {
                    rewrite();
                }
            },
        },
    };
}
