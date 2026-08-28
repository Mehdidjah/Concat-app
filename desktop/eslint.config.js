// Flat ESLint config. The point of this file is the react-hooks plugin -
// dependency-array mistakes are invisible to tsc and this codebase leans hard
// on effects with deliberate exemptions, which only mean something when the
// non-exempted arrays are actually checked. TypeScript already enforces the
// rest of what a heavier preset would.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "node_modules/"] },
  {
    files: ["src/**/*.{ts,tsx}", "*.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The two classic hooks rules, at error. The plugin's newer
      // React-Compiler-era rules (refs/purity/set-state-in-effect) reject the
      // latest-ref idiom (`ref.current = value` during render) this codebase
      // uses deliberately; adopting them is a compiler-migration decision,
      // not a lint setting.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // tsc's noUnusedLocals already covers this, with better fix locations.
      "@typescript-eslint/no-unused-vars": "off",
    },
  }
);
