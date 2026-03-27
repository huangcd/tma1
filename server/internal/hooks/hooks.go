// Package hooks installs the TMA1 hook script for Claude Code / Codex integration.
package hooks

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// EnsureHookScript writes the TMA1 hook script to <dataDir>/hooks/tma1-hook.sh.
// It is idempotent — the file is only rewritten if the content differs.
// Returns the absolute path to the script.
func EnsureHookScript(dataDir string, port int, logger *slog.Logger) (string, error) {
	dir := filepath.Join(dataDir, "hooks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create hooks dir: %w", err)
	}

	scriptPath := filepath.Join(dir, "tma1-hook.sh")

	// Embed the configured port into the script.
	content := fmt.Sprintf(`#!/bin/bash
# TMA1 hook — forward Claude Code / Codex events to tma1-server.
# Reads JSON from stdin, POSTs to localhost. Exits silently on failure.
curl -s -m 2 -X POST -H 'Content-Type: application/json' \
  -d @- "http://127.0.0.1:%d/api/hooks" </dev/stdin >/dev/null 2>&1 || true
`, port)

	// Check if existing script matches.
	existing, err := os.ReadFile(scriptPath)
	if err == nil && string(existing) == content {
		return scriptPath, nil
	}

	if err := os.WriteFile(scriptPath, []byte(content), 0o755); err != nil {
		return "", fmt.Errorf("write hook script: %w", err)
	}

	logger.Info("hook script installed", "path", scriptPath)
	return scriptPath, nil
}
