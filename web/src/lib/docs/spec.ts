// The slice of OpenAPI 3.1 the docs page reads. Kept loose: the spec file is the source, this only renders it.
import { api } from '@/lib/api';
export type Schema = {
	$ref?: string;
	type?: string | string[];
	format?: string;
	description?: string;
	enum?: unknown[];
	example?: unknown;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	maxLength?: number;
	maxItems?: number;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	oneOf?: Schema[];
	anyOf?: Schema[];
	additionalProperties?: boolean | Schema;
};
export type Parameter = { name: string; in: string; description?: string; required?: boolean; schema?: Schema; $ref?: string };
export type Operation = {
	operationId: string;
	summary?: string;
	description?: string;
	tags?: string[];
	security?: unknown[];
	parameters?: Parameter[];
	requestBody?: { content?: Record<string, { schema?: Schema }> };
	responses?: Record<string, { description?: string; $ref?: string; content?: Record<string, { schema?: Schema }> }>;
	'x-ulka-permission'?: string;
	'x-ulka-errors'?: string[];
	'x-ulka-group'?: string;
};
export type Spec = {
	info: { title: string; version: string; summary?: string; description?: string };
	tags?: { name: string; description?: string; 'x-ulka-groups'?: string[] }[];
	paths: Record<string, Record<string, Operation>>;
	webhooks?: Record<string, Record<string, Operation>>;
	components: { schemas?: Record<string, Schema>; parameters?: Record<string, Parameter> };
	'x-ulka-common-errors'?: Record<string, string>;
};

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

/** Follows a local $ref ("#/components/schemas/X") to what it names. */
export function resolve<T>(spec: Spec, node: T & { $ref?: string }): T {
	if (!node?.$ref) return node;
	const target = node.$ref.replace(/^#\//, '').split('/').reduce<any>((o, k) => o?.[k], spec);
	return target ?? node;
}

export const refName = (ref?: string) => ref?.split('/').at(-1) ?? '';

/** A type written for people: "string or null", "array of VideoAsset". */
export function typeLabel(spec: Spec, s: Schema): string {
	if (s.$ref) return refName(s.$ref);
	if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf)!.map((x) => typeLabel(spec, x)).join(' or ');
	const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : ['object'];
	return types
		.map((t) => (t === 'array' && s.items ? `array of ${typeLabel(spec, s.items)}` : t === 'string' && s.format ? `string (${s.format})` : t))
		.join(' or ');
}

// Fetched once and shared: the docs sidebar and the reference page both read it.
let loading: Promise<Spec> | undefined;
export const loadSpec = () => (loading ??= api<Spec>('GET', '/v1/openapi.json').catch((err) => ((loading = undefined), Promise.reject(err))));

export const sectionId = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
export const groupId = (name: string) => 'group-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Example JSON for a schema, from its examples: every field for a response, `only` picks the ones for a request. */
export function sample(spec: Spec, node: Schema, only?: (name: string, f: Schema) => boolean, depth = 0): unknown {
	const s = resolve(spec, node);
	if (s.example !== undefined) return s.example;
	if (s.enum) return s.enum[0];
	if (s.oneOf || s.anyOf) return sample(spec, (s.oneOf ?? s.anyOf)![0], only, depth);
	const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
	if (type === 'array') return depth < 4 && s.items ? [sample(spec, s.items, undefined, depth + 1)] : [];
	if (s.properties) {
		if (depth >= 4) return {};
		const fields = Object.entries(s.properties).filter(([k, f]) => !only || only(k, f));
		return Object.fromEntries(fields.map(([k, f]) => [k, sample(spec, f, undefined, depth + 1)]));
	}
	return { string: s.format === 'date-time' ? '2026-09-29T10:00:00Z' : s.format === 'uuid' ? '3e9b2359-…' : '…', integer: 0, number: 0, boolean: false }[type ?? ''] ?? null;
}
