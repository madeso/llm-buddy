import * as vscode from 'vscode';
import { ChatMessage, LlmProvider, ProviderResponse, ToolDefinition, ToolCall } from './types';

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
	const config = vscode.workspace.getConfiguration('llmBuddy');
	return {
		provider: config.get<string>('provider', 'openai-compatible'),
		baseUrl: config.get<string>('openAI.baseUrl', 'http://localhost:1234/v1'),
		model: config.get<string>('openAI.model', 'local-model'),
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
}

export class VsCodeLanguageModelProvider implements LlmProvider {
	async complete(
		_messages: ChatMessage[],
		_tools: ToolDefinition[],
		_signal?: AbortSignal,
	): Promise<ProviderResponse> {
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
