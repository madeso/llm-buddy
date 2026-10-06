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
	;

export function getSetting<T>(name: SettingsKey, fallback: T): T {
	return vscode.workspace.getConfiguration('llmBuddy').get<T>(name, fallback);
}

export function severityRank(severity: Severity): number {
	switch (severity) {
		case 'trivial':
			return 0;
		case 'significant':
			return 1;
		case 'critical':
			return 2;
	}
}

export function isSeverity(value: unknown): value is Severity {
	return value === 'trivial' || value === 'significant' || value === 'critical';
}
