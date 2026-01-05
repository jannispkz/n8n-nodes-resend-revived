import {
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeProperties,
	INodePropertyOptions,
	NodeOperationError,
} from 'n8n-workflow';

const RESEND_API_BASE = 'https://api.resend.com';

export type ListOptions = {
	after?: string;
	before?: string;
};

/**
 * Factory function to create list options field for any resource.
 * Eliminates duplication of After/Before pagination fields across description files.
 */
export const createListOptions = (
	resource: string,
	resourceLabel: string,
): INodeProperties => ({
	displayName: 'List Options',
	name: `${resource}ListOptions`,
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	displayOptions: {
		show: {
			resource: [resource],
			operation: ['list'],
		},
	},
	options: [
		{
			displayName: 'After',
			name: 'after',
			type: 'string',
			default: '',
			description: `Return results after this ${resourceLabel} ID`,
		},
		{
			displayName: 'Before',
			name: 'before',
			type: 'string',
			default: '',
			description: `Return results before this ${resourceLabel} ID`,
		},
	],
});

/**
 * Helper to make authenticated requests to the Resend API.
 * Reduces duplication of Authorization headers across all API calls.
 */
export const resendRequest = async <T = unknown>(
	executeFunctions: IExecuteFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	apiKey: string,
	body?: Record<string, unknown> | Record<string, unknown>[],
	qs?: Record<string, string | number>,
): Promise<T> => {
	return executeFunctions.helpers.httpRequest({
		url: `${RESEND_API_BASE}${endpoint}`,
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body,
		qs,
		json: true,
	});
};

/**
 * Load options for dropdown fields (max 100 items).
 * Used by getTemplates, getSegments, getTopics.
 */
const loadDropdownOptions = async (
	loadOptionsFunctions: ILoadOptionsFunctions,
	endpoint: string,
): Promise<INodePropertyOptions[]> => {
	const credentials = await loadOptionsFunctions.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;

	const response = await loadOptionsFunctions.helpers.httpRequest({
		url: `${RESEND_API_BASE}${endpoint}`,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		qs: { limit: 100 },
		json: true,
	});

	const items = response?.data ?? [];
	return items
		.filter((item: { id?: string }) => item?.id)
		.map((item: { id: string; name?: string }) => ({
			name: item.name ? `${item.name} (${item.id})` : item.id,
			value: item.id,
		}));
};

export const normalizeEmailList = (value: string | string[] | undefined) => {
	if (Array.isArray(value)) {
		return value
			.map((email) => String(email).trim())
			.filter((email) => email);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((email) => email.trim())
			.filter((email) => email);
	}
	return [];
};

export const parseTemplateVariables = (
	executeFunctions: IExecuteFunctions,
	variablesInput: { variables?: Array<{ key: string; type: string; fallbackValue?: unknown }> } | undefined,
	fallbackKey: 'fallbackValue' | 'fallback_value',
	itemIndex: number,
) => {
	if (!variablesInput?.variables?.length) {
		return undefined;
	}

	return variablesInput.variables.map((variable) => {
		const variableEntry: Record<string, unknown> = {
			key: variable.key,
			type: variable.type,
		};

		const fallbackValue = variable.fallbackValue;
		if (fallbackValue !== undefined && fallbackValue !== '') {
			let parsedFallback: string | number = fallbackValue as string;
			if (variable.type === 'number') {
				const numericFallback = typeof fallbackValue === 'number' ? fallbackValue : Number(fallbackValue);
				if (Number.isNaN(numericFallback)) {
					throw new NodeOperationError(
						executeFunctions.getNode(),
						`Variable "${variable.key}" fallback value must be a number`,
						{ itemIndex },
					);
				}
				parsedFallback = numericFallback;
			}
			variableEntry[fallbackKey] = parsedFallback;
		}

		return variableEntry;
	});
};

export const buildTemplateSendVariables = (
	variablesInput: { variables?: Array<{ key: string; value?: unknown }> } | undefined,
) => {
	if (!variablesInput?.variables?.length) {
		return undefined;
	}
	const variables: Record<string, unknown> = {};
	for (const variable of variablesInput.variables) {
		if (!variable.key) {
			continue;
		}
		variables[variable.key] = variable.value ?? '';
	}

	return Object.keys(variables).length ? variables : undefined;
};

export const requestList = async (
	executeFunctions: IExecuteFunctions,
	url: string,
	listOptions: ListOptions,
	apiKey: string,
	itemIndex: number,
	returnAll: boolean,
	limit?: number,
) => {
	if (listOptions.after && listOptions.before) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'You can only use either "After" or "Before", not both.',
			{ itemIndex },
		);
	}

	const targetLimit = returnAll ? 1000 : (limit ?? 50);
	const pageSize = Math.min(targetLimit, 100); // Resend API max is 100
	const qs: Record<string, string | number> = { limit: pageSize };

	if (listOptions.after) {
		qs.after = listOptions.after;
	}
	if (listOptions.before) {
		qs.before = listOptions.before;
	}

	const requestPage = () =>
		executeFunctions.helpers.httpRequest({
			url,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	const allItems: unknown[] = [];
	let lastResponse: unknown;
	let hasMore = true;
	let isFirstRequest = true;
	let paginationMode: 'after' | 'before' | undefined = listOptions.before ? 'before' : undefined;

	while (hasMore) {
		// Rate limiting: wait 1 second between requests (Resend allows 2 req/sec)
		if (!isFirstRequest) {
			await sleep(1000);
		}
		isFirstRequest = false;

		lastResponse = await requestPage();
		const responseData = Array.isArray((lastResponse as { data?: unknown[] }).data)
			? ((lastResponse as { data?: unknown[] }).data as unknown[])
			: [];
		allItems.push(...responseData);

		// Stop if we have enough items
		if (allItems.length >= targetLimit) {
			break;
		}

		hasMore = Boolean((lastResponse as { has_more?: boolean }).has_more);
		if (!hasMore || responseData.length === 0) {
			break;
		}

		const lastItem = responseData[responseData.length - 1] as { id?: string } | undefined;
		if (!lastItem?.id) {
			break;
		}

		if (paginationMode === 'before') {
			qs.before = lastItem.id;
			delete qs.after;
		} else {
			qs.after = lastItem.id;
			delete qs.before;
			paginationMode = 'after';
		}
	}

	// Slice to exact limit
	const finalData = allItems.slice(0, targetLimit);

	if (lastResponse && Array.isArray((lastResponse as { data?: unknown[] }).data)) {
		(lastResponse as { data: unknown[] }).data = finalData;
		(lastResponse as { has_more?: boolean }).has_more = false;
		return lastResponse;
	}

	return { object: 'list', data: finalData, has_more: false };
};

export async function getTemplateVariables(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const getStringValue = (value: unknown) =>
		typeof value === 'string' && value.trim() ? value : undefined;
	const safeGet = (getter: () => unknown) => {
		try {
			return getter();
		} catch {
			return undefined;
		}
	};
	const getParameterValue = (name: string) => {
		const currentParameters = this.getCurrentNodeParameters();
		const fromCurrentParameters = getStringValue(currentParameters?.[name]);
		if (fromCurrentParameters) {
			return fromCurrentParameters;
		}

		const fromCurrentNodeParameter = getStringValue(
			safeGet(() => this.getCurrentNodeParameter(name)),
		);
		if (fromCurrentNodeParameter) {
			return fromCurrentNodeParameter;
		}

		const fromNodeParameter = getStringValue(safeGet(() => this.getNodeParameter(name, '')));
		if (fromNodeParameter) {
			return fromNodeParameter;
		}

		return undefined;
	};

	const templateId = getParameterValue('emailTemplateId') ?? getParameterValue('templateId');
	if (!templateId) {
		return [];
	}
	const normalizedTemplateId = templateId.trim();
	if (normalizedTemplateId.startsWith('={{') || normalizedTemplateId.includes('{{')) {
		return [];
	}

	const credentials = await this.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;

	const response = await this.helpers.httpRequest({
		url: `https://api.resend.com/templates/${encodeURIComponent(templateId)}`,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		json: true,
	});

	const variables = response?.variables ?? [];

	return variables
		.filter((variable: { key?: string }) => variable?.key)
		.map((variable: { key: string; type?: string }) => {
			const typeLabel = variable.type ? ` (${variable.type})` : '';
			return {
				name: `${variable.key}${typeLabel}`,
				value: variable.key,
			};
		});
}

export async function getTemplates(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return loadDropdownOptions(this, '/templates');
}

export async function getSegments(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return loadDropdownOptions(this, '/segments');
}

export async function getTopics(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return loadDropdownOptions(this, '/topics');
}
