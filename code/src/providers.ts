import * as vscode from 'vscode';
import { ChatMessage, LlmProvider, ProviderResponse, ToolDefinition, ToolCall, ModelResponse } from './types';
import { get_setting_or } from './settings';

interface ProviderConfiguration {
	provider: string;
	baseUrl: string;
	model: string;
}

interface OpenAiResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: Array<{
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
	error?: { message?: string };
}

export const apiKeySecretKey = 'llmBuddy.openAI.apiKey';

function getProviderConfiguration(): ProviderConfiguration {
	const provider = get_setting_or<string>('provider', 'openai-compatible');
	const baseUrl = get_setting_or<string>('openAI.baseUrl', 'http://localhost:1337/v1');
	const model = get_setting_or<string>('openAI.model', 'local-model');
	return {
		provider,
		baseUrl,
		model,
	};
}

export class OpenAiCompatibleProvider implements LlmProvider {
	constructor(
		private readonly baseUrl: string,
		private readonly model: string,
		private readonly apiKey?: string,
	) {}

	async complete(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		signal?: AbortSignal,
	): Promise<ProviderResponse> {
		const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`;
		}

		const response = await fetch(url, {
			method: 'POST',
			headers,
			signal,
			body: JSON.stringify({
				model: this.model,
				messages,
				tools,
				tool_choice: 'auto',
			}),
		});
		const body = await response.json() as OpenAiResponse;
		if (!response.ok) {
			throw new Error(body.error?.message ?? `LLM request failed (${response.status} ${response.statusText})`);
		}

		const rawMessage = body.choices?.[0]?.message;
		if (!rawMessage) {
			throw new Error('LLM provider returned no message.');
		}
		const toolCalls: ToolCall[] = (rawMessage.tool_calls ?? []).map((call) => {
			if (!call.id || call.type !== 'function' || !call.function?.name) {
				throw new Error('LLM provider returned an invalid tool call.');
			}
			return {
				id: call.id,
				type: 'function',
				function: {
					name: call.function.name,
					arguments: call.function.arguments ?? '{}',
				},
			};
		});
		return {
			message: {
				role: 'assistant',
				content: rawMessage.content ?? null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			},
		};
	}

	async models(
		signal?: AbortSignal,
	): Promise<ModelResponse> {
		const url = `${this.baseUrl.replace(/\/+$/, '')}/models`;
		const headers: Record<string, string> = { };
		if (this.apiKey) {
			headers.Authorization = `Bearer ${this.apiKey}`;
		}

		const response = await fetch(url, {
			method: 'GET',
			headers,
			signal,
		});
		const body = await response.json();

		if(typeof body !== 'object') { throw new Error("Missing body in response"); }
		if(body === null) { throw new Error("body is null"); }

		const data = 'data' in body ? body.data : undefined;
		if(Array.isArray(data) === false) { throw new Error("data is not an array"); }

		const ret = data.map( (x: unknown) => {
			if(typeof x !== 'object') { return null; }
			if(x === null) { return null; }
			
			const id = 'id' in x ? x.id : undefined;
			if(typeof id !== 'string') { return null; }

			return {id};
		});
		
		return ret.filter(x => x !== null) ;
	}
}

export class VsCodeLanguageModelProvider implements LlmProvider {
	async complete(
		_messages: ChatMessage[],
		_tools: ToolDefinition[],
		_signal?: AbortSignal,
	): Promise<ProviderResponse> {
		throw new Error('VS Code Language Model provider is not implemented yet.');
	}

	async models(
		_signal?: AbortSignal,
	): Promise<ModelResponse> {
		throw new Error('VS Code Language Model provider is not implemented yet.');
	}
}

export async function createProvider(context: vscode.ExtensionContext): Promise<LlmProvider> {
	const settings = getProviderConfiguration();
	switch (settings.provider) {
		case 'openai-compatible':
			return new OpenAiCompatibleProvider(
				settings.baseUrl,
				settings.model,
				await context.secrets.get(apiKeySecretKey),
			);
		case 'vscode-language-model':
			return new VsCodeLanguageModelProvider();
		default:
			throw new Error(`Unknown llmBuddy.provider value: ${settings.provider}`);
	}
}
