# Antigravity Extensions

Extensions installed on this machine (taken from `~/.antigravity/extensions` and `~/.antigravity-ide/extensions`), 30 in total.

## Install all at once

Open a PowerShell terminal (inside Antigravity works best, since the `antigravity` command is on its PATH there) and run:

```powershell
$extensions = @(
  # AI assistants
  "anthropic.claude-code"
  "saoudrizwan.claude-dev"
  "openai.chatgpt"
  "google.gemini-cli-vscode-ide-companion"
  "sst-dev.opencode"
  "coderabbit.coderabbit-vscode"
  "jlcodes.antigravity-cockpit"

  # Web / Angular
  "angular.ng-template"
  "bradlc.vscode-tailwindcss"
  "esbenp.prettier-vscode"
  "formulahendry.auto-close-tag"
  "formulahendry.auto-rename-tag"
  "christian-kohler.path-intellisense"

  # Languages
  "ms-python.python"
  "ms-python.debugpy"
  "ms-python.vscode-python-envs"
  "meta.pyrefly"
  "golang.go"
  "llvm-vs-code-extensions.vscode-clangd"
  "shopify.ruby-lsp"

  # Database / API
  "mtxr.sqltools"
  "postman.postman-for-vscode"

  # Git / code quality
  "eamodio.gitlens"
  "streetsidesoftware.code-spell-checker"
  "aaron-bond.better-comments"

  # Themes / icons
  "github.github-vscode-theme"
  "akamud.vscode-theme-onedark"
  "pkief.material-icon-theme"
  "vscode-icons-team.vscode-icons"
  "eddieposey.vscode-icons-mac"
)

foreach ($ext in $extensions) {
  antigravity --install-extension $ext --force
}
```

If `antigravity` is not recognised, open Antigravity and run **Command Palette → "Shell Command: Install 'antigravity' command in PATH"**, or call the CLI by its full path, e.g.
`& "$env:LOCALAPPDATA\Programs\Antigravity\bin\antigravity.cmd" --install-extension <id>`.

> Some extensions may not be on Open VSX (the marketplace Antigravity uses). If one fails, download its `.vsix` from the VS Code Marketplace and install with `antigravity --install-extension path\to\file.vsix`.

## Extension list

| # | Extension ID | Name / purpose | Version |
|---|---|---|---|
| **AI assistants** ||||
| 1 | `anthropic.claude-code` | Claude Code | 2.1.284 |
| 2 | `saoudrizwan.claude-dev` | Cline | 3.84.0 |
| 3 | `openai.chatgpt` | ChatGPT / Codex | 26.721.30844 |
| 4 | `google.gemini-cli-vscode-ide-companion` | Gemini CLI Companion | 0.20.0 |
| 5 | `sst-dev.opencode` | opencode | 0.0.13 |
| 6 | `coderabbit.coderabbit-vscode` | CodeRabbit AI review | 0.19.2 |
| 7 | `jlcodes.antigravity-cockpit` | Antigravity Cockpit | 2.1.52 |
| **Web / Angular** ||||
| 8 | `angular.ng-template` | Angular Language Service | 21.2.3 |
| 9 | `bradlc.vscode-tailwindcss` | Tailwind CSS IntelliSense | 0.14.28 |
| 10 | `esbenp.prettier-vscode` | Prettier formatter | 12.4.0 |
| 11 | `formulahendry.auto-close-tag` | Auto Close Tag | 0.5.15 |
| 12 | `formulahendry.auto-rename-tag` | Auto Rename Tag | 0.1.10 |
| 13 | `christian-kohler.path-intellisense` | Path Intellisense | 2.8.0 |
| **Languages** ||||
| 14 | `ms-python.python` | Python | 2026.4.0 |
| 15 | `ms-python.debugpy` | Python Debugger | 2026.6.0 |
| 16 | `ms-python.vscode-python-envs` | Python Environments | 1.20.1 |
| 17 | `meta.pyrefly` | Pyrefly (Python type checker) | 1.0.0 |
| 18 | `golang.go` | Go | 0.52.2 |
| 19 | `llvm-vs-code-extensions.vscode-clangd` | clangd (C/C++) | 0.4.0 |
| 20 | `shopify.ruby-lsp` | Ruby LSP | 0.10.3 |
| **Database / API** ||||
| 21 | `mtxr.sqltools` | SQLTools | 0.28.5 |
| 22 | `postman.postman-for-vscode` | Postman | 1.19.1 |
| **Git / code quality** ||||
| 23 | `eamodio.gitlens` | GitLens | 19.2.0 |
| 24 | `streetsidesoftware.code-spell-checker` | Code Spell Checker | 4.9.3 |
| 25 | `aaron-bond.better-comments` | Better Comments | 3.0.2 |
| **Themes / icons** ||||
| 26 | `github.github-vscode-theme` | GitHub Theme | 6.3.5 |
| 27 | `akamud.vscode-theme-onedark` | Atom One Dark Theme | 2.3.0 |
| 28 | `pkief.material-icon-theme` | Material Icon Theme | 5.38.1 |
| 29 | `vscode-icons-team.vscode-icons` | vscode-icons | 12.18.0 |
| 30 | `eddieposey.vscode-icons-mac` | macOS Modern icons | 7.25.3 |

Versions are the newest found on this machine. The install script always pulls the latest version; to pin one, use `antigravity --install-extension <id>@<version>`.
