import * as assert from 'assert';
import { OpenAiCompatibleProvider } from '../providers';
import { ChatMessage, ToolDefinition } from '../types';

suite('OpenAI-compatible provider', () => {
	test('sends tool-enabled chat requests to the configured endpoint', async () => {
		const originalFetch = globalThis.fetch;
		let requestedUrl = '';
		let requestedInit: RequestInit | undefined;
		globalThis.fetch = async (input, init) => {
			requestedUrl = String(input);
			requestedInit = init;
			return new Response(JSON.stringify({
				choices: [{
					message: {
						content: null,
						tool_calls: [{
							id: 'call-1',
							type: 'function',
							function: { name: 'end', arguments: '{}' },
						}],
					},
				}],
			}), { status: 200, headers: { 'Content-Type': 'application/json' } });
		};

		try {
			const provider = new OpenAiCompatibleProvider('http://localhost:1234/v1/', 'test-model', 'secret');
			const messages: ChatMessage[] = [{ role: 'user', content: 'Review this change.' }];
			const tools: ToolDefinition[] = [{
				type: 'function',
				function: {
					name: 'end',
					description: 'Finish review.',
					parameters: { type: 'object' },
				},
			}];
			const response = await provider.complete(messages, tools);
			assert.strictEqual(requestedUrl, 'http://localhost:1234/v1/chat/completions');
			assert.match(new Headers(requestedInit?.headers).get('Authorization') ?? '', /Bearer secret/);
			assert.deepStrictEqual(response.message.tool_calls?.[0].function, { name: 'end', arguments: '{}' });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('surfaces error messages returned by the server', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({
			error: { message: 'model unavailable' },
		}), { status: 503, statusText: 'Service Unavailable' });
		try {
			const provider = new OpenAiCompatibleProvider('http://localhost:1234/v1', 'test-model');
			await assert.rejects(provider.complete([{ role: 'user', content: 'test' }], []), /model unavailable/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
