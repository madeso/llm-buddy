import * as vscode from 'vscode';
import { Severity } from './types';

export type SettingsKey
	= 'coalesceWindow'
	| 'enabled'
	| 'autoInterval'
	| 'autoIdleDelay'
	| 'captureQualityData'
	| 'provider'
	| 'maxIterations'
	| 'detectMinimum'
	| 'fixUnreported'
	| 'fixIdleDelay'
	| 'openAI.baseUrl'
	| 'openAI.model'
	;

export type AiProvider = 'openai-compatible' | 'vscode-language-model';
export const AllAiProviders: AiProvider[] = ['openai-compatible', 'vscode-language-model'];

export const AiProvider_from_string = (s: string): AiProvider | null => {
	const x = (x: string) => x.toLowerCase().trim();
	const found = AllAiProviders.find(prov => x(prov) === x(s));
	return found ?? null;
};

export const get_ai_provider_setting = () : [AiProvider | null, string] => {
	const string = get_setting_or('provider', 'openai-compatible');
	const provider = AiProvider_from_string(string);
	return [provider, string];
};

const config = () => vscode.workspace.getConfiguration('llmBuddy');

export const get_setting_or = <T>(name: SettingsKey, fallback: T): T => {
	return config().get<T>(name, fallback);
};

export const set_setting_globally = async <T>(name: SettingsKey, value: T): Promise<void> => {
	await config().update(name, value, vscode.ConfigurationTarget.Global);
};

export const save_setting = async <T>(name: SettingsKey, value: T): Promise<void> => {
	if(get_setting_or(name, value) === value)
	{
		return;
	}
	await set_setting_globally(name, value);
};

export const rank_from_severity = (severity: Severity): number => {
	switch (severity) {
		case 'trivial':
			return 0;
		case 'significant':
			return 1;
		case 'critical':
			return 2;
	}
};

export const is_severity = (value: unknown): value is Severity => {
	return value === 'trivial' || value === 'significant' || value === 'critical';
};
