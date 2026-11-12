package executor

import (
	"encoding/json"
	"errors"
)

type desktopSelection struct {
	Model           string          `json:"model"`
	ReasoningEffort json.RawMessage `json:"reasoning_effort"`
	Reasoning       struct {
		Effort string `json:"effort"`
	} `json:"reasoning"`
}

// Check the exact approved selection after all proxy transformations.
func validateDesktopModelPolicy(request, finalized []byte) error {
	var expected desktopSelection
	var actual struct {
		desktopSelection
		Input []struct {
			desktopSelection
			Type string `json:"type"`
		} `json:"input"`
	}
	if json.Unmarshal(request, &expected) != nil || json.Unmarshal(finalized, &actual) != nil {
		return errors.New("desktop_policy_payload_invalid")
	}
	if !desktopModelCatalog[expected.Model][expected.Reasoning.Effort] {
		return errors.New("desktop_policy_selection_not_allowed")
	}
	if actual.Model != expected.Model || actual.Reasoning.Effort != expected.Reasoning.Effort || actual.ReasoningEffort != nil {
		return errors.New("desktop_policy_selection_changed")
	}
	for _, item := range actual.Input {
		if item.Type == "configuration_update" && (item.Model != "" && item.Model != expected.Model ||
			item.Reasoning.Effort != "" && item.Reasoning.Effort != expected.Reasoning.Effort || item.ReasoningEffort != nil) {
			return errors.New("desktop_policy_update_changed")
		}
	}
	return nil
}
