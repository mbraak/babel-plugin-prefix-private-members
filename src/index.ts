/*
Babel plugin that prefixes TypeScript `private` and `protected` class members
with `_`, and rewrites the references to them.

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
    root            string, default process.cwd(): where the tsconfig search
                    starts, and what `aliases` are relative to.
    tsconfig        string or false: the tsconfig.json to take the compiler
                    options from, relative to `root`. By default the nearest
                    tsconfig.json from `root` upward; `false` for built-in
                    defaults (strict, ESNext, bundler module resolution).
    aliases         object, default {}: import prefix -> directory, for the
                    non-relative imports that are project files
                    ({ "app/": "./src/" }). Added to the `paths` of the
                    compiler options; a tsconfig that already maps them
                    needs nothing here.
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
                    the keys of the object literals passed to them, wherever
                    the call resolves to such a method or constructor. The
                    constructor follows the public members: its keys are
                    renamed when the class is not excluded and
                    `prefixPublicMembers` is on, or when the constructor is
                    private or protected.
                    Functions get the same treatment: a function declaration
                    or a variable holding an arrow or function expression,
                    called directly by name in its file or through an import,
                    except the names in `excludeFunctions`. A function that
                    is also used as a value (passed as a callback, stored)
                    keeps its keys: its objects then come from elsewhere.

How references are found

The plugin runs the TypeScript type checker over the file and the files it
imports, and asks it what every `object.x` refers to. A reference is renamed
when it resolves to a member of a project class, whatever the path there:
`this`, `super`, a typed variable or parameter, a union, a generic, the result
of a call, the element of an array, a callback parameter, a cast. A reference
whose type the checker does not know (`any`, an unresolved import) is left
alone, as is a member that also exists on an interface or a class from a
package.

A subclass follows the decisions of its base classes: the topmost project
class that declares a name decides whether it is renamed, so that an override
ends up under the same name as the method it overrides, and a public member
that an excluded base class keeps stays in the subclass as well. A member that
a base class from outside the project already has (`HTMLElement.focus`) is
never renamed.

The compiler options come from the project's tsconfig.json, so module
resolution, `paths` and `lib` are the project's own. One TypeScript program
per project is kept for the lifetime of the process and updated as files come
in, so a watch mode pays for the type checker once.
*/

import type {
    NodePath,
    PluginAPI,
    PluginObject,
    types as t,
} from "@babel/core";

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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
    /**
     * The tsconfig.json to read the compiler options from, relative to
     * `root`. Default: the nearest tsconfig.json from `root` upward. `false`
     * uses built-in defaults instead.
     */
    tsconfig?: false | string;
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

const CONSTRUCTOR = "constructor";

// ---------------------------------------------------------------------------
// The TypeScript program of a project
//
// One language service per project, shared by every file Babel hands in. The
// files being transformed are served from memory, as Babel sees them; the
// files they import are read from disk, versioned by mtime so that a watch
// mode picks up their changes.

interface Project {
    service: ts.LanguageService;
    /** The files handed to the plugin, as Babel gave them. */
    sources: Map<string, { text: string; version: number }>;
}

const projects = new Map<string, Project>();

// Shared by all projects, so that the lib files are parsed once.
const documentRegistry = ts.createDocumentRegistry();

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
};

const findTsconfig = (
    root: string,
    tsconfig: false | string | undefined,
): string | undefined => {
    if (tsconfig === false) {
        return undefined;
    }

    if (tsconfig != null) {
        return path.resolve(root, tsconfig);
    }

    return ts.findConfigFile(root, (file) => ts.sys.fileExists(file));
};

const readCompilerOptions = (
    tsconfigPath: string | undefined,
): ts.CompilerOptions => {
    if (tsconfigPath == null) {
        return { ...DEFAULT_COMPILER_OPTIONS };
    }

    const result = ts.readConfigFile(tsconfigPath, (file) =>
        ts.sys.readFile(file),
    );

    if (result.error) {
        throw new Error(
            `prefix-private-members: cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(result.error.messageText, "\n")}`,
        );
    }

    const parsed = ts.parseJsonConfigFileContent(
        result.config,
        ts.sys,
        path.dirname(tsconfigPath),
    );

    return parsed.options;
};

const createCompilerOptions = (
    root: string,
    tsconfigPath: string | undefined,
    aliases: Record<string, string>,
): ts.CompilerOptions => {
    const options: ts.CompilerOptions = {
        ...readCompilerOptions(tsconfigPath),
        // The plugin only reads types; a .js file handed in must be in the
        // program too.
        allowJs: true,
        // Babel parses every file as a module. A file without imports or
        // exports is a script to TypeScript, whose `class Node` would then
        // clash with the DOM global of that name.
        moduleDetection: ts.ModuleDetectionKind.Force,
        noEmit: true,
    };
    const aliasEntries = Object.entries(aliases);

    if (aliasEntries.length > 0) {
        const paths = { ...options.paths };

        for (const [alias, target] of aliasEntries) {
            paths[`${alias}*`] = [path.join(path.resolve(root, target), "*")];
        }

        options.paths = paths;
        // What relative `paths` are resolved against; ours are absolute, but
        // the option is required whenever `paths` is set.
        options.pathsBasePath = root;
    }

    return options;
};

const createProject = (
    root: string,
    compilerOptions: ts.CompilerOptions,
): Project => {
    const sources = new Map<string, { text: string; version: number }>();

    const host: ts.LanguageServiceHost = {
        directoryExists: (directory) => ts.sys.directoryExists(directory),
        fileExists: (file) => ts.sys.fileExists(file),
        getCompilationSettings: () => compilerOptions,
        getCurrentDirectory: () => root,
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        getDirectories: (directory) => ts.sys.getDirectories(directory),
        getScriptFileNames: () => [...sources.keys()],
        getScriptSnapshot: (file) => {
            const source = sources.get(file);

            if (source) {
                return ts.ScriptSnapshot.fromString(source.text);
            }

            const text = ts.sys.readFile(file);

            return text == null
                ? undefined
                : ts.ScriptSnapshot.fromString(text);
        },
        getScriptVersion: (file) => {
            const source = sources.get(file);

            if (source) {
                return String(source.version);
            }

            try {
                return String(fs.statSync(file).mtimeMs);
            } catch {
                return "0";
            }
        },
        readDirectory: (directory, extensions, exclude, include, depth) =>
            ts.sys.readDirectory(
                directory,
                extensions,
                exclude,
                include,
                depth,
            ),
        readFile: (file, encoding) => ts.sys.readFile(file, encoding),
        realpath: (file) => ts.sys.realpath?.(file) ?? file,
    };

    return {
        service: ts.createLanguageService(host, documentRegistry),
        sources,
    };
};

const getProject = (
    root: string,
    tsconfig: false | string | undefined,
    aliases: Record<string, string>,
): Project => {
    const tsconfigPath = findTsconfig(root, tsconfig);
    const key = JSON.stringify([root, tsconfigPath, Object.entries(aliases)]);
    let project = projects.get(key);

    if (!project) {
        project = createProject(
            root,
            createCompilerOptions(root, tsconfigPath, aliases),
        );
        projects.set(key, project);
    }

    return project;
};

// ---------------------------------------------------------------------------
// TypeScript AST helpers

type ClassMemberDeclaration =
    | ts.GetAccessorDeclaration
    | ts.MethodDeclaration
    | ts.PropertyDeclaration
    | ts.SetAccessorDeclaration;

type FunctionLike =
    ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

const isClassMemberDeclaration = (
    node: ts.Node,
): node is ClassMemberDeclaration =>
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);

const isFunctionLike = (node: ts.Node): node is FunctionLike =>
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node);

const isCallLike = (
    node: ts.Node,
): node is ts.CallExpression | ts.NewExpression =>
    ts.isCallExpression(node) || ts.isNewExpression(node);

// The name of a declaration, when it is a plain identifier or string.
const getTsName = (node: ts.Node): null | string => {
    const name = ts.getNameOfDeclaration(node as ts.Declaration);

    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        return name.text;
    }

    return null;
};

const getAccessibility = (node: ts.Declaration): null | string => {
    const flags = ts.getCombinedModifierFlags(node);

    if (flags & ts.ModifierFlags.Private) {
        return "private";
    }

    if (flags & ts.ModifierFlags.Protected) {
        return "protected";
    }

    if (flags & ts.ModifierFlags.Public) {
        return "public";
    }

    return null;
};

const isTsStatic = (node: ts.Declaration): boolean =>
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0;

const isExported = (node: ts.Declaration): boolean =>
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;

// `constructor(private element: HTMLElement)`: a parameter that declares a
// member.
const isTsParameterProperty = (
    node: ts.ParameterDeclaration,
): node is ts.ParameterDeclaration & { name: ts.Identifier } =>
    ts.isIdentifier(node.name) &&
    (ts.getCombinedModifierFlags(node) &
        (ts.ModifierFlags.AccessibilityModifier |
            ts.ModifierFlags.Override |
            ts.ModifierFlags.Readonly)) !==
        0;

const getHeritageTypes = (
    classNode: ts.ClassLikeDeclaration,
    token: ts.SyntaxKind.ExtendsKeyword | ts.SyntaxKind.ImplementsKeyword,
): readonly ts.ExpressionWithTypeArguments[] =>
    classNode.heritageClauses?.find((clause) => clause.token === token)
        ?.types ?? [];

// The keys of an object binding pattern that can be renamed: not computed,
// not a rest element.
const getTsPatternKeys = (pattern: ts.ObjectBindingPattern): string[] =>
    pattern.elements.flatMap((element) => {
        if (element.dotDotDotToken) {
            return [];
        }

        const key = element.propertyName ?? element.name;

        return ts.isIdentifier(key) || ts.isStringLiteral(key)
            ? [key.text]
            : [];
    });

// Per parameter of a function-like declaration, the keys of its object
// pattern; null when there is no object pattern among the parameters.
const getTsParameterKeys = (
    declaration: ts.SignatureDeclaration,
): (null | string[])[] | null => {
    const keys = declaration.parameters.map((parameter) =>
        ts.isObjectBindingPattern(parameter.name)
            ? getTsPatternKeys(parameter.name)
            : null,
    );

    return keys.some((parameterKeys) => parameterKeys != null) ? keys : null;
};

// A function with a name to call it by: a declaration, or the initializer of
// a variable.
const getFunctionName = (fn: FunctionLike): null | string => {
    if (ts.isFunctionDeclaration(fn)) {
        return fn.name?.text ?? null;
    }

    const { parent } = fn;

    return ts.isVariableDeclaration(parent) &&
        parent.initializer === fn &&
        ts.isIdentifier(parent.name)
        ? parent.name.text
        : null;
};

// Whether the declaration of a function has an `export` modifier.
const isExportedFunction = (fn: FunctionLike): boolean => {
    if (ts.isFunctionDeclaration(fn)) {
        return isExported(fn);
    }

    const statement = fn.parent.parent.parent;

    return (
        ts.isVariableStatement(statement) &&
        (ts
            .getModifiers(statement)
            ?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) ??
            false)
    );
};

const isPlainTsObjectLiteral = (node: ts.Node | undefined): boolean =>
    node != null &&
    ts.isObjectLiteralExpression(node) &&
    node.properties.every((property) => !ts.isSpreadAssignment(property));

// Whether an interface or type alias is declared in this file without being
// exported: a type that only this file can name.
const isPrivateType = (sourceFile: ts.SourceFile, name: string): boolean =>
    sourceFile.statements.some(
        (statement) =>
            (ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement)) &&
            statement.name.text === name &&
            !isExported(statement),
    );

// Whether the object parameters of a function are typed with types private
// to its file. For a function that other files can call, that is the sign
// that the objects are written at the calls: an object of an exported type
// may come from anywhere, like the options a library user passes in.
const hasPrivateParameterTypes = (
    fn: FunctionLike,
    sourceFile: ts.SourceFile,
): boolean =>
    fn.parameters.every((parameter) => {
        if (!ts.isObjectBindingPattern(parameter.name)) {
            return true;
        }

        const { type } = parameter;

        if (type == null) {
            return false;
        }

        return (
            ts.isTypeLiteralNode(type) ||
            (ts.isTypeReferenceNode(type) &&
                ts.isIdentifier(type.typeName) &&
                isPrivateType(sourceFile, type.typeName.text))
        );
    });

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
    fn: FunctionLike,
    name: string,
    sourceFile: ts.SourceFile,
): FunctionUse => {
    const patternIndexes = fn.parameters.flatMap((parameter, index) =>
        ts.isObjectBindingPattern(parameter.name) ? [index] : [],
    );
    const use: FunctionUse = { exported: isExportedFunction(fn), safe: true };

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === name) {
            const { parent } = node;
            const call =
                ts.isCallExpression(parent) && parent.expression === node
                    ? parent
                    : null;
            const isDeclaration =
                (ts.isFunctionDeclaration(parent) && parent.name === node) ||
                (ts.isVariableDeclaration(parent) && parent.name === node) ||
                ts.isImportSpecifier(parent) ||
                ts.isImportClause(parent);
            const isExportUse =
                ts.isExportSpecifier(parent) || ts.isExportAssignment(parent);
            const isPropertyName =
                (ts.isPropertyAccessExpression(parent) &&
                    parent.name === node) ||
                ((ts.isPropertyAssignment(parent) ||
                    ts.isMethodDeclaration(parent) ||
                    ts.isPropertyDeclaration(parent) ||
                    ts.isPropertySignature(parent) ||
                    ts.isMethodSignature(parent)) &&
                    parent.name === node);
            const isType =
                ts.isTypeReferenceNode(parent) ||
                ts.isTypeQueryNode(parent) ||
                ts.isInterfaceDeclaration(parent) ||
                ts.isTypeAliasDeclaration(parent);

            if (isExportUse) {
                use.exported = true;
            } else if (call) {
                for (const index of patternIndexes) {
                    const argument = call.arguments[index];

                    if (argument && !isPlainTsObjectLiteral(argument)) {
                        use.safe = false;
                    }
                }
            } else if (!isDeclaration && !isPropertyName && !isType) {
                use.safe = false;
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return use;
};

// ---------------------------------------------------------------------------
// Babel AST helpers

type ClassBodyMember = t.ClassBody["body"][number];

type MemberNode =
    | t.ClassAccessorProperty
    | t.ClassMethod
    | t.ClassProperty
    | t.TSDeclareMethod;

type PropertyAccess = t.MemberExpression | t.OptionalMemberExpression;

type NamedFunction =
    t.ArrowFunctionExpression | t.FunctionDeclaration | t.FunctionExpression;

// Everything a class body can hold, of which only the four member types below
// are ours to rename; a static block or an index signature has no name.
const isMemberNode = (member: ClassBodyMember): member is MemberNode =>
    member.type === "ClassMethod" ||
    member.type === "ClassProperty" ||
    member.type === "ClassAccessorProperty" ||
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

const getMemberKey = (member: ClassBodyMember): null | t.Node => {
    if (!isMemberNode(member) || member.computed) {
        return null;
    }

    return member.key;
};

const isMethodNode = (
    member: MemberNode,
): member is t.ClassMethod | t.TSDeclareMethod =>
    member.type === "ClassMethod" || member.type === "TSDeclareMethod";

const isConstructor = (member: ClassBodyMember): boolean =>
    isMemberNode(member) &&
    isMethodNode(member) &&
    member.kind === "constructor";

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

// A function declaration, or a variable holding an arrow or function
// expression: a function that is called by name.
const getDeclaredFunction = (node: t.Node): NamedFunction | null => {
    if (node.type === "FunctionDeclaration") {
        return node;
    }

    if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        (node.init?.type === "ArrowFunctionExpression" ||
            node.init?.type === "FunctionExpression")
    ) {
        return node.init;
    }

    return null;
};

// A literal whose keys can all be renamed: no spread, whose keys are unknown.
const isPlainObjectLiteral = (node: t.Node | undefined): boolean =>
    node?.type === "ObjectExpression" &&
    node.properties.every((property) => property.type !== "SpreadElement");

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

// ---------------------------------------------------------------------------
// Matching the Babel AST to the TypeScript AST
//
// Both parsers give every node its offsets in the source text. A name is
// looked up by its start, and any other node by its end: the start of a
// declaration depends on where each parser puts its modifiers, and Babel's
// identifiers stretch over their type annotation, so neither alone matches.

interface NodeIndex {
    byEnd: Map<number, ts.Node[]>;
    byStart: Map<number, ts.Node[]>;
}

const indexNodes = (sourceFile: ts.SourceFile): NodeIndex => {
    const index: NodeIndex = { byEnd: new Map(), byStart: new Map() };

    const add = (map: Map<number, ts.Node[]>, key: number, node: ts.Node) => {
        const nodes = map.get(key);

        if (nodes) {
            nodes.push(node);
        } else {
            map.set(key, [node]);
        }
    };

    const visit = (node: ts.Node): void => {
        add(index.byEnd, node.end, node);

        if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
            add(index.byStart, node.getStart(sourceFile), node);
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return index;
};

// ---------------------------------------------------------------------------
// The plugin

export default function prefixPrivateMembers(
    api: PluginAPI,
    options: Options = {},
): PluginObject {
    const prefix = options.prefix ?? "_";
    const accessibility = new Set(
        options.accessibility ?? ["private", "protected"],
    );
    const prefixPublicMembers = options.prefixPublicMembers ?? false;
    const prefixParameterKeys = options.prefixParameterKeys ?? false;
    const excludeClasses = new Set(options.excludeClasses ?? []);
    const excludeMembers = new Set(options.excludeMembers ?? []);
    const excludeFunctions = new Set(options.excludeFunctions ?? []);
    const root = path.resolve(options.root ?? process.cwd());
    const aliases = options.aliases ?? {};

    // A name that already starts with the prefix is left alone, so that the
    // plugin is idempotent.
    const getNewName = (name: string): null | string =>
        name.startsWith(prefix) ? null : `${prefix}${name}`;

    // Whether a class renames its public members: only when asked to, and
    // not for the excluded classes. An anonymous class cannot be excluded.
    const renamesPublicMembers = (
        classNode: ts.ClassLikeDeclaration,
    ): boolean =>
        prefixPublicMembers &&
        (classNode.name == null || !excludeClasses.has(classNode.name.text));

    // Whether a member with this name and modifier is one to rename, going
    // by those alone. For the constructor this decides about the keys of its
    // object parameters; its name always stays.
    const isRenamedMember = (
        name: string,
        memberAccessibility: null | string,
        publicMembers: boolean,
    ): boolean => {
        if (PROTOCOL_MEMBERS.has(name) || excludeMembers.has(name)) {
            return false;
        }

        if (
            memberAccessibility != null &&
            accessibility.has(memberAccessibility)
        ) {
            return true;
        }

        const isPublic =
            memberAccessibility == null || memberAccessibility === "public";

        return isPublic && publicMembers;
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

    return {
        name: "prefix-private-members",
        visitor: {
            Program(programPath, state) {
                const filename =
                    state.filename ??
                    path.join(root, "prefix-private-members.ts");
                const project = getProject(root, options.tsconfig, aliases);
                const source = project.sources.get(filename);
                const { code } = state.file;

                if (source?.text !== code) {
                    project.sources.set(filename, {
                        text: code,
                        version: (source?.version ?? 0) + 1,
                    });
                }

                const program = project.service.getProgram();
                const sourceFile = program?.getSourceFile(filename);

                if (!program || !sourceFile) {
                    throw new Error(
                        `prefix-private-members: TypeScript did not load ${filename}`,
                    );
                }

                const checker = program.getTypeChecker();
                const index = indexNodes(sourceFile);

                // The TypeScript node that a Babel node was parsed from.
                const findTsNode = <T extends ts.Node>(
                    node: t.Node,
                    test: (candidate: ts.Node) => candidate is T,
                ): T | undefined =>
                    node.end == null
                        ? undefined
                        : index.byEnd.get(node.end)?.find(test);

                const findTsName = (
                    node: t.Node,
                ): ts.Identifier | ts.StringLiteral | undefined =>
                    node.start == null
                        ? undefined
                        : index.byStart
                              .get(node.start)
                              ?.find(
                                  (
                                      candidate,
                                  ): candidate is
                                      ts.Identifier | ts.StringLiteral =>
                                      ts.isIdentifier(candidate) ||
                                      ts.isStringLiteral(candidate),
                              );

                const describeNode = (node: ts.Node): string => {
                    const file = node.getSourceFile();
                    const { line } = file.getLineAndCharacterOfPosition(
                        node.getStart(file),
                    );

                    return `${file.fileName}:${line + 1}`;
                };

                // -------------------------------------------------------
                // Deciding about class members

                const isProjectFile = (file: ts.SourceFile): boolean =>
                    !program.isSourceFileFromExternalLibrary(file) &&
                    !program.isSourceFileDefaultLibrary(file) &&
                    !file.fileName.includes("/node_modules/");

                // The class that a class extends: a class declared in a
                // project file, or something else (a class from a package,
                // a mixin call), whose members the checker still knows.
                const getBaseClass = (
                    classNode: ts.ClassLikeDeclaration,
                ):
                    | { classNode: ts.ClassLikeDeclaration }
                    | { external: true }
                    | null => {
                    const [extended] = getHeritageTypes(
                        classNode,
                        ts.SyntaxKind.ExtendsKeyword,
                    );

                    if (!extended) {
                        return null;
                    }

                    let symbol = checker.getSymbolAtLocation(
                        extended.expression,
                    );

                    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
                        symbol = checker.getAliasedSymbol(symbol);
                    }

                    const declaration =
                        symbol?.valueDeclaration ?? symbol?.declarations?.[0];

                    if (
                        declaration &&
                        ts.isClassLike(declaration) &&
                        isProjectFile(declaration.getSourceFile())
                    ) {
                        return { classNode: declaration };
                    }

                    return { external: true };
                };

                // The instance type of a class, for its base types.
                const getInstanceType = (
                    classNode: ts.ClassLikeDeclaration,
                ): ts.InterfaceType | null => {
                    const type = checker.getTypeAtLocation(classNode);

                    if (type.isClassOrInterface()) {
                        return type;
                    }

                    const [signature] = type.getConstructSignatures();
                    const instance = signature?.getReturnType();

                    return instance?.isClassOrInterface() ? instance : null;
                };

                // Whether a base class outside the project has this member.
                const externalBaseHasMember = (
                    classNode: ts.ClassLikeDeclaration,
                    name: string,
                    isStatic: boolean,
                ): boolean => {
                    if (isStatic) {
                        const [extended] = getHeritageTypes(
                            classNode,
                            ts.SyntaxKind.ExtendsKeyword,
                        );

                        return (
                            extended != null &&
                            checker
                                .getTypeAtLocation(extended.expression)
                                .getProperty(name) != null
                        );
                    }

                    const instanceType = getInstanceType(classNode);

                    return (
                        instanceType != null &&
                        checker
                            .getBaseTypes(instanceType)
                            .some((base) => base.getProperty(name) != null)
                    );
                };

                // The class's own declaration of a name: a member, or a
                // parameter property of the constructor.
                const findOwnMember = (
                    classNode: ts.ClassLikeDeclaration,
                    name: string,
                    isStatic: boolean,
                ): ts.Declaration | null => {
                    for (const member of classNode.members) {
                        if (
                            isClassMemberDeclaration(member) &&
                            getTsName(member) === name &&
                            isTsStatic(member) === isStatic
                        ) {
                            return member;
                        }

                        if (ts.isConstructorDeclaration(member) && !isStatic) {
                            for (const parameter of member.parameters) {
                                if (
                                    isTsParameterProperty(parameter) &&
                                    parameter.name.text === name
                                ) {
                                    return parameter;
                                }
                            }
                        }
                    }

                    return null;
                };

                const implementedNames = new Map<
                    ts.ClassLikeDeclaration,
                    Set<string>
                >();

                // The members of the interfaces in the class's `implements`
                // clause: an object typed with the interface is how they are
                // called, so they keep their names.
                const getImplementedNames = (
                    classNode: ts.ClassLikeDeclaration,
                ): Set<string> => {
                    let names = implementedNames.get(classNode);

                    if (!names) {
                        names = new Set();

                        for (const implemented of getHeritageTypes(
                            classNode,
                            ts.SyntaxKind.ImplementsKeyword,
                        )) {
                            for (const property of checker
                                .getTypeAtLocation(implemented)
                                .getProperties()) {
                                names.add(property.name);
                            }
                        }

                        implementedNames.set(classNode, names);
                    }

                    return names;
                };

                const memberDecisions = new Map<
                    ts.ClassLikeDeclaration,
                    Map<string, boolean | null>
                >();

                // Whether a member of a class is renamed. The topmost project
                // class that declares the name decides, so that an override
                // ends up under the same name as what it overrides. Null when
                // no class in the chain declares it.
                const decideMember = (
                    classNode: ts.ClassLikeDeclaration,
                    name: string,
                    isStatic: boolean,
                    seen = new Set<ts.ClassLikeDeclaration>(),
                ): boolean | null => {
                    const cacheKey = `${isStatic ? "static " : ""}${name}`;
                    let decisions = memberDecisions.get(classNode);

                    if (!decisions) {
                        decisions = new Map();
                        memberDecisions.set(classNode, decisions);
                    }

                    const cached = decisions.get(cacheKey);

                    if (cached !== undefined) {
                        return cached;
                    }

                    seen.add(classNode);

                    const decision = decideMemberUncached(
                        classNode,
                        name,
                        isStatic,
                        seen,
                    );

                    decisions.set(cacheKey, decision);

                    return decision;
                };

                const decideMemberUncached = (
                    classNode: ts.ClassLikeDeclaration,
                    name: string,
                    isStatic: boolean,
                    seen: Set<ts.ClassLikeDeclaration>,
                ): boolean | null => {
                    const base = getBaseClass(classNode);

                    if (base && "classNode" in base) {
                        if (!seen.has(base.classNode)) {
                            const inherited = decideMember(
                                base.classNode,
                                name,
                                isStatic,
                                seen,
                            );

                            if (inherited != null) {
                                return inherited;
                            }
                        }
                    } else if (
                        base &&
                        externalBaseHasMember(classNode, name, isStatic)
                    ) {
                        // `HTMLElement.focus`: the runtime and the library
                        // know it by this name.
                        return false;
                    }

                    const own = findOwnMember(classNode, name, isStatic);

                    if (!own) {
                        return null;
                    }

                    if (getImplementedNames(classNode).has(name)) {
                        return false;
                    }

                    return isRenamedMember(
                        name,
                        getAccessibility(own),
                        renamesPublicMembers(classNode),
                    );
                };

                // The decision about a declaration the checker resolved a
                // reference to: a class member, or something that is not one
                // (an interface member, a property of an object literal, a
                // declaration from a lib file), which is never renamed.
                const decideDeclaration = (
                    declaration: ts.Declaration,
                ): boolean => {
                    if (
                        isClassMemberDeclaration(declaration) &&
                        ts.isClassLike(declaration.parent)
                    ) {
                        const name = getTsName(declaration);

                        return (
                            name != null &&
                            (decideMember(
                                declaration.parent,
                                name,
                                isTsStatic(declaration),
                            ) ??
                                false)
                        );
                    }

                    if (
                        ts.isParameter(declaration) &&
                        isTsParameterProperty(declaration) &&
                        ts.isConstructorDeclaration(declaration.parent) &&
                        ts.isClassLike(declaration.parent.parent)
                    ) {
                        return (
                            decideMember(
                                declaration.parent.parent,
                                declaration.name.text,
                                false,
                            ) ?? false
                        );
                    }

                    return false;
                };

                // Whether the member that `object.x` refers to is renamed.
                // Through a union, every declaration must agree: a name that
                // is renamed in one class and kept in another cannot be
                // rewritten either way.
                const decideReference = (
                    nameNode: ts.Node,
                    name: string,
                ): boolean => {
                    const declarations =
                        checker.getSymbolAtLocation(nameNode)?.declarations ??
                        [];
                    const renamed = declarations.filter(decideDeclaration);

                    if (renamed.length === 0) {
                        return false;
                    }

                    if (renamed.length === declarations.length) {
                        return true;
                    }

                    const kept = declarations.find(
                        (declaration) => !renamed.includes(declaration),
                    );
                    const [first] = renamed;

                    if (!first || !kept) {
                        return false;
                    }

                    throw new Error(
                        `prefix-private-members: "${name}" at ${describeNode(nameNode)} refers to a member that is prefixed (declared at ${describeNode(first)}) and to one that is not (declared at ${describeNode(kept)}). Give the object one type, or exclude the member.`,
                    );
                };

                // -------------------------------------------------------
                // Deciding about the keys of object parameters

                interface KeysDecision {
                    /** Per parameter, the keys of its object pattern. */
                    parameterKeys: (null | string[])[] | null;
                    renamed: boolean;
                }

                const NO_KEYS: KeysDecision = {
                    parameterKeys: null,
                    renamed: false,
                };

                // Whether the keys of a constructor's object parameters are
                // renamed: the constructor follows the public members.
                const decideConstructorKeys = (
                    constructor: ts.ConstructorDeclaration,
                ): boolean =>
                    ts.isClassLike(constructor.parent) &&
                    isRenamedMember(
                        CONSTRUCTOR,
                        getAccessibility(constructor),
                        renamesPublicMembers(constructor.parent),
                    );

                const functionDecisions = new Map<FunctionLike, KeysDecision>();

                // The decision about a function, in whatever file it lives.
                const decideFunction = (fn: FunctionLike): KeysDecision => {
                    let decision = functionDecisions.get(fn);

                    if (!decision) {
                        decision = decideFunctionUncached(fn);
                        functionDecisions.set(fn, decision);
                    }

                    return decision;
                };

                const decideFunctionUncached = (
                    fn: FunctionLike,
                ): KeysDecision => {
                    const parameterKeys = getTsParameterKeys(fn);
                    const name = getFunctionName(fn);

                    if (
                        parameterKeys == null ||
                        name == null ||
                        excludeFunctions.has(name)
                    ) {
                        return { parameterKeys, renamed: false };
                    }

                    const file = fn.getSourceFile();
                    const use = analyzeFunctionUse(fn, name, file);

                    return {
                        parameterKeys,
                        renamed:
                            use.safe &&
                            (!use.exported ||
                                hasPrivateParameterTypes(fn, file)),
                    };
                };

                // The decision about the keys of what a call reaches: a
                // method, a constructor or a function, as the checker
                // resolves it.
                const decideCallKeys = (
                    call: ts.CallExpression | ts.NewExpression,
                ): KeysDecision => {
                    const declaration =
                        checker.getResolvedSignature(call)?.declaration;

                    if (
                        declaration == null ||
                        ts.isJSDocSignature(declaration)
                    ) {
                        return NO_KEYS;
                    }

                    if (ts.isConstructorDeclaration(declaration)) {
                        return {
                            parameterKeys: getTsParameterKeys(declaration),
                            renamed: decideConstructorKeys(declaration),
                        };
                    }

                    if (
                        ts.isMethodDeclaration(declaration) &&
                        ts.isClassLike(declaration.parent)
                    ) {
                        const name = getTsName(declaration);

                        return {
                            parameterKeys: getTsParameterKeys(declaration),
                            renamed:
                                name != null &&
                                (decideMember(
                                    declaration.parent,
                                    name,
                                    isTsStatic(declaration),
                                ) ??
                                    false),
                        };
                    }

                    if (isFunctionLike(declaration)) {
                        return decideFunction(declaration);
                    }

                    return NO_KEYS;
                };

                // Renames the keys of the object literals passed to a call,
                // going by the keys of the object patterns among the
                // parameters of what it reaches. An object that is not a
                // literal cannot follow the parameter, and the call would
                // break: that is an error to fix in the source or the options.
                const renameArgumentKeys = (
                    callArguments: t.Node[],
                    decision: KeysDecision,
                    describe: () => string,
                ): void => {
                    if (!decision.renamed) {
                        return;
                    }

                    decision.parameterKeys?.forEach((keys, index) => {
                        const argument = callArguments[index];

                        if (keys == null || argument == null) {
                            return;
                        }

                        if (isPlainObjectLiteral(argument)) {
                            renameObjectKeys(
                                argument as t.ObjectExpression,
                                keys,
                            );
                        } else {
                            throw new Error(
                                `prefix-private-members: ${describe()} passes an object that is not a literal to a parameter whose keys are prefixed (${keys.join(", ")}). Pass an object literal, or exclude the class, member or function.`,
                            );
                        }
                    });
                };

                // Where a call is, for an error message.
                const describeCall = (node: t.Node, callee: string): string =>
                    `${callee} at ${filename}:${node.loc?.start.line ?? "?"}`;

                // -------------------------------------------------------
                // Rewriting
                //
                // Everything is decided on the file as written, then changed
                // in one go: the TypeScript AST is never touched, so the
                // order does not matter for the decisions, but a renamed
                // parameter property is found in the constructor body by its
                // old name.

                const rewrites: (() => void)[] = [];

                const planClass = (classPath: NodePath<t.Class>): void => {
                    const classNode = findTsNode(
                        classPath.node,
                        ts.isClassLike,
                    );

                    if (!classNode) {
                        return;
                    }

                    for (const memberPath of classPath
                        .get("body")
                        .get("body")) {
                        const member = memberPath.node;

                        if (!isMemberNode(member)) {
                            continue;
                        }

                        if (isConstructor(member)) {
                            planConstructor(memberPath, classNode);
                            continue;
                        }

                        const key = getMemberKey(member);
                        const name = key == null ? null : getName(key);
                        const newName = name == null ? null : getNewName(name);

                        if (key == null || name == null || newName == null) {
                            continue;
                        }

                        if (!decideMember(classNode, name, member.static)) {
                            continue;
                        }

                        rewrites.push(() => {
                            setName(key, newName);

                            if (prefixParameterKeys && isMethodNode(member)) {
                                renameParameterKeys(member);
                            }
                        });
                    }
                };

                const planConstructor = (
                    memberPath: NodePath<ClassBodyMember>,
                    classNode: ts.ClassLikeDeclaration,
                ): void => {
                    if (!memberPath.isClassMethod()) {
                        return;
                    }

                    const constructorPath = memberPath;
                    const member = constructorPath.node;

                    for (const parameterProperty of getParameterProperties(
                        member,
                    )) {
                        const identifier =
                            getParameterIdentifier(parameterProperty);
                        const name = getName(identifier);
                        const newName = name == null ? null : getNewName(name);

                        if (
                            name != null &&
                            newName != null &&
                            decideMember(classNode, name, false)
                        ) {
                            rewrites.push(() => {
                                renameParameter(
                                    constructorPath,
                                    identifier,
                                    name,
                                    newName,
                                );
                            });
                        }
                    }

                    if (
                        prefixParameterKeys &&
                        isRenamedMember(
                            CONSTRUCTOR,
                            member.accessibility ?? null,
                            renamesPublicMembers(classNode),
                        )
                    ) {
                        rewrites.push(() => {
                            renameParameterKeys(member);
                        });
                    }
                };

                const planFunction = (fn: NamedFunction): void => {
                    const tsFunction = findTsNode(fn, isFunctionLike);

                    if (tsFunction && decideFunction(tsFunction).renamed) {
                        rewrites.push(() => {
                            renameParameterKeys(fn);
                        });
                    }
                };

                const planMember = (path: NodePath<PropertyAccess>): void => {
                    const { property } = path.node;
                    const name = getPropertyName(path.node);
                    const newName = name == null ? null : getNewName(name);

                    if (name == null || newName == null) {
                        return;
                    }

                    const nameNode = findTsName(property);

                    if (
                        nameNode &&
                        ts.isPropertyAccessExpression(nameNode.parent) &&
                        decideReference(nameNode, name)
                    ) {
                        rewrites.push(() => {
                            setName(property, newName);
                        });
                    }
                };

                const planCall = (
                    path: NodePath<
                        | t.CallExpression
                        | t.NewExpression
                        | t.OptionalCallExpression
                    >,
                ): void => {
                    const call = findTsNode(path.node, isCallLike);

                    if (!call) {
                        return;
                    }

                    const decision = decideCallKeys(call);

                    if (!decision.renamed) {
                        return;
                    }

                    const callNode = path.node;
                    const { callee } = callNode;
                    let calleeName: string;

                    if (callNode.type === "NewExpression") {
                        calleeName = `new ${getName(callee) ?? "?"}(...)`;
                    } else if (callee.type === "Super") {
                        calleeName = "super(...)";
                    } else if (
                        callee.type === "MemberExpression" ||
                        callee.type === "OptionalMemberExpression"
                    ) {
                        calleeName = `.${getPropertyName(callee) ?? "?"}(...)`;
                    } else {
                        calleeName = `${getName(callee) ?? "a call"}(...)`;
                    }

                    rewrites.push(() => {
                        renameArgumentKeys(callNode.arguments, decision, () =>
                            describeCall(callNode, calleeName),
                        );
                    });
                };

                programPath.traverse({
                    Class: planClass,
                    "FunctionDeclaration|VariableDeclarator"(path) {
                        if (prefixParameterKeys) {
                            const fn = getDeclaredFunction(path.node);

                            if (fn) {
                                planFunction(fn);
                            }
                        }
                    },
                    "MemberExpression|OptionalMemberExpression"(path) {
                        planMember(path);
                    },
                    "CallExpression|OptionalCallExpression|NewExpression"(
                        path,
                    ) {
                        if (prefixParameterKeys) {
                            planCall(path);
                        }
                    },
                });

                for (const rewrite of rewrites) {
                    rewrite();
                }
            },
        },
    };
}
