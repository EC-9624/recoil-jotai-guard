# Implementation Plan

Standalone CLI toolset for the Recoil-to-Jotai migration in `press-release-editor-v3`. Uses `oxc-parser` + `oxc-walker` for static AST analysis. Provides two commands: `check` (migration safety checks) and `impact` (scope of impact analysis).

**Total estimate**: ~14 working days (1 developer).

## Phases

### `check` command (completed)

| Phase                            | Module                     | Duration | Status | Deliverable                      |
| -------------------------------- | -------------------------- | -------- | ------ | -------------------------------- |
| [0](./phase-0-scaffold.md)       | Scaffold                   | 0.25 day | done   | Working project, file globbing   |
| [1](./phase-1-extract.md)        | `extract.ts`               | 0.5 day  | done   | Definition extraction with tests |
| [2](./phase-2-collect-usages.md) | `collect-usages.ts`        | 1.5 days | done   | Usage collection with tests      |
| [3](./phase-3-resolve.md)        | `resolve.ts`               | 1 day    | done   | Import resolution with tests     |
| [4](./phase-4-checks.md)         | `checks.ts`                | 0.5 day  | done   | All 3 checks with tests          |
| [5](./phase-5-reporter-cli.md)   | `reporter.ts` + `index.ts` | 0.25 day | done   | CLI output and orchestration     |
| [6](./phase-6-integration.md)    | Integration testing        | 1 day    | done   | Validated against real codebase  |

### `impact` command (planned)

| Phase                                  | Module                           | Duration | Status | Deliverable                                     |
| -------------------------------------- | -------------------------------- | -------- | ------ | ----------------------------------------------- |
| [7](./phase-7-enrich-usages.md)        | `types.ts` + `collect-usages.ts` | 0.5 day  | done   | `enclosingDefinition` on `get(selector)` usages |
| [8](./phase-8-graph.md)                | `files.ts` + `graph.ts`          | 0.75 day | done   | Shared file glob, dependency graph builder      |
| [9](./phase-9-impact.md)               | `impact.ts`                      | 0.75 day | done   | Transitive BFS impact analysis                  |
| [10](./phase-10-impact-reporter.md)    | `impact-reporter.ts`             | 0.5 day  | done   | Text + JSON output formatters                   |
| [11](./phase-11-impact-cli.md)         | `impact-cli.ts`                  | 0.5 day  | done   | CLI with --atom, --file, --git, --json          |
| [12](./phase-12-impact-integration.md) | Integration testing              | 0.75 day | done   | Validated against real codebase                 |

### Wrapper-aware setter tracking (planned)

| Phase                               | Module                                                     | Duration  | Status | Deliverable                                    |
| ----------------------------------- | ---------------------------------------------------------- | --------- | ------ | ---------------------------------------------- |
| [13](./phase-13-wrapper-setters.md) | `setter-bindings.ts` + `setter-callsites.ts` + integration | 3.25 days | done   | Coverage-first writers V1 (runtime + fallback) |

## Dependencies

```
Phase 0 (scaffold)
  |
  v
Phase 1 (extract)
  |
  +------+
  v      v
Phase 2  Phase 3
(usages) (resolve)
  |      |
  +--+---+
     v
Phase 4 (checks)
     |
     v
Phase 5 (reporter + CLI)
     |
     v
Phase 6 (integration)          <-- check command complete
     |
     v
Phase 7 (enrich usages)        <-- impact command starts
     |
     v
Phase 8 (files.ts + graph.ts)
     |
     v
Phase 9 (impact.ts)
     |
     v
Phase 10 (impact-reporter.ts)
     |
     v
Phase 11 (impact-cli.ts)
     |
     v
Phase 12 (impact integration)          <-- impact command complete
     |
     v
Phase 13 (wrapper-aware setters)       <-- runtime writer mode
```

Phases 7-12 are sequential. Each depends on the prior phase.
Phase 13 depends on Phase 12 (requires working impact command).

## References

- [PRD](../PRD.md) -- What and why
- [Spec](../spec.md) -- Types, AST patterns, algorithms
