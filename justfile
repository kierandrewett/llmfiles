set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

repo := justfile_directory()

default:
    @just --list

# Run the standalone OpenCode messaging bridge app.
opencode-bridge *args:
    @yarn --cwd "{{repo}}/apps/opencode-messaging-bridge" start {{args}}

# Typecheck and test the standalone OpenCode messaging bridge app.
opencode-bridge-check:
	@yarn --cwd "{{repo}}/apps/opencode-messaging-bridge" check

# Typecheck and smoke-test OpenCode plugins.
opencode-plugin-check:
	@yarn --cwd "{{repo}}/apps/opencode-messaging-bridge" exec tsc --noEmit -p "{{repo}}/tests/opencode/tsconfig.json"
	@yarn --cwd "{{repo}}/apps/opencode-messaging-bridge" exec tsx "{{repo}}/tests/opencode/discord-remote-control-smoke.ts"

# Build a Docker-safe OpenCode config directory with symlinks resolved.
opencode-bridge-config target="" source="":
	@target="{{target}}"; source="{{source}}"; \
		target="${target:-$HOME/.config/opencode-messaging-bridge/opencode-config}"; \
		source="${source:-$HOME/.config/opencode}"; \
		if [ ! -d "$source" ]; then \
			printf '[llmfiles] missing OpenCode config source %s\n' "$source"; \
			exit 1; \
		fi; \
		source="$(realpath -m "$source")"; \
		target="$(realpath -m "$target")"; \
		case "$target" in ""|"/"|"$HOME"|"$source"|"$source"/*) \
			printf '[llmfiles] refusing unsafe target %s\n' "$target"; \
			exit 1; \
			;; \
		esac; \
		parent="$(dirname "$target")"; \
		mkdir -p "$parent"; \
		tmp="$(mktemp -d "$parent/.opencode-config.XXXXXX")"; \
		cp -aL "$source"/. "$tmp"/; \
		rm -rf "$target"; \
		mv "$tmp" "$target"; \
		printf '[llmfiles] wrote resolved OpenCode config to %s\n' "$target"

# Link a source path to a destination. Existing real files are skipped.
_link src dst:
    @src="{{src}}"; dst="{{dst}}"; \
        if [ ! -e "$src" ]; then \
            printf '[llmfiles] missing source %s\n' "$src"; \
            exit 1; \
        fi; \
        mkdir -p "$(dirname "$dst")"; \
        if [ -L "$dst" ]; then \
            ln -sfn "$src" "$dst"; \
            printf '[llmfiles] relinked %s -> %s\n' "$dst" "$src"; \
        elif [ -e "$dst" ]; then \
            printf '[llmfiles] skipped %s (exists and is not a symlink)\n' "$dst"; \
        else \
            ln -s "$src" "$dst"; \
            printf '[llmfiles] linked %s -> %s\n' "$dst" "$src"; \
        fi

# Install the base OpenCode profile. Does not install plugins or skills.
install-opencode target="":
    @target="{{target}}"; target="${target:-$HOME/.config/opencode}"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/agents" "$target/agents"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/command" "$target/command"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/get-shit-done" "$target/get-shit-done"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/hooks" "$target/hooks"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/opencode.json" "$target/opencode.json"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/settings.json" "$target/settings.json"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/package.json" "$target/package.json"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/package-lock.json" "$target/package-lock.json"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/profiles/opencode/bun.lock" "$target/bun.lock"

# Opt in to OpenCode plugins.
install-opencode-plugins target="":
	@target="{{target}}"; target="${target:-$HOME/.config/opencode}"; \
		plugin_target="$target/plugins"; \
		if [ -d "$plugin_target" ] && [ ! -L "$plugin_target" ]; then \
			for src in "{{repo}}"/plugins/opencode/*; do \
				[ -e "$src" ] || continue; \
				just --justfile "{{repo}}/justfile" _link "$src" "$plugin_target/$(basename "$src")"; \
			done; \
		else \
			just --justfile "{{repo}}/justfile" _link "{{repo}}/plugins/opencode" "$plugin_target"; \
		fi

# Opt in to the vendored skill collections for OpenCode.
install-opencode-skills target="":
    @target="{{target}}"; target="${target:-$HOME/.config/opencode/skills}"; \
        for src in "{{repo}}"/skills/collections/*; do \
            [ -e "$src" ] || continue; \
            just --justfile "{{repo}}/justfile" _link "$src" "$target/$(basename "$src")"; \
        done

# Install all OpenCode links, including optional plugins and skill collections.
install-opencode-all target="":
    @target="{{target}}"; target="${target:-$HOME/.config/opencode}"; \
        just --justfile "{{repo}}/justfile" install-opencode "$target"; \
        just --justfile "{{repo}}/justfile" install-opencode-plugins "$target"; \
        just --justfile "{{repo}}/justfile" install-opencode-skills "$target/skills"

# Install generic ~/.agents skills.
install-agents-skills target="":
    @target="{{target}}"; target="${target:-$HOME/.agents/skills}"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/skills/local/find-skills" "$target/find-skills"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/skills/collections/vercel--agent-skills/skills/web-design-guidelines" "$target/web-design-guidelines"

# Install Claude-only local skills.
install-claude-skills target="":
    @target="{{target}}"; target="${target:-$HOME/.claude/skills}"; \
        just --justfile "{{repo}}/justfile" _link "{{repo}}/skills/local/ntfy" "$target/ntfy"

# Install one named local skill into any skill folder.
install-local-skill name target:
    @just --justfile "{{repo}}/justfile" _link "{{repo}}/skills/local/{{name}}" "{{target}}/{{name}}"
