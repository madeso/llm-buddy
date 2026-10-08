export type Severity = 'trivial' | 'significant' | 'critical';

export type NoteStatus = 'active' | 'dismissed';

export interface ReviewNote {
	id: number;
	scopeKey: string;
	uri: string;
	line: number;
	message: string;
	severity: Severity;
	status: NoteStatus;
	createdAt: number;
	editedAt?: number;
	dismissedAt?: number;
	dismissedReason?: string;
}

export interface NoteToolEvent {
	tool: 'add_note' | 'update_note' | 'remove_note';
	noteId: number;
	scopeKey: string;
	uri: string;
	line?: number;
	message?: string;
}

export interface ReviewCapture {
	scopeKey: string;
	provider: string;
	startedAt: number;
	finishedAt?: number;
	diff: string;
	responses: ChatMessage[];
	toolEvents: NoteToolEvent[];
	files: Array<{ uri: string; file: string; language: string }>;
	notes: Array<{
		id: number;
		uri: string;
		line: number;
		message: string;
		severity: Severity;
	}>;
	judgment?: { kind: 'clean' | 'warnings'; warnings?: string };
}

export interface ChangeChunk {
	uri: string;
	scopeKey: string;
	fileName: string;
	languageId: string;
	startOffset: number;
	originalText: string;
	currentText: string;
	revision: number;
	startedAt: number;
	lastChangedAt: number;
}

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ProviderResponse {
	message: ChatMessage;
}

export interface LlmProvider {
	complete(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		signal?: AbortSignal,
	): Promise<ProviderResponse>;
}
