{
	"folders": [
		{ "name": "__BACKEND__", "path": "./apps/__BACKEND__" },
		{ "name": "__STORE__", "path": "./apps/__STORE__" },
		{ "name": "__PROJECT__", "path": "." }
	],
	"settings": {
		"files.eol": "\n",
		"files.trimTrailingWhitespace": true,
		"files.insertFinalNewline": true,
		"search.exclude": {
			"**/node_modules": true,
			"**/.medusa": true,
			"**/.next": true,
			"**/.turbo": true,
			"**/package-lock.json": true
		},
		"files.watcherExclude": {
			"**/node_modules/**": true,
			"**/.medusa/**": true,
			"**/.next/**": true,
			"**/.turbo/**": true
		},
		"typescript.tsdk": "node_modules/typescript/lib",
		"npm.packageManager": "npm"
	},
	"extensions": {
		"recommendations": ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode", "ms-azuretools.vscode-docker"]
	},
	"tasks": {
		"version": "2.0.0",
		"options": { "cwd": "${workspaceFolder:__PROJECT__}" },
		"tasks": [
			{ "label": "stack: start", "type": "shell", "command": "npm run lma start", "problemMatcher": [] },
			{ "label": "stack: stop", "type": "shell", "command": "npm run lma stop", "problemMatcher": [] },
			{ "label": "stack: status", "type": "shell", "command": "npm run lma status", "problemMatcher": [] },
			{ "label": "db: migrate", "type": "shell", "command": "npm run lma migrate", "problemMatcher": [] }
		]
	}
}
