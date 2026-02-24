import {describe, expect, it} from 'vitest';
import {formatImpactJson, formatImpactText} from '../src/impact-reporter.js';
import type {ImpactResult, ResolvedUsage, WriterKind} from '../src/types.js';

const targetDir = '/project/src/features/editor';

function makeResolvedUsage(overrides: Partial<ResolvedUsage> & {resolvedName: string}): ResolvedUsage {
	return {
		atomName: overrides.resolvedName,
		localName: overrides.resolvedName,
		type: 'reader',
		hook: 'useRecoilValue',
		file: `${targetDir}/component.tsx`,
		line: 10,
		definitionFile: `${targetDir}/atoms.ts`,
		...overrides,
	};
}

function makeImpactResult(overrides?: Partial<ImpactResult>): ImpactResult {
	return {
		target: {
			name: 'myAtom',
			kind: 'atom',
			file: `${targetDir}/states/core.ts`,
			line: 5,
		},
		direct: {
			readers: [],
			setters: [],
			initializers: [],
		},
		transitive: [],
		summary: {
			totalFiles: 0,
			totalComponents: 0,
			totalSelectors: 0,
		},
		...overrides,
	};
}

describe('formatImpactText', () => {
	it('single atom with direct and transitive deps', () => {
		const result = makeImpactResult({
			target: {
				name: 'myAtom',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 5,
			},
			direct: {
				readers: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-data.tsx`,
						line: 15,
					}),
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-other.tsx`,
						line: 20,
					}),
				],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/hooks/use-setter.tsx`,
						line: 8,
					}),
				],
				initializers: [],
			},
			transitive: [
				{
					via: 'derivedSelector',
					viaDefinition: {
						file: `${targetDir}/states/selectors.ts`,
						line: 10,
						kind: 'selector',
					},
					depth: 1,
					readers: [
						makeResolvedUsage({
							resolvedName: 'derivedSelector',
							type: 'reader',
							hook: 'useRecoilValue',
							file: `${targetDir}/components/display.tsx`,
							line: 25,
						}),
					],
					setters: [],
				},
			],
			summary: {
				totalFiles: 5,
				totalComponents: 4,
				totalSelectors: 1,
			},
		});

		const output = formatImpactText([result], targetDir);

		expect(output).toContain('Impact: myAtom (atom)');
		expect(output).toContain('READERS (2):');
		expect(output).toContain('SETTERS (1):');
		expect(output).toContain('Transitive (via selectors):');
		expect(output).toContain('Summary: 5 files, 4 components, 1 selectors');
	});

	it('omits empty sections', () => {
		const result = makeImpactResult({
			direct: {
				readers: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-data.tsx`,
						line: 15,
					}),
				],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/hooks/use-setter.tsx`,
						line: 8,
					}),
				],
				initializers: [],
			},
			transitive: [],
			summary: {
				totalFiles: 2,
				totalComponents: 2,
				totalSelectors: 0,
			},
		});

		const output = formatImpactText([result], targetDir);

		expect(output).not.toContain('INITIALIZERS');
		expect(output).not.toContain('Transitive');
	});

	it('multiple results separated by ---', () => {
		const result1 = makeImpactResult({
			target: {
				name: 'atomOne',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 1,
			},
		});
		const result2 = makeImpactResult({
			target: {
				name: 'atomTwo',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 10,
			},
		});

		const output = formatImpactText([result1, result2], targetDir);

		expect(output).toContain('---');
		expect(output).toContain('Impact: atomOne (atom)');
		expect(output).toContain('Impact: atomTwo (atom)');
	});

	it('empty results', () => {
		const output = formatImpactText([], targetDir);

		expect(output).toBe('No impact found.');
	});

	it('relative paths', () => {
		const result = makeImpactResult({
			target: {
				name: 'myAtom',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 5,
			},
			direct: {
				readers: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-data.tsx`,
						line: 15,
					}),
				],
				setters: [],
				initializers: [],
			},
			transitive: [],
			summary: {
				totalFiles: 1,
				totalComponents: 1,
				totalSelectors: 0,
			},
		});

		const output = formatImpactText([result], targetDir);

		// All paths should be relative (no targetDir prefix)
		expect(output).toContain('states/core.ts:5');
		expect(output).toContain('hooks/use-data.tsx:15');
		expect(output).not.toContain(targetDir);
	});

	it('coverage-first: shows WRITERS header with runtime and fallback counts', () => {
		const result = makeImpactResult({
			direct: {
				readers: [],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'setter call',
						file: `${targetDir}/hooks/use-editor/index.ts`,
						line: 102,
						writerKind: 'runtime' as WriterKind,
					}),
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'setter call',
						file: `${targetDir}/hooks/use-editor/index.ts`,
						line: 122,
						writerKind: 'runtime' as WriterKind,
					}),
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'setter call',
						file: `${targetDir}/pages/step1/Header/index.tsx`,
						line: 108,
						writerKind: 'runtime' as WriterKind,
					}),
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/states/contents.ts`,
						line: 125,
						writerKind: 'fallback' as WriterKind,
					}),
				],
				initializers: [],
			},
			summary: {
				totalFiles: 4,
				totalComponents: 4,
				totalSelectors: 0,
			},
		});

		const output = formatImpactText([result], targetDir);

		expect(output).toContain('WRITERS (3 runtime, 1 fallback):');
		expect(output).not.toContain('SETTERS');
		// Runtime entries include kind label
		expect(output).toContain('hooks/use-editor/index.ts:102    runtime    setter call');
		expect(output).toContain('hooks/use-editor/index.ts:122    runtime    setter call');
		expect(output).toContain('pages/step1/Header/index.tsx:108    runtime    setter call');
		// Fallback entries include kind label
		expect(output).toContain('states/contents.ts:125    fallback    useSetRecoilState');
	});

	it('legacy mode: shows SETTERS header when no writerKind is set', () => {
		const result = makeImpactResult({
			direct: {
				readers: [],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/hooks/use-setter.tsx`,
						line: 8,
					}),
				],
				initializers: [],
			},
			summary: {
				totalFiles: 1,
				totalComponents: 1,
				totalSelectors: 0,
			},
		});

		const output = formatImpactText([result], targetDir);

		expect(output).toContain('SETTERS (1):');
		expect(output).not.toContain('WRITERS');
		expect(output).not.toContain('runtime');
		expect(output).not.toContain('fallback');
	});

	it('coverage-first: all runtime, zero fallback', () => {
		const result = makeImpactResult({
			direct: {
				readers: [],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'setter call',
						file: `${targetDir}/hooks/use-setter.tsx`,
						line: 10,
						writerKind: 'runtime' as WriterKind,
					}),
				],
				initializers: [],
			},
			summary: {
				totalFiles: 1,
				totalComponents: 1,
				totalSelectors: 0,
			},
		});

		const output = formatImpactText([result], targetDir);

		expect(output).toContain('WRITERS (1 runtime, 0 fallback):');
		expect(output).not.toContain('SETTERS');
	});
});

describe('formatImpactJson', () => {
	it('single result outputs object (not array)', () => {
		const result = makeImpactResult({
			direct: {
				readers: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-data.tsx`,
						line: 15,
					}),
				],
				setters: [],
				initializers: [],
			},
			summary: {
				totalFiles: 1,
				totalComponents: 1,
				totalSelectors: 0,
			},
		});

		const output = formatImpactJson([result], targetDir);

		expect(output.trimStart().startsWith('{')).toBe(true);

		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed).toHaveProperty('target');
		expect(parsed).toHaveProperty('direct');
		expect(parsed).toHaveProperty('transitive');
		expect(parsed).toHaveProperty('summary');
		expect(Array.isArray(parsed)).toBe(false);
	});

	it('multiple results outputs array', () => {
		const result1 = makeImpactResult({
			target: {
				name: 'atomOne',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 1,
			},
		});
		const result2 = makeImpactResult({
			target: {
				name: 'atomTwo',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 10,
			},
		});

		const output = formatImpactJson([result1, result2], targetDir);

		expect(output.trimStart().startsWith('[')).toBe(true);

		const parsed = JSON.parse(output) as unknown[];
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
	});

	it('relative paths in output', () => {
		const result = makeImpactResult({
			target: {
				name: 'myAtom',
				kind: 'atom',
				file: `${targetDir}/states/core.ts`,
				line: 5,
			},
			direct: {
				readers: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-data.tsx`,
						line: 15,
					}),
				],
				setters: [],
				initializers: [],
			},
			transitive: [
				{
					via: 'derivedSelector',
					viaDefinition: {
						file: `${targetDir}/states/selectors.ts`,
						line: 10,
						kind: 'selector',
					},
					depth: 1,
					readers: [
						makeResolvedUsage({
							resolvedName: 'derivedSelector',
							type: 'reader',
							hook: 'useRecoilValue',
							file: `${targetDir}/components/display.tsx`,
							line: 25,
						}),
					],
					setters: [],
				},
			],
			summary: {
				totalFiles: 3,
				totalComponents: 2,
				totalSelectors: 1,
			},
		});

		const output = formatImpactJson([result], targetDir);
		const parsed = JSON.parse(output) as {
			target: {file: string};
			direct: {readers: Array<{file: string}>};
			transitive: Array<{
				viaDefinition: {file: string};
				readers: Array<{file: string}>;
			}>;
		};

		// All file fields should be relative
		expect(parsed.target.file).toBe('states/core.ts');
		expect(parsed.direct.readers[0].file).toBe('hooks/use-data.tsx');
		expect(parsed.transitive[0].viaDefinition.file).toBe('states/selectors.ts');
		expect(parsed.transitive[0].readers[0].file).toBe('components/display.tsx');

		// No absolute paths in output
		expect(output).not.toContain(targetDir);
	});

	it('simplified usage shape', () => {
		const result = makeImpactResult({
			direct: {
				readers: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'reader',
						hook: 'useRecoilValue',
						file: `${targetDir}/hooks/use-data.tsx`,
						line: 15,
					}),
				],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/hooks/use-setter.tsx`,
						line: 8,
					}),
				],
				initializers: [],
			},
			summary: {
				totalFiles: 2,
				totalComponents: 2,
				totalSelectors: 0,
			},
		});

		const output = formatImpactJson([result], targetDir);
		const parsed = JSON.parse(output) as {
			direct: {
				readers: Array<Record<string, unknown>>;
				setters: Array<Record<string, unknown>>;
			};
		};

		const reader = parsed.direct.readers[0];
		const setter = parsed.direct.setters[0];

		// Should only contain file, line, hook, type
		expect(Object.keys(reader).sort()).toEqual(['file', 'hook', 'line', 'type'].sort());
		expect(Object.keys(setter).sort()).toEqual(['file', 'hook', 'line', 'type'].sort());

		// Should NOT contain internal fields
		expect(reader).not.toHaveProperty('atomName');
		expect(reader).not.toHaveProperty('localName');
		expect(reader).not.toHaveProperty('resolvedName');
		expect(reader).not.toHaveProperty('definitionFile');

		// Verify values
		expect(reader.file).toBe('hooks/use-data.tsx');
		expect(reader.line).toBe(15);
		expect(reader.hook).toBe('useRecoilValue');
		expect(reader.type).toBe('reader');
	});

	it('coverage-first: setter entries include writerKind field', () => {
		const result = makeImpactResult({
			direct: {
				readers: [],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'setter call',
						file: `${targetDir}/hooks/use-editor/index.ts`,
						line: 102,
						writerKind: 'runtime' as WriterKind,
					}),
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/states/contents.ts`,
						line: 125,
						writerKind: 'fallback' as WriterKind,
					}),
				],
				initializers: [],
			},
			summary: {
				totalFiles: 2,
				totalComponents: 2,
				totalSelectors: 0,
			},
		});

		const output = formatImpactJson([result], targetDir);
		const parsed = JSON.parse(output) as {
			direct: {
				setters: Array<{
					file: string;
					line: number;
					hook: string;
					type: string;
					writerKind: string;
				}>;
			};
		};

		expect(parsed.direct.setters).toHaveLength(2);

		const runtimeSetter = parsed.direct.setters[0];
		expect(runtimeSetter.writerKind).toBe('runtime');
		expect(runtimeSetter.file).toBe('hooks/use-editor/index.ts');
		expect(runtimeSetter.line).toBe(102);
		expect(runtimeSetter.hook).toBe('setter call');

		const fallbackSetter = parsed.direct.setters[1];
		expect(fallbackSetter.writerKind).toBe('fallback');
		expect(fallbackSetter.file).toBe('states/contents.ts');
		expect(fallbackSetter.line).toBe(125);
		expect(fallbackSetter.hook).toBe('useSetRecoilState');
	});

	it('legacy mode: setter entries have no writerKind field', () => {
		const result = makeImpactResult({
			direct: {
				readers: [],
				setters: [
					makeResolvedUsage({
						resolvedName: 'myAtom',
						type: 'setter',
						hook: 'useSetRecoilState',
						file: `${targetDir}/hooks/use-setter.tsx`,
						line: 8,
					}),
				],
				initializers: [],
			},
			summary: {
				totalFiles: 1,
				totalComponents: 1,
				totalSelectors: 0,
			},
		});

		const output = formatImpactJson([result], targetDir);
		const parsed = JSON.parse(output) as {
			direct: {
				setters: Array<Record<string, unknown>>;
			};
		};

		expect(parsed.direct.setters).toHaveLength(1);
		const setter = parsed.direct.setters[0];

		// Should contain file, line, hook, type -- but NOT writerKind
		expect(Object.keys(setter).sort()).toEqual(['file', 'hook', 'line', 'type'].sort());
		expect(setter).not.toHaveProperty('writerKind');
	});
});
