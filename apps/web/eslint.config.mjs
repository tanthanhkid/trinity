import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// React Compiler-era rules flag a lot of long-standing patterns; keep them visible as
// warnings until they are cleaned up, but do not fail CI on them.
const relaxed = {
  "react-hooks/set-state-in-effect": "warn",
  "react-hooks/static-components": "warn",
  "react-hooks/refs": "warn",
  "react-hooks/purity": "warn",
  "react-hooks/globals": "warn",
  "react/display-name": "warn",
  "react/no-unescaped-entities": "off",
  "@typescript-eslint/no-require-imports": "warn",
  "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
  "@next/next/no-html-link-for-pages": "warn",
};

// A rule can only be re-configured in the config object that owns its plugin.
const withRelaxedRules = [...nextVitals, ...nextTs].map((cfg) => {
  if (!cfg.plugins) return cfg;
  const owned = Object.fromEntries(
    Object.entries(relaxed).filter(([rule]) => {
      const parts = rule.split("/");
      const key = rule.startsWith("@") ? (parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]) : parts[0];
      return Object.prototype.hasOwnProperty.call(cfg.plugins, key);
    }),
  );
  return Object.keys(owned).length ? { ...cfg, rules: { ...cfg.rules, ...owned } } : cfg;
});

const eslintConfig = defineConfig([
  ...withRelaxedRules,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "e2e-results/**",
    "scripts/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
