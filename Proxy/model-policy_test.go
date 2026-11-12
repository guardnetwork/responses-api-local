package executor

import (
	"regexp"
	"strconv"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

func TestDesktopModelPolicy(t *testing.T) {
	approved := []byte(`{"model":"gpt-6.1-sol","reasoning":{"effort":"high"},"input":[]}`)
	if err := validateDesktopModelPolicy(approved, approved); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		`{"model":"gpt-6.1-sol","reasoning":{"effort":"low"}}`,
		`{"model":"gpt-6-astra","reasoning":{"effort":"high"}}`,
		`{"model":"gpt-6.1-sol","reasoning":{"effort":"high"},"reasoning_effort":"low"}`,
		`{"model":"gpt-6.1-sol","reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`,
	} {
		if validateDesktopModelPolicy(approved, []byte(payload)) == nil {
			t.Fatal("changed selection was accepted")
		}
	}
}

func TestDesktopCatalogRegistry(t *testing.T) {
	generation := regexp.MustCompile(`^gpt-([1-9][0-9]*)(\.[0-9]+)?(-[a-z0-9]+)*$`)
	seen := make(map[string]bool)
	for _, models := range [][]*registry.ModelInfo{
		registry.GetCodexFreeModels(), registry.GetCodexTeamModels(),
		registry.GetCodexPlusModels(), registry.GetCodexProModels(),
	} {
		for _, model := range models {
			match := generation.FindStringSubmatch(model.ID)
			if match == nil {
				continue
			}
			major, err := strconv.Atoi(match[1])
			if err != nil || major < 6 {
				continue
			}
			seen[model.ID] = true
			expected := desktopModelCatalog[model.ID]
			if model.Thinking == nil || len(model.Thinking.Levels) != len(expected) {
				t.Fatalf("catalog effort count differs for %s", model.ID)
			}
			for _, effort := range model.Thinking.Levels {
				if !expected[effort] {
					t.Fatalf("catalog effort differs for %s / %s", model.ID, effort)
				}
			}
		}
	}
	if len(seen) != len(desktopModelCatalog) {
		t.Fatalf("catalog model count differs: registry %d, policy %d", len(seen), len(desktopModelCatalog))
	}
}
