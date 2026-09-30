export declare const E2E_PORTS: { readonly live: 7791; readonly replay: 7792; readonly perf: 7793 };
export declare const FIXTURES_DIR: string;
export declare const SENTINEL_SETTINGS: string;
export declare const PROBE_FILES: Record<string, string>;
export declare function e2eDir(): string;
export declare function e2eRepo(mode: 'live' | 'replay' | 'perf'): string;
export declare function makeProbeRepo(repo: string): void;
export declare function makePerfRepo(repo: string, count: number): string[];
export declare function fixturePayloads(name: string, repo: string, home: string): string[];
