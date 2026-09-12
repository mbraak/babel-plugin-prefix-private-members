import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/restrict-template-expressions": [
                "error",
                { allowBoolean: true, allowNumber: true },
            ],
        },
    },
    { ignores: ["dist/"] },
];
