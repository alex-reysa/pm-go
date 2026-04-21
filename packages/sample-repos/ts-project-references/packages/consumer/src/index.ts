// The consumer package references `shared` via tsconfig "references",
// not a regular npm dependency. In a real project that ref would be
// wired through a package-scoped `paths` entry or via published
// .d.ts + dist; the fixture only needs to compile type-check semantics
// far enough to model a project-references shape.
export function consumerFn(): string {
  return "phase7-ts-refs-consumer";
}
