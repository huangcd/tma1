package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// LLMConfig holds the configuration for the LLM-as-judge feature.
type LLMConfig struct {
	APIKey   string
	Provider string // "anthropic" or "openai"
	Model    string // optional override
}

func (c LLMConfig) Available() bool {
	return c.APIKey != ""
}

func (c LLMConfig) resolvedModel() string {
	if c.Model != "" {
		return c.Model
	}
	if c.Provider == "openai" {
		return "gpt-4o-mini"
	}
	return "claude-sonnet-4-20250514"
}

// evalSemaphore limits concurrent LLM evaluation requests.
var evalSemaphore = make(chan struct{}, 3)

type evaluateRequest struct {
	Prompt  string          `json:"prompt"`
	Context evaluateContext `json:"context"`
}

type evaluateContext struct {
	Turns            int      `json:"turns"`
	ToolFailures     int      `json:"tool_failures"`
	TotalTokens      int      `json:"total_tokens"`
	ToolsUsed        []string `json:"tools_used"`
	ToolSummary      string   `json:"tool_summary"`
	ExplorationRatio float64  `json:"exploration_ratio"`
	Patterns         []string `json:"patterns"`
}

type pointDetail struct {
	Score   int      `json:"score"`
	Awarded []string `json:"awarded"`
}

type evaluateResponse struct {
	// V1 fields (kept for backward compat).
	Scores map[string]int `json:"scores,omitempty"`

	// V2 fields (point-based with reasoning).
	Reasoning string                  `json:"reasoning,omitempty"`
	Points    map[string]pointDetail  `json:"points,omitempty"`
	Total     int                     `json:"total,omitempty"`

	// Common fields.
	Suggestions []string `json:"suggestions"`
	Rewrite     string   `json:"rewrite"`
	Model       string   `json:"model"`
}

const evalSystemPrompt = `You are an expert prompt engineer evaluating prompts given to AI coding assistants (Claude Code, Codex, Cursor, etc.).

## Evaluation Process
1. First, briefly analyze the prompt and agent behavior
2. Award points for each criterion met
3. Provide specific suggestions and a rewrite

## Scoring Rubric (max 20 points)

### Specificity (0-5)
- Mentions specific file path(s): +2
- Mentions function/class/variable names: +1
- Includes error message or log output: +1
- References line numbers or code locations: +1

### Context (0-5)
- Includes relevant code snippet: +2
- Describes current behavior: +1
- Describes expected/desired behavior: +1
- Provides reproduction steps or test case: +1

### Clarity (0-5)
- Single, well-defined task (not multiple mixed requests): +2
- Clear success criteria (how to verify it's done): +2
- No ambiguous pronouns or vague references: +1

### Efficiency (0-5)
- Provides enough context to avoid agent exploration: +2
- Scoped appropriately (not too broad, not too narrow): +2
- Structured logically (context then problem then ask): +1

## Output
Respond with ONLY valid JSON:
{
  "reasoning": "<2-3 sentences analyzing prompt quality and agent behavior>",
  "points": {
    "specificity": {"score": <0-5>, "awarded": ["<what earned points>"]},
    "context": {"score": <0-5>, "awarded": ["<what earned points>"]},
    "clarity": {"score": <0-5>, "awarded": ["<what earned points>"]},
    "efficiency": {"score": <0-5>, "awarded": ["<what earned points>"]}
  },
  "total": <0-20>,
  "suggestions": ["<specific improvement 1>", "<specific improvement 2>"],
  "rewrite": "<improved version with placeholders like [file path] for missing info>"
}

Rules:
- awarded: list only points that WERE earned, not missing ones
- suggestions: max 3, specific to THIS prompt, under 120 chars each
- rewrite: same intent, better structure — often shorter, not longer
- If agent behavior shows exploration loops or retries, factor that into your assessment`

// handleEvaluate handles both the availability check and prompt evaluation.
func (s *Server) handleEvaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.handleEvaluateCheck(w)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	s.handleEvaluatePrompt(w, r)
}

func (s *Server) handleEvaluateCheck(w http.ResponseWriter) {
	llm := s.getLLMConfig()
	if !llm.Available() {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": true,
		"provider":  llm.Provider,
		"model":     llm.resolvedModel(),
	})
}

func (s *Server) handleEvaluatePrompt(w http.ResponseWriter, r *http.Request) {
	llm := s.getLLMConfig()
	if !llm.Available() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "LLM not configured. Set the API key in Settings or via TMA1_LLM_API_KEY env var."})
		return
	}

	var req evaluateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "prompt is required"})
		return
	}

	// Acquire semaphore (max 3 concurrent evals).
	select {
	case evalSemaphore <- struct{}{}:
		defer func() { <-evalSemaphore }()
	default:
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many concurrent evaluations, try again shortly"})
		return
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "Evaluate this prompt:\n\n---\n%s\n---\n\n", req.Prompt)
	sb.WriteString("Agent behavior after this prompt:\n")
	fmt.Fprintf(&sb, "- Turns: %d, Tool failures: %d, Total tokens: %d\n",
		req.Context.Turns, req.Context.ToolFailures, req.Context.TotalTokens)
	if len(req.Context.ToolsUsed) > 0 {
		fmt.Fprintf(&sb, "- Tools used: %s\n", strings.Join(req.Context.ToolsUsed, ", "))
	}
	if req.Context.ToolSummary != "" {
		fmt.Fprintf(&sb, "- Tool sequence: %s\n", req.Context.ToolSummary)
	}
	if req.Context.ExplorationRatio > 0 {
		fmt.Fprintf(&sb, "- Exploration ratio: %.0f%% of tool calls were search/read\n", req.Context.ExplorationRatio*100)
	}
	if len(req.Context.Patterns) > 0 {
		fmt.Fprintf(&sb, "- Detected patterns: %s\n", strings.Join(req.Context.Patterns, ", "))
	}
	userMsg := sb.String()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	model := llm.resolvedModel()
	var result evaluateResponse

	var err error
	if llm.Provider == "openai" {
		err = s.callOpenAI(ctx, llm, model, evalSystemPrompt, userMsg, &result)
	} else {
		err = s.callAnthropic(ctx, llm, model, evalSystemPrompt, userMsg, &result)
	}
	if err != nil {
		s.logger.Error("LLM evaluation failed", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LLM evaluation failed"})
		return
	}

	result.Model = model
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) callAnthropic(ctx context.Context, llm LLMConfig, model, sysPrompt, userMsg string, out any) error {
	body := map[string]any{
		"model":      model,
		"max_tokens": 1024,
		"system":     sysPrompt,
		"messages":   []map[string]string{{"role": "user", "content": userMsg}},
	}
	bodyBytes, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", llm.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("anthropic API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var anthropicResp struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(respBody, &anthropicResp); err != nil {
		return fmt.Errorf("failed to parse anthropic response: %w", err)
	}
	if len(anthropicResp.Content) == 0 {
		return fmt.Errorf("empty response from anthropic")
	}

	text := anthropicResp.Content[0].Text
	// Strip markdown code fences if present.
	text = stripCodeFences(text)

	if err := json.Unmarshal([]byte(text), out); err != nil {
		return fmt.Errorf("failed to parse LLM JSON output: %w\nraw: %s", err, text)
	}
	return nil
}

func (s *Server) callOpenAI(ctx context.Context, llm LLMConfig, model, sysPrompt, userMsg string, out any) error {
	body := map[string]any{
		"model":      model,
		"max_tokens": 1024,
		"messages": []map[string]string{
			{"role": "system", "content": sysPrompt},
			{"role": "user", "content": userMsg},
		},
	}
	bodyBytes, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+llm.APIKey)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("openai API returned %d: %s", resp.StatusCode, string(respBody))
	}

	var openaiResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &openaiResp); err != nil {
		return fmt.Errorf("failed to parse openai response: %w", err)
	}
	if len(openaiResp.Choices) == 0 {
		return fmt.Errorf("empty response from openai")
	}

	text := openaiResp.Choices[0].Message.Content
	text = stripCodeFences(text)

	if err := json.Unmarshal([]byte(text), out); err != nil {
		return fmt.Errorf("failed to parse LLM JSON output: %w\nraw: %s", err, text)
	}
	return nil
}

// --- Summary evaluation (sampled batch) ---

type summaryPrompt struct {
	Content    string `json:"content"`
	Score      int    `json:"score"`
	Turns      int    `json:"turns"`
	CostTokens int    `json:"cost_tokens"`
}

type summaryRequest struct {
	Prompts      []summaryPrompt `json:"prompts"`
	TotalPrompts int             `json:"total_prompts"`
	AvgScore     int             `json:"avg_score"`
}

type summaryPattern struct {
	Issue      string `json:"issue"`
	Frequency  string `json:"frequency"`
	Suggestion string `json:"suggestion"`
}

type summaryResponse struct {
	Summary  string           `json:"summary"`
	Patterns []summaryPattern `json:"patterns"`
	TopTip   string           `json:"top_tip"`
	Model    string           `json:"model"`
}

const evalSummarySystemPrompt = `You are an expert prompt engineer analyzing a stratified sample of prompts given to AI coding assistants. The sample is biased toward lower-scoring prompts to surface improvement opportunities.

Each prompt has a heuristic score (0-100), turn count (how many back-and-forth turns the session needed), and token cost.

Analyze the sample and respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "summary": "<2-3 sentence narrative about the overall prompt quality patterns you see>",
  "patterns": [
    {"issue": "<concise issue name>", "frequency": "high|medium|low", "suggestion": "<specific actionable advice>"}
  ],
  "top_tip": "<single most impactful improvement the user could make>"
}

Rules:
- Identify 3-5 recurring patterns across the prompts
- frequency: "high" = affects >50% of sample, "medium" = 20-50%, "low" = <20%
- Suggestions must be specific and actionable, not generic
- top_tip should be the single highest-leverage change
- Keep summary under 80 words
- Keep each suggestion under 100 characters`

func (s *Server) handleEvaluateSummary(w http.ResponseWriter, r *http.Request) {
	llm := s.getLLMConfig()
	if !llm.Available() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "LLM not configured. Set the API key in Settings or via TMA1_LLM_API_KEY env var."})
		return
	}

	var req summaryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if len(req.Prompts) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "prompts array is required"})
		return
	}

	// Acquire semaphore.
	select {
	case evalSemaphore <- struct{}{}:
		defer func() { <-evalSemaphore }()
	default:
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many concurrent evaluations, try again shortly"})
		return
	}

	// Build user message with truncated prompts.
	var sb strings.Builder
	fmt.Fprintf(&sb, "Analyze this stratified sample of %d prompts (from %d total, avg heuristic score: %d):\n\n",
		len(req.Prompts), req.TotalPrompts, req.AvgScore)
	for i, p := range req.Prompts {
		content := p.Content
		if len(content) > 200 {
			content = content[:200] + "..."
		}
		fmt.Fprintf(&sb, "--- Prompt %d (score: %d, turns: %d, tokens: %d) ---\n%s\n\n",
			i+1, p.Score, p.Turns, p.CostTokens, content)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	model := llm.resolvedModel()
	var result summaryResponse

	var err error
	if llm.Provider == "openai" {
		err = s.callOpenAI(ctx, llm, model, evalSummarySystemPrompt, sb.String(), &result)
	} else {
		err = s.callAnthropic(ctx, llm, model, evalSummarySystemPrompt, sb.String(), &result)
	}
	if err != nil {
		s.logger.Error("LLM summary evaluation failed", "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LLM evaluation failed"})
		return
	}

	result.Model = model
	writeJSON(w, http.StatusOK, result)
}

// stripCodeFences removes ```json ... ``` wrappers from LLM output.
func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		// Remove opening fence line.
		if idx := strings.Index(s, "\n"); idx != -1 {
			s = s[idx+1:]
		}
		// Remove closing fence.
		if idx := strings.LastIndex(s, "```"); idx != -1 {
			s = s[:idx]
		}
		s = strings.TrimSpace(s)
	}
	return s
}
