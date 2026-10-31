package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	backticked = regexp.MustCompile("`([^`\n]+)`")
	qualified  = regexp.MustCompile(`^[a-z0-9]+\.[A-Z]\w*$`)
)

// TestDocNames fails when a name in backticks in CLAUDE.md, .claude/rules or ARCHITECTURE.md no longer appears
// in the repo.
// It checks names only, not whether a rule is still true; names under 4 characters would always match, so they're skipped.
func TestDocNames(t *testing.T) {
	root := ".."
	files, err := exec.Command("git", "-C", root, "ls-files", "-co", "--exclude-standard").Output()
	if err != nil {
		t.Fatal(err)
	}
	code, err := exec.Command("git", "-C", root, "grep", "--untracked", "-hI", "", "--", ".", ":!*.md").Output()
	if err != nil {
		t.Fatal(err)
	}
	corpus := string(files) + string(code)
	docs, _ := filepath.Glob(filepath.Join(root, ".claude/rules/*.md"))
	for _, doc := range append(docs, filepath.Join(root, "CLAUDE.md"), filepath.Join(root, "ARCHITECTURE.md")) {
		text, err := os.ReadFile(doc)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range backticked.FindAllStringSubmatch(string(text), -1) {
			name := strings.TrimSuffix(m[1], "()")
			if len(name) < 4 || strings.ContainsAny(name, " <…*{") {
				continue // too short to mean anything, or an example or a glob
			}
			if strings.Contains(corpus, name) {
				continue
			}
			// core.Session is written Session inside package core.
			if qualified.MatchString(name) && strings.Contains(corpus, name[strings.Index(name, ".")+1:]) {
				continue
			}
			t.Errorf("%s: `%s` no longer appears in the repo", filepath.Base(doc), m[1])
		}
	}
}
