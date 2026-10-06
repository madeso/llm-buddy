export interface ExpectedFinding {
	line: number;
	pattern: RegExp;
}

export interface BenchmarkCase {
	name: string;
	language: string;
	content: string;
	expected: ExpectedFinding[];
}

export const benchmarkCases: BenchmarkCase[] = [
	{
		name: 'Python: misspelled return keyword',
		language: 'python',
		content: 'def calculate_total(items):\n    total = 0\n    for item in items:\n        total += item.price\n    retrun total  # typo: should be return\n',
		expected: [{ line: 5, pattern: /retrun|return|typo/i }],
	},
	{
		name: 'Python: off-by-one range',
		language: 'python',
		content: 'def first_n_primes(n):\n    primes = []\n    for i in range(1, n):\n        if is_prime(i):\n            primes.append(i)\n    return primes  # range(1,n) gives n-1 numbers, not n\n',
		expected: [{ line: 3, pattern: /range|off.by.one|n.?1/i }],
	},
	{
		name: 'Emacs Lisp: missing progn',
		language: 'emacs-lisp',
		content: '(defun bad-func (x)\n  (if (> x 0)\n      (message "positive")\n      (setq x (* x -1)))  ; second form always runs!\n  x)\n',
		expected: [{ line: 3, pattern: /progn|multiple|second|always/i }],
	},
	{
		name: 'Emacs Lisp: unbound variable',
		language: 'emacs-lisp',
		content: '(defun bad-counter ()\n  (setq my-counter (1+ my-counter))  ; my-counter never defined\n  my-counter)\n',
		expected: [{ line: 2, pattern: /unbound|undefined|defvar|not defined|void/i }],
	},
	{
		name: 'Markdown: spelling errors',
		language: 'markdown',
		content: '# Project Overview\n\nThis project aims to impliment a new feature for the system.\nThe main benifit is improved performance.\n\n## Getting Started\n\nClone the repo and run `make install`.\n',
		expected: [
			{ line: 3, pattern: /impliment|implement/i },
			{ line: 4, pattern: /benifit|benefit/i },
		],
	},
	{
		name: 'JavaScript: loose equality',
		language: 'javascript',
		content: 'function isReady(state) {\n    if (state == null) {  // should use ===\n        return false;\n    }\n    return true;\n}\n',
		expected: [{ line: 2, pattern: /===?|strict|equality/i }],
	},
	{
		name: 'Shell: unquoted variable',
		language: 'shellscript',
		content: '#!/bin/bash\nfile=$1\nif [ -f $file ]; then  # should be "$file"\n    cat $file | grep error\nfi\n',
		expected: [{ line: 3, pattern: /quot|\$file|\$1/i }],
	},
	{
		name: 'Org: duplicate heading',
		language: 'org',
		content: '* Tasks\n** TODO Buy groceries\n** TODO Call dentist\n** TODO Buy groceries  ; duplicate task\n** DONE Review PR\n',
		expected: [{ line: 4, pattern: /duplicate|repeat|same/i }],
	},
	{
		name: 'C: unchecked strcpy',
		language: 'c',
		content: '#include <string.h>\nvoid copy_name(char *dest, const char *src) {\n    strcpy(dest, src);  // unsafe, no bounds check\n}\n',
		expected: [{ line: 3, pattern: /strcpy|strncpy|buffer|bound|unsafe|overflow/i }],
	},
	{
		name: 'Go: ignored error return',
		language: 'go',
		content: 'package main\nimport "os"\nfunc readConfig() string {\n    data, _ := os.ReadFile("config.json")  // error ignored with _\n    return string(data)\n}\n',
		expected: [{ line: 4, pattern: /error|ignor|check|_/i }],
	},
];
