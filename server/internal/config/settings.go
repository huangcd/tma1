package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Settings holds user-configurable settings persisted to ~/.tma1/settings.json.
// Env vars take priority over file settings.
type Settings struct {
	LLMAPIKey   string `json:"llm_api_key"`
	LLMProvider string `json:"llm_provider"`
	LLMModel    string `json:"llm_model"`
	LogLevel    string `json:"log_level"`
	DataTTL     string `json:"data_ttl"`
}

// LoadSettings reads settings from dataDir/settings.json.
// Returns zero-value Settings if the file doesn't exist or is unreadable.
func LoadSettings(dataDir string) Settings {
	path := filepath.Join(dataDir, "settings.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return Settings{}
	}
	var s Settings
	_ = json.Unmarshal(data, &s)
	return s
}

// SaveSettings writes settings to dataDir/settings.json atomically.
// On Windows os.Rename fails if the destination exists, so we remove it first.
func SaveSettings(dataDir string, s Settings) error {
	path := filepath.Join(dataDir, "settings.json")
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	_ = os.Remove(path) // ignore error (file may not exist on first save)
	return os.Rename(tmp, path)
}

// EnvOverrides returns the list of setting keys that are locked by environment variables.
func EnvOverrides() []string {
	var overrides []string
	if os.Getenv("TMA1_LLM_API_KEY") != "" {
		overrides = append(overrides, "llm_api_key")
	}
	if os.Getenv("TMA1_LLM_PROVIDER") != "" {
		overrides = append(overrides, "llm_provider")
	}
	if os.Getenv("TMA1_LLM_MODEL") != "" {
		overrides = append(overrides, "llm_model")
	}
	if os.Getenv("TMA1_LOG_LEVEL") != "" {
		overrides = append(overrides, "log_level")
	}
	if os.Getenv("TMA1_DATA_TTL") != "" {
		overrides = append(overrides, "data_ttl")
	}
	return overrides
}

// ApplySettings merges file settings into a Config, respecting env var priority.
// Env vars always win; file settings fill in the gaps.
func ApplySettings(cfg *Config, s Settings) {
	if os.Getenv("TMA1_LLM_API_KEY") == "" && s.LLMAPIKey != "" {
		cfg.LLMAPIKey = s.LLMAPIKey
	}
	if os.Getenv("TMA1_LLM_PROVIDER") == "" && s.LLMProvider != "" {
		cfg.LLMProvider = s.LLMProvider
	}
	if os.Getenv("TMA1_LLM_MODEL") == "" && s.LLMModel != "" {
		cfg.LLMModel = s.LLMModel
	}
	if os.Getenv("TMA1_LOG_LEVEL") == "" && s.LogLevel != "" {
		cfg.LogLevel = s.LogLevel
	}
	if os.Getenv("TMA1_DATA_TTL") == "" && s.DataTTL != "" {
		cfg.DataTTL = s.DataTTL
	}
}
