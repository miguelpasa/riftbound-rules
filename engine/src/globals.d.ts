// structuredClone exists in every target runtime (browsers, Web Workers, Node >= 17)
// but not in the ES2022 lib the engine compiles against (no DOM, no Node types).
declare function structuredClone<T>(value: T): T;
