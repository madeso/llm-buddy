import * as vscode from 'vscode';
import { Severity } from './types';

export function getSetting<T>(name: string, fallback: T): T {
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
