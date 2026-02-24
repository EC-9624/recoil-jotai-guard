import type {Node} from 'oxc-parser';

export type StateKind = 'atom' | 'selector' | 'atomFamily' | 'selectorFamily';

export type RecoilDefinition = {
  name: string;
  kind: StateKind;
  file: string;
  line: number;
  getBodyAst: Node | null;
  inlineDefaultGetBody: Node | null;
};

export type JotaiDefinition = {
  name: string;
  file: string;
  line: number;
};

export type JotaiImport = {
  localName: string;
  importedName: string;
  source: string;
  file: string;
};

export type UsageType = 'reader' | 'setter' | 'initializer';

export type Usage = {
  atomName: string;
  localName: string;
  type: UsageType;
  hook: string;
  file: string;
  line: number;
  enclosingDefinition?: string;
};

export type ImportMapping = {
  localName: string;
  canonicalName: string;
  sourceFile: string;
};

export type ViolationSeverity = 'error' | 'warning';

export type Violation = {
  check: 1 | 2 | 3;
  severity: ViolationSeverity;
  atomOrSelectorName: string;
  message: string;
  location: {file: string; line: number};
  details: string[];
};

export type ExtractionResult = {
  recoilDefinitions: RecoilDefinition[];
  jotaiDefinitions: JotaiDefinition[];
  jotaiImports: JotaiImport[];
};

export type UsageCollectionResult = {
  usages: Usage[];
};

export type ResolvedUsage = Usage & {
  resolvedName: string;
  definitionFile: string;
  writerKind?: WriterKind;
};

// --- Impact analysis types ---

export type DependencyGraph = {
  dependentSelectors: Map<string, Set<string>>;
  componentUsages: Map<string, ResolvedUsage[]>;
  definitions: Map<string, RecoilDefinition>;
};

export type ImpactResult = {
  target: {
    name: string;
    kind: StateKind;
    file: string;
    line: number;
  };
  direct: {
    readers: ResolvedUsage[];
    setters: ResolvedUsage[];
    initializers: ResolvedUsage[];
  };
  transitive: TransitiveDependency[];
  summary: ImpactSummary;
};

export type TransitiveDependency = {
  via: string;
  viaDefinition: {file: string; line: number; kind: StateKind};
  depth: number;
  readers: ResolvedUsage[];
  setters: ResolvedUsage[];
};

export type ImpactSummary = {
  totalFiles: number;
  totalComponents: number;
  totalSelectors: number;
};

// --- Setter binding types (Phase 13: Wrapper-Aware Setter Tracking) ---

export type HookWriteBindingKind = 'setter' | 'tuple';

export type HookWriteBinding = {
  kind: HookWriteBindingKind;
  stateId: string;
};

export type SetterBindingMap = Map<string, string>; // "file:identifierName" -> atomName

export type RuntimeWriteCallsite = {
  atomName: string;
  file: string;
  line: number;
  calleeName: string;
};

export type WriterKind = 'runtime' | 'fallback';

export type CoverageOptions = {
  runtimeCallsites: RuntimeWriteCallsite[];
  resolvedFactoryKeys: Set<string>;
};
