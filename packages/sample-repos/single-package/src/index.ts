// Phase 7 fixture (single-package): intentionally trivial surface area so
// matrix smoke can run without a real build/test pipeline. The stub
// implementer will append a file under phase7-matrix/ and commit it; nothing
// imports this module at runtime.
export function greet(name: string): string {
  return `hello, ${name}`;
}
